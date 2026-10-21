'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {
  createHarness,
  summarize,
  loadSettings,
  parseArgs,
} = require('../scripts/evaluate-pipeline');
const store = require('../src/main/store');

const RADAR_FILE = 'sample-interview.m4a';
const GAME_FILE = 'sample-interview-copy.m4a';
const RADAR_QUESTION = '什么是数据库索引？';
const GAME_QUESTION = 'Demo App 包含哪些模块？';
const settings = {
  provider: 'ollama',
  ollamaModel: 'offline-test-model',
  ollamaBaseURL: 'http://127.0.0.1:9/never-contacted',
  sttProvider: 'local',
  sttLanguage: 'zh',
  autoAnswer: true,
  diagnosticLogging: true,
  maxChars: 500,
  maxContextChars: 20000,
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForRequest(harness, count) {
  const deadline = Date.now() + 3000;
  while (harness.events.filter((event) => event.event === 'answer_request').length < count) {
    assert.ok(Date.now() < deadline, 'real renderer auto-answer timer should trigger');
    await sleep(10);
  }
  await harness.settled();
}

function fakeWorker(question = RADAR_QUESTION) {
  const calls = [];
  return {
    calls,
    async warm(config) {
      calls.push({ stage: 'warm', config });
      return { warmMs: 1 };
    },
    async transcribe(config, pcm, sampleRate, language, options) {
      calls.push({ stage: 'transcribe', config, pcm, sampleRate, language, role: options.role });
      options.onTiming({ role: options.role, queueMs: 2, inferenceMs: 3, elapsedMs: 5 });
      return question;
    },
  };
}

function triggerQuestion(harness, question) {
  harness.renderer.testQuestion = question;
  vm.runInContext(
    "handleTranscript('interviewer', { text: testQuestion, isFinal: true })",
    harness.renderer,
  );
}

function summaryFixture() {
  return {
    events: [
      { event: 'asr_final', sttId: 4, segmentId: 2, monotonicMs: 1300 },
      { event: 'answer_request', reqId: 7, question: RADAR_QUESTION, monotonicMs: 2300 },
      {
        event: 'auto_trigger',
        reqId: 7,
        question: RADAR_QUESTION,
        sttId: 4,
        segmentId: 2,
        asrToTriggerMs: 1000,
        monotonicMs: 2300,
      },
      {
        event: 'answer_context',
        reqId: 7,
        contextChars: 0,
        inputChars: 1200,
        retrievalMs: 1,
        monotonicMs: 2301,
      },
      {
        event: 'answer_timing',
        reqId: 7,
        stage: 'complete',
        finishReason: 'stop',
        promptTokens: 200,
        monotonicMs: 3000,
      },
      { event: 'answer_done', reqId: 7, answer: '这是测试答案。', monotonicMs: 3000 },
    ],
    deliveries: new Map([
      [
        7,
        { firstVisibleMs: 2800, doneMs: 3000, displayedAnswer: '这是测试答案。', aborted: false },
      ],
    ]),
    endpoints: new Map([['4:2', { flushMs: 1000, speechEndMs: 350, silenceMs: 650 }]]),
  };
}

test('pipeline executes real PCM splitter, preload IPC, ASR callbacks and automatic renderer answer', async () => {
  store._reset();
  const worker = fakeWorker();
  const answer = '本离线测试仅验证回答正文经过实际渲染回调。';
  let callCount = 0;
  const answerModule = {
    async generateAnswerStream({ onStart, onChunk, onTiming, model, maxOutputTokens }) {
      callCount++;
      assert.equal(model, settings.ollamaModel);
      assert.equal(maxOutputTokens, 4096);
      onStart();
      onTiming({ stage: 'request-start', elapsedMs: 0 });
      onTiming({ stage: 'headers', elapsedMs: 1, status: 200 });
      onChunk(' \n');
      assert.equal(harness.deliveries.get(1)?.firstVisibleMs, undefined);
      assert.equal(
        vm.runInContext("document.getElementById('answer').textContent", harness.renderer),
        ' \n',
      );
      await sleep(10);
      onTiming({ stage: 'first-content', elapsedMs: 11 });
      onChunk(answer);
      onTiming({ stage: 'complete', elapsedMs: 12, outcome: 'complete', finishReason: 'stop' });
      return ' \n' + answer;
    },
  };
  const harness = createHarness(settings, worker, answerModule);
  let client;
  try {
    assert.equal(await harness.api.warmLocalStt(), true);
    client = harness.newClient();
    // Synthetic packets deliberately are not real-time audio: this tests wiring,
    // while the benchmark measures wall-clock latency on the recorded samples.
    client.send(new Int16Array(3200).fill(1200).buffer);
    client.send(new Int16Array(11200).buffer);
    await client.queue;
    await waitForRequest(harness, 1);

    const result = summarize(
      RADAR_FILE,
      harness.events,
      harness.deliveries,
      harness.endpoints,
      null,
    );
    assert.equal(callCount, 1);
    assert.equal(result.passed, true);
    assert.equal(result.answers[0].answer, ' \n' + answer);
    assert.equal(result.answers[0].successful, true);
    assert.equal(result.answers[0].routingPassed, true);
    assert.equal(result.asr.length, 1);
    assert.equal(result.asr[0].queueMs, 2);
    assert.equal(result.asr[0].inferenceMs, 3);
    assert.equal(result.answers[0].modelTimings.length, 4);
    assert.equal(result.answers[0].latencyMs.asrToTrigger >= 1000, true);
    assert.deepEqual(result.transcripts, [RADAR_QUESTION]);
    assert.deepEqual(harness.errors, []);
    assert.equal(worker.calls.length, 2);
    assert.equal(worker.calls[1].role, 'interviewer');
    assert.equal(worker.calls[1].sampleRate, 16000);
    assert.equal(worker.calls[1].language, 'zh');
    assert.equal(Object.prototype.toString.call(worker.calls[1].pcm), '[object Uint8Array]');
    assert.equal(vm.runInContext('state.generating', harness.renderer), false);
  } finally {
    if (client) await client.close();
    await harness.dispose();
    store._reset();
  }
});

test('pipeline retains conversation but does not route an independent question to the previous project', async () => {
  store._reset();
  const project = store.upsertProject({
    rootPath: '/offline-pipeline-fixture/Demo App',
    readmePath: '/offline-pipeline-fixture/Demo App/README.md',
    name: 'Demo App',
    text: '# Demo App\n项目包含账户、搜索和报表三个模块。',
    keywords: ['Demo App', '服务管理'],
  });
  const calls = [];
  const harness = createHarness(settings, fakeWorker(), {
    async generateAnswerStream(options) {
      calls.push(options.userText);
      options.onStart();
      options.onTiming({ stage: 'first-content', elapsedMs: 1 });
      options.onChunk('离线正文');
      options.onTiming({
        stage: 'complete',
        elapsedMs: 2,
        outcome: 'complete',
        finishReason: 'stop',
      });
      return '离线正文';
    },
  });
  try {
    triggerQuestion(harness, GAME_QUESTION);
    await waitForRequest(harness, 1);
    const first = summarize(
      GAME_FILE,
      harness.events,
      harness.deliveries,
      harness.endpoints,
      project.id,
    );
    assert.equal(first.passed, true);
    assert.equal(first.answers[0].projectId, project.id);
    assert.ok(first.answers[0].contextChars > 0);
    assert.match(calls[0], /账户、搜索和报表三个模块/);

    const offset = harness.events.length;
    triggerQuestion(harness, RADAR_QUESTION);
    await waitForRequest(harness, 2);
    const second = summarize(
      RADAR_FILE,
      harness.events.slice(offset),
      harness.deliveries,
      harness.endpoints,
      null,
    );
    assert.equal(second.passed, true);
    assert.equal(second.answers[0].contextChars, 0);
    assert.equal(second.answers[0].projectId, null);
    assert.equal(vm.runInContext('state.history.length', harness.renderer), 2);
    assert.match(calls[1], /Demo App/);
    assert.doesNotMatch(calls[1], /账户、搜索和报表三个模块/);
    assert.deepEqual(harness.errors, []);
  } finally {
    await harness.dispose();
    store._reset();
  }
});

test('pipeline records model failure instead of reporting a visible successful answer', async () => {
  store._reset();
  const harness = createHarness(settings, fakeWorker(), {
    async generateAnswerStream({ onStart }) {
      onStart();
      throw new Error('offline fixture model failure');
    },
  });
  try {
    triggerQuestion(harness, RADAR_QUESTION);
    await waitForRequest(harness, 1);
    const result = summarize(
      RADAR_FILE,
      harness.events,
      harness.deliveries,
      harness.endpoints,
      null,
    );
    assert.equal(result.passed, false);
    assert.equal(result.answerErrorCount, 1);
    assert.equal(result.answers[0].successful, false);
    assert.equal(result.answers[0].latencyMs.requestToFirstVisible, null);
    assert.equal(vm.runInContext('state.generating', harness.renderer), false);
  } finally {
    await harness.dispose();
    store._reset();
  }
});

test('pipeline summary joins request and segment IDs and measures visible text separately', () => {
  const fixture = summaryFixture();
  fixture.events.unshift({ event: 'asr_final', sttId: 3, segmentId: 2, monotonicMs: 500 });
  const result = summarize(RADAR_FILE, fixture.events, fixture.deliveries, fixture.endpoints, null);
  assert.equal(result.passed, true);
  assert.deepEqual(result.answers[0].latencyMs, {
    speechEndToVad: 650,
    vadToAsr: 300,
    asrToTrigger: 1000,
    requestToFirstVisible: 500,
    speechEndToFirstVisible: 2450,
    firstVisibleToDone: 200,
    speechEndToDone: 2650,
  });
  assert.equal(result.answers[0].modelTimings[0].sinceRequestMs, 700);
  assert.equal(result.answers[0].modelTimings[0].promptTokens, 200);
  fixture.endpoints.clear();
  const withoutEndpoint = summarize(
    RADAR_FILE,
    fixture.events,
    fixture.deliveries,
    fixture.endpoints,
    null,
  );
  assert.equal(withoutEndpoint.answers[0].latencyMs.speechEndToFirstVisible, null);
  assert.equal(withoutEndpoint.answers[0].latencyMs.vadToAsr, null);
});

test('pipeline summary cannot pass truncated, partial, aborted, mismatched or misrouted results', () => {
  const cases = [
    [
      'suspected incomplete answer despite normal provider stop',
      (f) => {
        f.events.find((e) => e.event === 'answer_done').answerIncomplete = true;
      },
    ],
    [
      'truncated',
      (f) => {
        f.events.find((e) => e.event === 'answer_timing').finishReason = 'length';
      },
    ],
    [
      'missing done',
      (f) => {
        f.events = f.events.filter((e) => e.event !== 'answer_done');
      },
    ],
    [
      'blank answer',
      (f) => {
        f.events.find((e) => e.event === 'answer_done').answer = ' \n';
      },
    ],
    [
      'missing visible content',
      (f) => {
        delete f.deliveries.get(7).firstVisibleMs;
      },
    ],
    [
      'aborted',
      (f) => {
        f.deliveries.get(7).aborted = true;
      },
    ],
    [
      'display mismatch',
      (f) => {
        f.deliveries.get(7).displayedAnswer = 'only partial';
      },
    ],
    [
      'wrong project',
      (f) => {
        f.events.find((e) => e.event === 'answer_context').projectId = 'wrong';
      },
    ],
    [
      'unrelated knowledge',
      (f) => {
        f.events.find((e) => e.event === 'answer_context').contextChars = 100;
      },
    ],
    [
      'model error',
      (f) => {
        f.events.push({ event: 'answer_error', reqId: 7 });
      },
    ],
    [
      'missing phrase',
      (f) => {
        f.events.find((e) => e.event === 'answer_request').question = '什么是数据库？';
      },
    ],
    [
      'repeated trigger',
      (f) => {
        f.events.push({ ...f.events.find((e) => e.event === 'auto_trigger') });
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    const fixture = summaryFixture();
    mutate(fixture);
    assert.equal(
      summarize(RADAR_FILE, fixture.events, fixture.deliveries, fixture.endpoints, null).passed,
      false,
      name,
    );
  }
  const fixture = summaryFixture();
  assert.equal(
    summarize('unknown.m4a', fixture.events, fixture.deliveries, fixture.endpoints, null).passed,
    false,
  );
  assert.equal(
    summarize(RADAR_FILE, fixture.events, fixture.deliveries, fixture.endpoints, 'expected-project')
      .passed,
    false,
  );
});

test('pipeline CLI refuses unknown, incomplete and unsaved live runs', () => {
  assert.throws(() => parseArgs([]), /需要 --project 和 --audio-dir/);
  assert.throws(() => parseArgs(['--project']), /缺少 --project 的值/);
  assert.throws(() => parseArgs(['--project', '--audio-dir', '/audio']), /缺少 --project 的值/);
  assert.throws(() => parseArgs(['--bogus']), /未知参数/);
  const base = ['--project', '/fixture/project', '--audio-dir', '/fixture/audio'];
  assert.equal(parseArgs(base).live, false);
  assert.throws(() => parseArgs([...base, '--live']), /--out/);
  assert.deepEqual(parseArgs([...base, '--live', '--out', '/fixture/report.json']), {
    live: true,
    project: '/fixture/project',
    'audio-dir': '/fixture/audio',
    out: '/fixture/report.json',
  });
});

test('pipeline settings migration is read-only and uses only its supplied fixture', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-settings-test-'));
  const filename = path.join(dir, 'fixture.json');
  const raw = JSON.stringify({
    provider: 'ollama',
    deepgramApiKey: '',
    geminiApiKey: '',
    deepseekApiKey: '',
    openaiApiKey: '',
    customApiKey: '',
    localSttEngine: 'sensevoice',
    localSttModel: 'iic/SenseVoiceSmall',
    autoAnswer: false,
  });
  try {
    fs.writeFileSync(filename, raw, { mode: 0o640 });
    const before = fs.statSync(filename);
    const loaded = loadSettings(filename);
    const after = fs.statSync(filename);
    assert.equal(loaded.localSttEngine, 'qwen3-asr');
    assert.equal(loaded.localSttModel, 'Qwen/Qwen3-ASR-0.6B-hf');
    assert.equal(loaded.autoAnswer, true);
    assert.equal(loaded.localSttPreferenceVersion, 2);
    assert.equal(loaded.autoAnswerPreferenceVersion, 2);
    assert.equal(fs.readFileSync(filename, 'utf8'), raw);
    assert.equal(after.mode, before.mode);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.deepEqual(fs.readdirSync(dir), ['fixture.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
