'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { checkAnswerCompleteness } = require('../src/main/answer-quality');
const { sanitizeEntry } = require('../src/main/sessionLogger');
const { createHarness } = require('../scripts/evaluate-pipeline');

const suspected = [
  ['q094 incomplete ending', '具体覆盖率数字要以当前实际运行结果为', 'dangling_clause'],
  ['trailing example', '常见重连策略，例如', 'dangling_clause'],
  ['trailing list introducer', '身份认证包括', 'dangling_clause'],
  ['trailing explanation', '这里需要防止重复写入，因为', 'dangling_clause'],
  ['trailing cause', '选择这一策略主要由于', 'dangling_clause'],
  ['trailing separate items', '这三个方法分别是', 'dangling_clause'],
  ['trailing colon', '具体的处理顺序如下：', 'trailing_colon'],
  ['English dangling connector', 'Validate the identity and', 'dangling_connector'],
  ['open Markdown code fence', '示例：\n```js\nconst x = 1;', 'unclosed_code_fence'],
  ['open descriptive bracket', '服务需要保存会话（包括用户身份', 'unclosed_bracket'],
];
for (const [name, text, reason] of suspected) {
  test(`completeness warns for ${name}`, () => {
    assert.deepEqual(checkAnswerCompleteness(text), { suspected: true, reason });
  });
}

const complete = [
  ['no final punctuation', '先校验身份，再处理请求'],
  ['method signature', 'getState(playerId)'],
  ['method signature in inline code', '方法例如：`getState(playerId)`'],
  ['mathematical expression', '重试次数可以写为 total = attempts * 2'],
  ['half-open mathematical intervals', '数组有效下标属于 [0, n)，概率取值属于 (0, 1]'],
  ['complete list', '方法如下：\n- init\n- getState\n- handleAction\n- cleanup'],
  ['closed Markdown fence after colon', '例如：\n```js\nfunction f() { return 1; }\n```'],
  ['longer closed Markdown fence', '````js\nconst text = "```";\n````'],
  ['literal bracket symbols', '“（” 是左括号，"[" 是左方括号'],
  ['a complete phrase ending in behavior', '以白名单约束用户行为'],
  ['valid upper-case operator name', '可用的逻辑运算符是 AND'],
  ['literal English connector', '最后的关键字是 `and`'],
  ['empty or invalid input', null],
  ['example ending with address', '地址如下：https://example.invalid'],
];
for (const [name, text] of complete) {
  test(`completeness does not warn for ${name}`, () => {
    assert.deepEqual(checkAnswerCompleteness(text), { suspected: false, reason: null });
  });
}

test('completion logs retain the warning boolean and enum without storing new raw payloads', () => {
  const result = sanitizeEntry({
    event: 'answer_done',
    answerIncomplete: true,
    reason: 'dangling_clause',
    qualityPayload: { private: 'not saved' },
  });
  assert.equal(result.answerIncomplete, true);
  assert.equal(result.reason, 'dangling_clause');
  assert.equal('qualityPayload' in result, false);
});

const settings = {
  provider: 'ollama',
  ollamaModel: 'offline-test-model',
  ollamaBaseURL: 'http://127.0.0.1:9/never-contacted',
  diagnosticLogging: true,
  autoAnswer: true,
  maxChars: 500,
};

async function generateFixture(t, answer, aborted = false) {
  let calls = 0;
  const harness = createHarness(
    settings,
    {},
    {
      async generateAnswerStream({ onStart, onChunk, onTiming }) {
        calls++;
        onStart();
        onChunk(answer);
        if (aborted) {
          const error = new Error('fixture cancellation');
          error.name = 'AbortError';
          throw error;
        }
        onTiming({ stage: 'complete', elapsedMs: 1, outcome: 'complete', finishReason: 'stop' });
        return answer;
      },
    },
  );
  t.after(() => harness.dispose());
  vm.runInContext(
    "document.getElementById('questionBox').value = '当前测试覆盖率如何？'; triggerGenerate()",
    harness.renderer,
  );
  await harness.settled();
  return { harness, calls };
}

test('real main completion warns in renderer but preserves full text and makes exactly one request', async (t) => {
  const answer = '具体覆盖率数字要以当前实际运行结果为';
  const { harness, calls } = await generateFixture(t, answer);
  const done = harness.events.find((event) => event.event === 'answer_done');
  assert.equal(calls, 1);
  assert.equal(harness.events.filter((event) => event.event === 'answer_request').length, 1);
  assert.equal(harness.events.filter((event) => event.event === 'answer_done').length, 1);
  assert.equal(done.outcome, 'complete');
  assert.equal(done.answer, answer);
  assert.equal(done.answerIncomplete, true);
  assert.equal(done.reason, 'dangling_clause');
  assert.equal(harness.deliveries.get(1).displayedAnswer, answer);
  assert.equal(harness.deliveries.get(1).aborted, false);
  assert.match(
    vm.runInContext("document.getElementById('toast').textContent", harness.renderer),
    /回答可能未说完，原文已保留/,
  );
  assert.equal(vm.runInContext('state.generating', harness.renderer), false);
  assert.deepEqual(harness.errors, []);
});

test('normal unpunctuated answers do not show a warning or cause a retry', async (t) => {
  const answer = '具体覆盖率数字要以当前实际运行结果为准';
  const { harness, calls } = await generateFixture(t, answer);
  assert.equal(calls, 1);
  const done = harness.events.find((event) => event.event === 'answer_done');
  assert.equal(done.answerIncomplete, false);
  assert.equal(done.reason, undefined);
  assert.equal(harness.deliveries.get(1).displayedAnswer, answer);
  assert.doesNotMatch(
    vm.runInContext("document.getElementById('toast').textContent", harness.renderer),
    /未说完/,
  );
});

test('intentional cancellation retains the existing aborted outcome without an incomplete-answer toast', async (t) => {
  const { harness, calls } = await generateFixture(t, '具体覆盖率数字要以当前实际运行结果为', true);
  const done = harness.events.find((event) => event.event === 'answer_done');
  assert.equal(calls, 1);
  assert.equal(done.outcome, 'aborted');
  assert.equal(done.answerIncomplete, undefined);
  assert.equal(harness.deliveries.get(1).aborted, true);
  assert.equal(vm.runInContext('state.generating', harness.renderer), false);
  assert.doesNotMatch(
    vm.runInContext("document.getElementById('toast').textContent", harness.renderer),
    /未说完/,
  );
});

test('an incomplete-answer warning still drains exactly one previously queued follow-up', async (t) => {
  let calls = 0;
  const harness = createHarness(
    settings,
    {},
    {
      async generateAnswerStream({ onStart, onChunk }) {
        calls++;
        onStart();
        if (calls === 1) {
          vm.runInContext(
            "state.queuedAuto = { question: '会话清理怎么处理？', transcript: '' }",
            harness.renderer,
          );
        }
        const answer = calls === 1 ? '结果要以当前运行数据为' : '请求结束后释放会话占用的资源';
        onChunk(answer);
        return answer;
      },
    },
  );
  t.after(() => harness.dispose());
  vm.runInContext(
    "document.getElementById('questionBox').value = '当前测试覆盖率如何？'; triggerGenerate()",
    harness.renderer,
  );
  await harness.settled();
  assert.equal(calls, 2);
  const completed = harness.events.filter((event) => event.event === 'answer_done');
  assert.equal(completed.length, 2);
  assert.equal(completed[0].answerIncomplete, true);
  assert.equal(completed[1].answerIncomplete, false);
  assert.equal(harness.events.filter((event) => event.event === 'answer_request').length, 2);
  assert.equal(harness.deliveries.get(2).displayedAnswer, '请求结束后释放会话占用的资源');
  assert.equal(vm.runInContext('state.queuedAuto', harness.renderer), null);
  assert.equal(vm.runInContext('state.generating', harness.renderer), false);
  assert.deepEqual(harness.errors, []);
});
