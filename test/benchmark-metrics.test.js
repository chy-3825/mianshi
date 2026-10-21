'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeText,
  canonicalText,
  editDistance,
  transcriptionMetrics,
  conceptCoverage,
  answerProxies,
  distribution,
  aggregateResults,
} = require('../scripts/benchmark-metrics');

test('edit distance counts Unicode characters rather than UTF-16 code units', () => {
  assert.equal(editDistance('服务重试', '服务超时重试'), 2);
  assert.equal(editDistance('乐观锁', '悲观锁'), 1);
  assert.equal(editDistance('甲😀乙', '甲乙'), 1);
  assert.equal(editDistance('', '𠮷😀'), 2);
  assert.equal(editDistance('𠮷😀', ''), 2);
  assert.equal(editDistance('同一个问题', '同一个问题'), 0);
});

test('surface normalization removes punctuation and normalizes full-width characters', () => {
  assert.equal(normalizeText(' ＤｅｍｏＡｐｐ，１２３！\n'), 'demoapp123');
  assert.equal(normalizeText('事务隔离、并发；控制？'), '事务隔离并发控制');
  assert.equal(normalizeText(null), '');
});

test('canonical normalization equates declared number-unit forms without rewriting words', () => {
  assert.equal(canonicalText('二十八条记录，三十秒，两种模式'), '28条记录30秒2种模式');
  assert.equal(canonicalText('一百零二毫秒，十二分钟，十次'), '102毫秒12分钟10次');
  assert.equal(canonicalText('一致性、二分查找、一种二分策略'), '一致性二分查找1种二分策略');
  assert.equal(canonicalText('一致性和二分查找'), normalizeText('一致性和二分查找'));
  assert.equal(canonicalText('二十八条记录'), canonicalText('28 条记录'));
});

test('transcription diagnostics keep literal, surface and canonical CER separate', () => {
  const metrics = transcriptionMetrics(
    '服务有二十八条记录，一致性和二分查找。',
    '服务有28条记录 一致性和二分查找',
  );
  assert.ok(metrics.literal.edits > 0);
  assert.ok(metrics.surface.edits > 0);
  assert.equal(metrics.canonical.edits, 0);
  assert.equal(metrics.canonical.rate, 0);
  assert.equal(
    metrics.canonical.referenceChars,
    Array.from('服务有28条记录一致性和二分查找').length,
  );
  assert.deepEqual(transcriptionMetrics('', '字').literal, {
    edits: 1,
    referenceChars: 0,
    rate: null,
  });
});

test('concept groups accept declared aliases and report each missing group', () => {
  const groups = [
    ['Demo App', '服务管理界面'],
    ['三十秒', '30秒'],
    ['令牌', 'token'],
  ];
  assert.deepEqual(conceptCoverage('服务管理界面会保留 30 秒 TOKEN。', groups), {
    expected: 3,
    matched: 3,
    allMatched: true,
    missing: [],
  });
  assert.deepEqual(conceptCoverage('服务管理界面', groups), {
    expected: 3,
    matched: 1,
    allMatched: false,
    missing: [groups[1], groups[2]],
  });
  assert.equal(conceptCoverage('内容', [['']]).matched, 0);
});

test('answer keyword checks expose proxies even when the sentence denies the fact', () => {
  const proxy = answerProxies('Demo App并没有28条记录。', { mustMention: ['Demo App', '28条记录'] });
  assert.equal(proxy.passed, true);
  assert.equal(proxy.matched, 2);
  assert.equal(Object.hasOwn(proxy, 'accuracy'), false);
  assert.deepEqual(
    answerProxies('令牌永久有效', { mustMention: ['令牌'], mustNotMention: ['永久有效'] })
      .forbidden,
    ['永久有效'],
  );
  assert.equal(
    answerProxies('令牌永久有效', { mustMention: ['令牌'], mustNotMention: ['永久有效'] }).passed,
    false,
  );
});

test('latency distributions use nearest-rank quantiles and exclude non-finite observations', () => {
  assert.deepEqual(distribution([10, 1, NaN, 6, 3, 9, 2, Infinity, 8, 5, 7, 4, null, undefined]), {
    n: 10,
    min: 1,
    mean: 6,
    p50: 5,
    p90: 9,
    p95: 10,
    max: 10,
  });
  assert.deepEqual(distribution([NaN, Infinity, null]), { n: 0 });
  assert.deepEqual(distribution([42]), {
    n: 1,
    min: 42,
    mean: 42,
    p50: 42,
    p90: 42,
    p95: 42,
    max: 42,
  });
});

test('aggregate CER weights by reference characters rather than averaging case rates', () => {
  const result = aggregateResults(
    [
      { transcriptionMetrics: transcriptionMetrics('甲乙', '甲丙') },
      {
        transcriptionMetrics: transcriptionMetrics('一二三四五六七八九十', '一二三四五六七八九错'),
      },
    ],
    2,
  );
  for (const key of ['literal', 'surface', 'canonical']) {
    assert.deepEqual(result.characterError[key], { edits: 2, referenceChars: 12, rate: 2 / 12 });
    assert.notEqual(result.characterError[key].rate, (0.5 + 0.1) / 2);
  }
  assert.equal(aggregateResults([], 100).characterError.literal.rate, null);
});

test('aggregate samples latency only from unique, non-early, successful, complete answers', () => {
  const answer = (latency, overrides = {}) => ({
    successful: true,
    truncated: false,
    routingPassed: true,
    retrievalMs: 2,
    latencyMs: {
      speechEndToFirstVisible: latency,
      requestToFirstVisible: latency,
      speechEndToDone: latency,
      vadToAsr: latency,
      asrToTrigger: latency,
      firstVisibleToDone: latency,
    },
    ...overrides,
  });
  const entry = (answers, overrides = {}) => ({
    triggerCount: answers.length,
    requestCount: answers.length,
    answers,
    transcripts: ['问题'],
    structurePassed: true,
    concepts: { allMatched: true },
    answerProxy: { passed: true },
    events: [{ event: 'answer_timing', stage: 'request-start' }],
    ...overrides,
  });
  const aggregate = aggregateResults(
    [
      entry([answer(10)], { asr: [{ queueMs: 0, inferenceMs: 100 }] }),
      entry([answer(30)], { asr: [{ queueMs: 8, inferenceMs: 200 }] }),
      entry([answer(20), answer(25)]),
      entry([answer(5)], { earlyTrigger: true }),
      entry([answer(100, { truncated: true })]),
      entry([answer(300, { successful: false })], {
        answerErrorCount: 2,
        events: [
          { event: 'answer_timing', stage: 'request-start' },
          { event: 'answer_error', reason: 'first_content_timeout' },
          { event: 'answer_timing', stage: 'request-start' },
          { event: 'answer_error', reason: 'overall_timeout' },
        ],
      }),
      entry([], { transcripts: [], structurePassed: false, events: [] }),
    ],
    100,
  );
  assert.equal(aggregate.expectedCount, 100);
  assert.equal(aggregate.completedCases, 7);
  assert.equal(aggregate.noTrigger, 1);
  assert.equal(aggregate.duplicateTrigger, 1);
  assert.equal(aggregate.earlyTrigger, 1);
  assert.equal(aggregate.noTranscript, 1);
  assert.equal(aggregate.serviceFailedCases, 1);
  assert.equal(aggregate.firstContentTimeouts, 1);
  assert.equal(aggregate.overallTimeouts, 1);
  assert.equal(aggregate.truncatedAnswers, 1);
  assert.equal(aggregate.totalLogicalRequests, 7);
  assert.equal(aggregate.modelAttempts, 7);
  assert.equal(aggregate.successfulAnswers, 5);
  for (const metric of Object.values(aggregate.latencyMs)) {
    assert.deepEqual(metric, { n: 2, min: 10, mean: 20, p50: 10, p90: 30, p95: 30, max: 30 });
  }
  assert.equal(aggregate.queueMs.n, 2);
  assert.equal(aggregate.queueMs.max, 8);
  assert.equal(aggregate.inferenceMs.mean, 150);
  assert.match(aggregate.note, /关键词是诊断代理，不是专业正确率/);
});

test('empty aggregate retains failure counters without fabricating a latency or accuracy rate', () => {
  const result = aggregateResults([], 100);
  assert.equal(result.completedCases, 0);
  assert.equal(result.serviceFailedCases, 0);
  assert.equal(result.successfulAnswers, 0);
  assert.equal(result.answerProxyPassed, 0);
  assert.equal(Object.hasOwn(result, 'accuracy'), false);
  assert.deepEqual(result.latencyMs.speechEndToFirstVisible, { n: 0 });
});

test('aggregate separates transport success from a suspected incomplete answer', () => {
  const result = aggregateResults(
    [
      {
        requestCount: 1,
        answers: [
          {
            successful: true,
            answerIncomplete: true,
            latencyMs: { speechEndToFirstVisible: 2000 },
          },
        ],
      },
    ],
    1,
  );
  assert.equal(result.deliveredAnswers, 1);
  assert.equal(result.suspectedIncompleteAnswers, 1);
  assert.equal(result.successfulAnswers, 0);
  assert.deepEqual(result.latencyMs.speechEndToFirstVisible, { n: 0 });
});
