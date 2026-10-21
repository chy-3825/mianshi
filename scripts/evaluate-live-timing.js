#!/usr/bin/env node
'use strict';

// Wall-clock PCM playback through the real local worker, LocalSttLive and app
// state machine. Only DOM rendering and answer generation are stubbed.
// Usage: node scripts/evaluate-live-timing.js <audio-dir> [1200,1000,800]
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { LocalStt } = require('../src/main/localStt');
const QuestionDetection = require('../src/renderer/question-detection');

const audioDir = process.argv[2];
const delays = (process.argv[3] || '1200,1000,800').split(',').map(Number);
if (!audioDir || delays.some((delay) => !Number.isInteger(delay) || delay < 0 || delay > 5000)) {
  console.error('用法：node scripts/evaluate-live-timing.js <录音目录> [1200,1000,800]');
  process.exit(2);
}
const appSource = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
const clientSource = fs.readFileSync(path.join(__dirname, '../src/renderer/local-stt.js'), 'utf8');
const worker = new LocalStt();
const settings = { localSttEngine: 'qwen3-asr', localSttModel: 'Qwen/Qwen3-ASR-0.6B-hf' };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function decode(filePath) {
  const data = execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      filePath,
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

// These checks use the previously reviewed four recordings, not model-generated
// ground truth. Passing them is not a general speech recognition accuracy score.
function requiredPhrases(file) {
  if (/\(2\)\.m4a$/.test(file)) return ['多少游戏', '棋类游戏', '卡牌类游戏', '其他类别'];
  if (/\(3\)\.m4a$/.test(file)) return ['误差传播定律', '协方差传播律', '测绘', '作用'];
  if (/\(4\)\.m4a$/.test(file)) return ['松组合', '紧组合', '分别是什么意思', '场景'];
  if (/22点39分\.m4a$/.test(file)) return ['合成孔径', '多普勒雷达'];
  return [];
}

function createRenderer(delay) {
  const events = [];
  const answers = [];
  const errors = [];
  const elements = new Map();
  const timers = new Set();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        value: '',
        textContent: '',
        classList: { add() {}, remove() {}, toggle() {} },
        querySelector: () => ({ textContent: '', outerHTML: '' }),
        focus() {},
      });
    }
    return elements.get(id);
  };
  const sandbox = {
    window: {
      QuestionDetection,
      addEventListener() {},
      api: {
        transcribeLocal: (pcm, rate, language, role) =>
          worker.transcribe(settings, pcm, rate, language, { role }),
        logSessionEvent: (event) => events.push({ atMs: Date.now(), ...event }),
        generateAnswer: (payload) => {
          answers.push({ atMs: Date.now(), ...payload });
          sandbox.setTimeout(() => vm.runInContext('endGenerate()', sandbox), 0);
        },
      },
    },
    document: { getElementById: element },
    console: { info() {}, error: (...args) => errors.push(args.join(' ')) },
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
    recordError: (message) => errors.push(message),
  };
  vm.createContext(sandbox);
  vm.runInContext(clientSource, sandbox);
  const experimentalSource = appSource.replace(
    /const AUTO_DELAY_MS = \d+;/,
    `const AUTO_DELAY_MS = ${delay};`,
  );
  if (!/const AUTO_DELAY_MS = \d+;/.test(appSource)) throw new Error('无法定位自动答题合并窗口');
  vm.runInContext(experimentalSource, sandbox);
  vm.runInContext(
    `state.settings = { autoAnswer: true, maxChars: 500 };
     state.listening = true;
     appendFinalLine = () => {};
     updateInterim = () => {};`,
    sandbox,
  );
  const client = vm.runInContext(
    `new window.LocalSttLive({
      role: 'interviewer', language: 'zh', sampleRate: 16000,
      onTranscript: (result) => handleTranscript('interviewer', result),
      onSpeechStart: noteInterviewerSpeechStart,
      onUtteranceEnd: noteInterviewerUtteranceEnd,
      onState: (state, message) => { if (state === 'error') recordError(message); }
    })`,
    sandbox,
  );
  return {
    client,
    events,
    answers,
    errors,
    dispose: () => {
      for (const timer of timers) clearTimeout(timer);
    },
  };
}

async function replay(file, pcm, delay) {
  const renderer = createRenderer(delay);
  const { client, events, answers, errors } = renderer;
  const startedAtMs = Date.now();
  const start = performance.now();
  let maxFeedLatenessMs = 0;
  client.connect();
  try {
    // 100 ms input packets; silence after the file models an open Monitor input.
    const totalSamples = pcm.length + 3 * 16000;
    for (let offset = 0; offset < totalSamples; offset += 1600) {
      const length = Math.min(1600, totalSamples - offset);
      const dueAt = ((offset + length) / 16000) * 1000;
      await pause(dueAt - (performance.now() - start));
      maxFeedLatenessMs = Math.max(maxFeedLatenessMs, performance.now() - start - dueAt);
      const packet = new Int16Array(length);
      if (offset < pcm.length)
        packet.set(pcm.subarray(offset, Math.min(offset + length, pcm.length)));
      client.send(packet.buffer);
    }
    await client.queue;
    await pause(delay + 100);
    await client.close();
    const triggers = events.filter((event) => event.event === 'auto_trigger');
    const transcripts = events.filter((event) => event.event === 'transcript_final');
    const question = answers.map((answer) => answer.question).join(' ');
    const required = requiredPhrases(file);
    const missingPhrases = required.filter((phrase) => !question.includes(phrase));
    return {
      event: 'live_timing_result',
      file,
      autoDelayMs: delay,
      audioMs: Math.round(pcm.length / 16),
      wallReplayMs: Math.round(performance.now() - start),
      maxFeedLatenessMs: Math.round(maxFeedLatenessMs),
      answerCount: answers.length,
      completeQuestionOnce: required.length
        ? answers.length === 1 && !missingPhrases.length && !errors.length
        : null,
      missingPhrases,
      errors,
      answers: answers.map((answer) => ({
        question: answer.question,
        sincePlaybackStartMs: answer.atMs - startedAtMs,
      })),
      transcripts: transcripts.map((event) => ({
        text: event.text,
        speechActive: event.speechActive,
        sincePlaybackStartMs: event.atMs - startedAtMs,
      })),
      asrElapsedMs: events
        .filter((event) => event.event === 'asr_final')
        .map((event) => event.elapsedMs),
      triggers: triggers.map((event) => ({
        asrToTriggerMs: event.asrToTriggerMs,
        vadToTriggerMs: event.vadToTriggerMs,
      })),
      discarded: events
        .filter((event) => event.event === 'vad_discard')
        .map((event) => ({ reason: event.reason, sincePlaybackStartMs: event.atMs - startedAtMs })),
    };
  } finally {
    renderer.dispose();
    await client.close();
  }
}

async function main() {
  const files = fs
    .readdirSync(audioDir)
    .filter((file) => /\.(m4a|wav|mp3|flac|ogg)$/i.test(file))
    .sort();
  if (!files.length) throw new Error('录音目录里没有音频文件');
  const decoded = files.map((file) => ({ file, pcm: decode(path.join(audioDir, file)) }));
  const warmStarted = performance.now();
  if (typeof worker.warm === 'function') await worker.warm(settings);
  else {
    await worker.ensure(settings);
    await worker.transcribe(settings, new Int16Array(16000).buffer, 16000, 'zh', {
      role: 'interviewer',
    });
  }
  console.log(
    JSON.stringify({
      event: 'model_ready',
      warmMs: Math.round(performance.now() - warmStarted),
      mode: 'wall_clock_pcm_real_asr_stub_answer',
    }),
  );
  const results = [];
  for (const delay of delays) {
    for (const { file, pcm } of decoded) {
      console.log(JSON.stringify({ event: 'replay_start', file, autoDelayMs: delay }));
      const result = await replay(file, pcm, delay);
      results.push(result);
      console.log(JSON.stringify(result));
    }
  }
  console.log(
    JSON.stringify({
      event: 'timing_summary',
      groups: delays.map((delay) => {
        const group = results.filter((result) => result.autoDelayMs === delay);
        const waits = group.flatMap((result) =>
          result.triggers.map((trigger) => trigger.asrToTriggerMs),
        );
        return {
          autoDelayMs: delay,
          recordings: group.length,
          passed: group.filter((result) => result.completeQuestionOnce === true).length,
          asrToTriggerMs: waits,
        };
      }),
      scope:
        'Real-time PCM feed, real worker and renderer logic; no actual audio device, Electron IPC or answer model.',
    }),
  );
  if (results.some((result) => result.errors.length || result.completeQuestionOnce === false))
    process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => worker.stop());
