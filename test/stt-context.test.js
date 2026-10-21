'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  buildAsrContext,
  limitContext,
  MAX_PROMPT_CHARS,
  MAX_TERMS,
} = require('../src/main/stt-context');
const { LocalStt } = require('../src/main/localStt');
const { sanitizeEntry } = require('../src/main/sessionLogger');
const { createHarness } = require('../scripts/evaluate-pipeline');
const store = require('../src/main/store');

test('Qwen Chinese hints are short, deduplicated, and use declared spoken project names', () => {
  const projects = [{ name: 'demoapp', keywords: ['demoapp', 'Demo App', '服务管理'] }];
  const hints = buildAsrContext({}, projects);
  assert.match(hints.prompt, /Demo App、服务管理、浅拷贝/);
  assert.equal(hints.prompt.includes('demoapp'), false);
  assert.match(hints.prompt, /CER、WER、P95/);
  assert.match(hints.prompt, /事务隔离级别/);
  assert.ok([...hints.prompt].length <= MAX_PROMPT_CHARS);
  assert.ok(hints.termCount <= MAX_TERMS);
  assert.deepEqual(projects[0].keywords, ['demoapp', 'Demo App', '服务管理']);
});

test('explicit off, other backends, and non-Chinese language do not receive hints', () => {
  for (const settings of [
    { localSttContextEnabled: false },
    { localSttEngine: 'sensevoice' },
    { localSttEngine: 'faster-whisper' },
    { sttLanguage: 'en-US' },
    { sttLanguage: 'multi' },
  ])
    assert.deepEqual(buildAsrContext(settings), { prompt: '', termCount: 0 });
});

test('each of the first three project names has priority over keyword lists', () => {
  const hints = buildAsrContext({}, [
    { name: 'first', keywords: ['one', 'two', 'three', 'four', 'five', 'six', 'seven'] },
    { name: 'second', keywords: ['eight'] },
    { name: 'third', keywords: ['nine'] },
  ]);
  assert.match(hints.prompt, /first、second、third/);
  assert.ok([...hints.prompt].length <= MAX_PROMPT_CHARS);
});

test('custom terms and project labels are bounded vocabulary, not arbitrary document prompts', () => {
  const hints = buildAsrContext(
    {
      localSttContextTerms:
        '自定义术语，宏任务，CUDA\n<script>alert(1)</script>，' + '整段描述'.repeat(150),
    },
    [{ name: '有效项目', keywords: ['有效项目', 'https://private.invalid', '安全关键词'] }],
  );
  assert.match(hints.prompt, /自定义术语/);
  assert.match(hints.prompt, /安全关键词/);
  assert.doesNotMatch(hints.prompt, /script|private|整段描述/);
  assert.equal(hints.prompt.split('宏任务').length - 1, 1);
  assert.ok([...hints.prompt].length <= MAX_PROMPT_CHARS);
  assert.ok(hints.termCount <= MAX_TERMS);
  assert.equal([...limitContext('词'.repeat(500))].length, MAX_PROMPT_CHARS);
  assert.equal(limitContext(null), '');
});

test('worker requests capture hints per queued task and settings changes do not restart the model', async () => {
  const stt = new LocalStt({ scriptPath: path.join(__dirname, '../fixtures/fake-stt-worker.js') });
  const settings = { localSttPython: process.execPath, localSttModel: 'echo-context' };
  try {
    await stt.warm(settings);
    const child = stt.child;
    const metrics = [];
    assert.equal(
      await stt.transcribe(settings, Buffer.alloc(4), 16000, 'zh', {
        context: '技术面试词汇：Demo App。',
        onTiming: (timing) => metrics.push(timing),
      }),
      '技术面试词汇：Demo App。',
    );
    assert.equal(metrics[0].hintApplied, true);
    assert.equal(metrics[0].hintFallback, false);
    assert.equal('context' in metrics[0], false);
    assert.equal(
      await stt.transcribe(
        { ...settings, localSttContextEnabled: false },
        Buffer.alloc(4),
        16000,
        'zh',
        {
          context: 'must be disabled',
        },
      ),
      '无提示',
    );
    assert.equal(await stt.transcribe(settings, Buffer.alloc(4), 16000, 'en-US'), '无提示');
    assert.equal(stt.child, child);
  } finally {
    stt.stop();
  }
});

test('main-process transcription uses current knowledge names but never persists vocabulary text', async () => {
  store._reset();
  const project = store.upsertProject({
    rootPath: '/tmp/test-project',
    readmePath: '/tmp/test-project/README.md',
    name: '测试专名',
    keywords: ['测试专名', '领域词'],
    text: 'Private README body must not become the ASR context.',
  });
  const calls = [];
  const worker = {
    transcribe: async (...args) => {
      calls.push(args);
      args[4].onTiming({ hintApplied: true, hintFallback: false, hintChars: 20, inferenceMs: 10 });
      return '这是问题吗？';
    },
  };
  const harness = createHarness({ diagnosticLogging: true }, worker);
  try {
    await harness.api.transcribeLocal(new ArrayBuffer(4), 16000, 'zh', 'interviewer');
    assert.match(calls[0][4].context, /测试专名、领域词/);
    assert.doesNotMatch(calls[0][4].context, /Private README/);
    store.setProjectKeywords(project.id, ['新关键词']);
    await harness.api.transcribeLocal(new ArrayBuffer(4), 16000, 'zh', 'interviewer');
    assert.match(calls[1][4].context, /新关键词/);
    const timing = harness.events.find((event) => event.event === 'asr_timing');
    assert.equal(timing.hintApplied, true);
    assert.equal(timing.hintFallback, false);
    assert.doesNotMatch(JSON.stringify(timing), /测试专名|新关键词|Private README/);
  } finally {
    await harness.dispose();
    store._reset();
  }
});

test('ASR hint logs retain bounded diagnostics but omit the entire vocabulary', () => {
  const entry = sanitizeEntry({
    event: 'asr_timing',
    hintApplied: true,
    hintFallback: true,
    hintFallbackReason: 'echo',
    hintChars: 86,
    hintTermCount: 17,
    context: 'private terms',
    prompt: 'private prompt',
  });
  assert.equal(entry.hintFallbackReason, 'echo');
  assert.equal(entry.hintTermCount, 17);
  assert.equal(entry.hintChars, 86);
  assert.doesNotMatch(JSON.stringify(entry), /private/);
});

test('Python Qwen context guard and fallback tests run without model or CUDA dependencies', (t) => {
  const result = spawnSync(
    'python3',
    [path.join(__dirname, '../fixtures/qwen-context-checks.py')],
    {
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  if (result.error?.code === 'ENOENT') return t.skip('Python 3 is unavailable');
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stderr, /OK/);
  assert.ok(fs.existsSync(path.join(__dirname, '../local_stt/server.py')));
});
