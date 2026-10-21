#!/usr/bin/env node
'use strict';

// Real application handlers + real-time PCM, with simulated devices/IPC/DOM.
// No API call without --live. User settings and knowledge are never written.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { LocalStt } = require('../src/main/localStt');
const sessionLogger = require('../src/main/sessionLogger');
const QuestionDetection = require('../src/renderer/question-detection');
const { readProjectFolder } = require('../src/main/projectFolder');
// Require outside the Electron VM: this store stays strictly in memory.
const store = require('../src/main/store');
const { PROVIDERS } = require('../src/main/config');

const ROOT = path.resolve(__dirname, '..');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const round = (value) => (Number.isFinite(value) ? Math.round(value) : null);
const difference = (end, start) =>
  Number.isFinite(end) && Number.isFinite(start) ? round(end - start) : null;

function loadModule(relative, overrides, globals = {}) {
  const filename = path.join(ROOT, relative);
  const nativeRequire = createRequire(filename);
  const sandbox = vm.createContext({
    module: { exports: {} },
    __filename: filename,
    __dirname: path.dirname(filename),
    require: (id) => (Object.hasOwn(overrides, id) ? overrides[id] : nativeRequire(id)),
    process,
    Buffer,
    URL,
    AbortController,
    AbortSignal: globalThis.AbortSignal,
    setTimeout,
    clearTimeout,
    console: { info() {}, log() {}, warn() {}, error() {} },
    ...globals,
  });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  return sandbox;
}

function loadSettings(filename) {
  return loadModule('src/main/settings.js', {
    electron: { app: { getPath: () => path.dirname(filename) } },
    './private-json': {
      ...require('../src/main/private-json'),
      // Even chmod is avoided: a benchmark must not mutate user configuration.
      readPrivateFile: () => fs.readFileSync(filename, 'utf8'),
      writePrivateJson: () => {
        throw new Error('基准禁止写入实际设置');
      },
    },
  }).module.exports.load();
}

function createHarness(settings, worker, answerModule) {
  const events = [];
  const deliveries = new Map();
  const endpoints = new Map();
  const errors = [];
  const pending = new Set();
  const timers = new Set();
  const handles = new Map();
  const listeners = new Map();
  const subscribers = new Map();
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        value: '',
        textContent: '',
        classList: { add() {}, remove() {}, toggle() {} },
        querySelector: () => ({ textContent: '', outerHTML: '' }),
        addEventListener() {},
        focus() {},
      });
    }
    return elements.get(id);
  };
  const timerGlobals = {
    setTimeout: (callback, ms) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        callback();
      }, ms);
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      timers.delete(timer);
      clearTimeout(timer);
    },
  };
  const append = (entry) => {
    const safe = sessionLogger.sanitizeEntry(entry, settings);
    if (safe) events.push({ ...safe, monotonicMs: performance.now() });
    return true;
  };
  const transportWindow = {
    isDestroyed: () => false,
    webContents: {
      send(channel, payload) {
        for (const callback of subscribers.get(channel) || []) callback({}, payload);
        if (!deliveries.has(payload.reqId)) deliveries.set(payload.reqId, {});
        const delivery = deliveries.get(payload.reqId);
        // Measure AFTER the real renderer callback has updated the answer.
        if (
          channel === 'answer-chunk' &&
          delivery.firstVisibleMs === undefined &&
          element('answer').textContent.trim()
        ) {
          delivery.firstVisibleMs = performance.now();
        }
        if (channel === 'answer-done') {
          delivery.doneMs = performance.now();
          delivery.displayedAnswer = element('answer').textContent;
          delivery.aborted = !!payload.aborted;
        }
      },
    },
  };
  const main = loadModule(
    'src/main/main.js',
    {
      electron: {
        app: { setName() {}, getPath: () => '', whenReady: () => ({ then() {} }), on() {} },
        ipcMain: {
          handle: (name, fn) => handles.set(name, fn),
          on: (name, fn) => listeners.set(name, fn),
        },
      },
      './settings': { load: () => settings },
      './store': store,
      './localStt': worker,
      './sessionLogger': {
        ...sessionLogger,
        appendSessionLog: (_dir, entry) => append(entry),
      },
      ...(answerModule ? { './openaiCompat': answerModule } : {}),
    },
    { ...timerGlobals, transportWindow },
  );
  vm.runInContext('mainWindow = transportWindow', main);
  const window = { QuestionDetection, addEventListener() {} };
  loadModule('src/main/preload.js', {
    electron: {
      contextBridge: { exposeInMainWorld: (name, value) => (window[name] = value) },
      ipcRenderer: {
        invoke: (name, ...args) => Promise.resolve().then(() => handles.get(name)({}, ...args)),
        send: (name, ...args) => {
          const task = Promise.resolve()
            .then(() => listeners.get(name)({}, ...args))
            .catch((error) => errors.push({ errorName: error.name || 'Error', stage: name }))
            .finally(() => pending.delete(task));
          pending.add(task);
        },
        on: (name, fn) => {
          if (!subscribers.has(name)) subscribers.set(name, new Set());
          subscribers.get(name).add(fn);
        },
        removeListener: (name, fn) => subscribers.get(name)?.delete(fn),
      },
    },
  });
  const renderer = vm.createContext({
    window,
    document: { getElementById: element },
    navigator: { mediaDevices: { addEventListener() {} } },
    console: { info() {}, error: () => errors.push({ stage: 'renderer' }) },
    settings,
    recordError: () => errors.push({ stage: 'local-stt' }),
    ...timerGlobals,
  });
  for (const file of ['local-stt.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/renderer', file), 'utf8'), renderer, {
      filename: file,
    });
  }
  vm.runInContext(
    `state.settings = settings;
     state.listening = true;
     appendFinalLine = () => {};
     updateInterim = () => {};
     bindEvents();`,
    renderer,
  );
  return {
    events,
    deliveries,
    endpoints,
    errors,
    renderer,
    api: window.api,
    newClient() {
      const client = vm.runInContext(
        `new window.LocalSttLive({
          role: 'interviewer', language: settings.sttLanguage, sampleRate: 16000,
          onTranscript: (result) => handleTranscript('interviewer', result),
          onSpeechStart: noteInterviewerSpeechStart,
          onUtteranceEnd: noteInterviewerUtteranceEnd,
          onState: (state) => { if (state === 'error') recordError(); }
        })`,
        renderer,
      );
      const flush = client.flush.bind(client);
      client.flush = (reason) => {
        const estimate = {
          flushMs: performance.now(),
          silenceMs: (client.silenceSamples / client.sampleRate) * 1000,
          reason,
        };
        // This is a VAD estimate, not a human-labelled final spoken phoneme.
        estimate.speechEndMs = reason === 'silence' ? estimate.flushMs - estimate.silenceMs : null;
        const key = `${client.sttId}:${client.segmentId + 1}`;
        flush(reason);
        endpoints.set(key, estimate);
      };
      client.connect();
      return client;
    },
    async settled() {
      // Includes tasks enqueued by answer-done draining a queued follow-up.
      while (pending.size) await Promise.all([...pending]);
    },
    async dispose() {
      vm.runInContext('state.listening = false; cancelAutoTimer()', renderer);
      window.api.cancelGenerate();
      await this.settled();
      for (const timer of timers) clearTimeout(timer);
    },
  };
}

function requiredPhrases(file) {
  if (/\(2\)\.m4a$/.test(file)) return ['多少游戏', '棋类游戏', '卡牌类游戏', '其他类别'];
  if (/\(3\)\.m4a$/.test(file)) return ['误差传播定律', '协方差传播律', '测绘', '作用'];
  if (/\(4\)\.m4a$/.test(file)) return ['松组合', '紧组合', '分别是什么意思', '场景'];
  if (/22点39分\.m4a$/.test(file)) return ['合成孔径', '多普勒雷达'];
  return [];
}

function summarize(file, events, deliveries, endpoints, expectedProjectId) {
  const requests = events.filter((event) => event.event === 'answer_request');
  const triggers = events.filter((event) => event.event === 'auto_trigger');
  const question = requests.map((entry) => entry.question).join(' ');
  const missingPhrases = requiredPhrases(file).filter((phrase) => !question.includes(phrase));
  const failures = events.filter((event) => event.event === 'answer_error');
  const answers = requests.map((request) => {
    const related = events.filter((entry) => entry.reqId === request.reqId);
    const trigger = related.find((entry) => entry.event === 'auto_trigger');
    const context = related.find((entry) => entry.event === 'answer_context');
    const done = related.find((entry) => entry.event === 'answer_done');
    const delivery = deliveries.get(request.reqId) || {};
    const endpoint = endpoints.get(`${trigger?.sttId}:${trigger?.segmentId}`);
    const final = events.find(
      (entry) =>
        entry.event === 'asr_final' &&
        entry.sttId === trigger?.sttId &&
        entry.segmentId === trigger?.segmentId,
    );
    const successful = !!(
      done?.answer?.trim() &&
      !done.aborted &&
      !delivery.aborted &&
      delivery.displayedAnswer === done.answer &&
      Number.isFinite(delivery.firstVisibleMs)
    );
    return {
      reqId: request.reqId,
      question: request.question,
      answer: done?.answer || '',
      successful,
      projectId: context?.projectId || null,
      contextChars: context?.contextChars ?? null,
      inputChars: context?.inputChars ?? null,
      retrievalMs: context?.retrievalMs ?? null,
      routingPassed: expectedProjectId
        ? context?.projectId === expectedProjectId
        : context?.contextChars === 0 && !context?.projectId,
      latencyMs: {
        speechEndToVad: endpoint?.speechEndMs == null ? null : round(endpoint.silenceMs),
        vadToAsr: difference(final?.monotonicMs, endpoint?.flushMs),
        asrToTrigger: trigger?.asrToTriggerMs ?? null,
        requestToFirstVisible: difference(delivery.firstVisibleMs, request.monotonicMs),
        speechEndToFirstVisible: difference(delivery.firstVisibleMs, endpoint?.speechEndMs),
        firstVisibleToDone: difference(delivery.doneMs, delivery.firstVisibleMs),
        speechEndToDone: difference(delivery.doneMs, endpoint?.speechEndMs),
      },
      modelTimings: related
        .filter((entry) => entry.event === 'answer_timing')
        .map(({ monotonicMs, ...entry }) => ({
          ...entry,
          sinceRequestMs: difference(monotonicMs, request.monotonicMs),
        })),
      truncated: related.some((entry) => entry.finishReason === 'length'),
      answerIncomplete: done?.answerIncomplete === true,
    };
  });
  return {
    file,
    missingPhrases,
    triggerCount: triggers.length,
    requestCount: requests.length,
    answerErrorCount: failures.length,
    passed:
      requiredPhrases(file).length > 0 &&
      !missingPhrases.length &&
      !failures.length &&
      triggers.length === 1 &&
      answers.length === 1 &&
      answers.every(
        (answer) =>
          answer.successful &&
          answer.routingPassed &&
          !answer.truncated &&
          !answer.answerIncomplete,
      ),
    answers,
    asr: events.filter((entry) => entry.event === 'asr_timing'),
    transcripts: events.filter((entry) => entry.event === 'transcript_final').map((e) => e.text),
    // The sanitizer excludes credentials, full prompts and knowledge text.
    events,
  };
}

function decode(filename) {
  const data = execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      filename,
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      's16le',
      'pipe:1',
    ],
    { maxBuffer: 30 * 1024 * 1024 },
  );
  return new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
}

function parseArgs(argv) {
  const args = { live: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--live') args.live = true;
    else if (['--project', '--audio-dir', '--settings', '--out'].includes(argv[i])) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`缺少 ${argv[i]} 的值`);
      args[argv[i].slice(2)] = argv[++i];
    } else throw new Error(`未知参数：${argv[i]}`);
  }
  if (!args.project || !args['audio-dir']) throw new Error('需要 --project 和 --audio-dir');
  if (args.live && !args.out) throw new Error('--live 必须配合 --out 保存完整结果');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const settings = loadSettings(
    path.resolve(
      args.settings || path.join(os.homedir(), '.config/interview-copilot/settings.json'),
    ),
  );
  if (settings.sttProvider !== 'local') throw new Error('当前配置不是本地语音识别');
  const provider = PROVIDERS[settings.provider];
  if (!provider || !settings[provider.modelField]) throw new Error('回答服务配置不完整');
  if (provider.keyField && !settings[provider.keyField]) throw new Error('回答服务未配置密钥');
  const folder = readProjectFolder(args.project);
  store._reset();
  store.upsertProject({ ...folder, keywords: [folder.name, 'Demo App', '游戏大厅'] });
  const projectId = store.listProjects()[0].id;
  const files = fs
    .readdirSync(args['audio-dir'])
    .filter((file) => requiredPhrases(file).length)
    .sort();
  if (files.length !== 4) throw new Error('需要原始四条 Music 录音；文件名必须与验收记录一致');
  const report = {
    startedAt: new Date().toISOString(),
    live: args.live,
    kind: 'software-pipeline-with-simulated-device-ipc-dom',
    note: '100 ms PCM 实时分包；连续会话保留历史；VAD 末音估计而非人工标注。未覆盖物理音频设备、AudioWorklet、真实 Electron IPC/窗口绘制。单轮小样本不是分位数。',
    overrides: { autoAnswer: true, diagnosticLogging: true },
    settings: {
      provider: settings.provider,
      model: settings[provider.modelField],
      localSttEngine: settings.localSttEngine,
      localSttModel: settings.localSttModel,
      language: settings.sttLanguage,
      maxChars: settings.maxChars,
      maxContextChars: settings.maxContextChars,
      profileChars: (settings.interviewProfile || '').length,
      jobDescriptionChars: (settings.jobDescription || '').length,
    },
    project: { name: folder.name, chars: folder.text.length, id: projectId },
    results: [],
  };
  console.log(JSON.stringify({ event: 'pipeline_preflight', ...report, files }));
  if (!args.live) return;
  const output = path.resolve(args.out);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  // Refuse to overwrite previous evidence or follow an existing symlink.
  const fd = fs.openSync(output, 'wx', 0o600);
  const save = () => {
    const json = JSON.stringify(report, null, 2) + '\n';
    fs.writeSync(fd, json, 0, 'utf8');
    fs.ftruncateSync(fd, Buffer.byteLength(json));
  };
  const worker = new LocalStt();
  let harness;
  try {
    save();
    const decoded = files.map((file) => ({
      file,
      pcm: decode(path.join(args['audio-dir'], file)),
    }));
    harness = createHarness({ ...settings, autoAnswer: true, diagnosticLogging: true }, worker);
    const warmStart = performance.now();
    await harness.api.warmLocalStt();
    report.warmMs = round(performance.now() - warmStart);
    console.log(JSON.stringify({ event: 'pipeline_warm', elapsedMs: report.warmMs }));
    for (const { file, pcm } of decoded) {
      const eventStart = harness.events.length;
      const errorStart = harness.errors.length;
      const client = harness.newClient();
      const start = performance.now();
      let maxFeedLatenessMs = 0;
      try {
        // Leave the listener open for trailing silence and while answering.
        const total = pcm.length + 3 * 16000;
        for (let offset = 0; offset < total; offset += 1600) {
          const length = Math.min(1600, total - offset);
          const due = ((offset + length) / 16000) * 1000;
          await pause(due - (performance.now() - start));
          maxFeedLatenessMs = Math.max(maxFeedLatenessMs, performance.now() - start - due);
          const packet = new Int16Array(length);
          if (offset < pcm.length)
            packet.set(pcm.subarray(offset, Math.min(offset + length, pcm.length)));
          client.send(packet.buffer);
        }
        await client.queue;
        await pause(1200);
        await harness.settled();
        const result = summarize(
          file,
          harness.events.slice(eventStart),
          harness.deliveries,
          harness.endpoints,
          /\(2\)\.m4a$/.test(file) ? projectId : null,
        );
        result.audioMs = round(pcm.length / 16);
        result.maxFeedLatenessMs = round(maxFeedLatenessMs);
        result.harnessErrors = harness.errors.slice(errorStart);
        result.passed &&= result.harnessErrors.length === 0;
        report.results.push(result);
        save();
        console.log(
          JSON.stringify({
            event: 'pipeline_result',
            file,
            passed: result.passed,
            questionCount: result.requestCount,
            answers: result.answers.map(({ question, latencyMs, contextChars, routingPassed }) => ({
              question,
              latencyMs,
              contextChars,
              routingPassed,
            })),
          }),
        );
      } finally {
        await client.close();
      }
    }
    report.passed = report.results.length === 4 && report.results.every((result) => result.passed);
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    report.passed = false;
    report.errorName = error.name || 'Error';
    throw error;
  } finally {
    if (harness) await harness.dispose();
    worker.stop();
    report.finishedAt = new Date().toISOString();
    save();
    fs.closeSync(fd);
  }
}

module.exports = { createHarness, summarize, loadSettings, parseArgs };
if (require.main === module) {
  main().catch((error) => {
    // Do not echo arbitrary service responses/configuration on failure.
    console.error(JSON.stringify({ event: 'pipeline_failed', errorName: error.name || 'Error' }));
    process.exitCode = 1;
  });
}
