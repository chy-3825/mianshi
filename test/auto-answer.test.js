'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const QuestionDetection = require('../src/renderer/question-detection');

const appSource = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');

function createRenderer() {
  const sent = [];
  const timers = new Map();
  const elements = new Map();
  let nextTimer = 0;
  let now = 10000;
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        value: '',
        textContent: '',
        classList: { add() {}, remove() {}, toggle() {} },
        querySelector() {
          return { textContent: '', outerHTML: '' };
        },
        focus() {},
      });
    }
    return elements.get(id);
  };
  const sandbox = {
    window: {
      QuestionDetection,
      api: { generateAnswer: (payload) => sent.push(payload) },
      addEventListener() {},
    },
    document: { getElementById: element },
    console: { info() {} },
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    setTimeout: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, delay, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  vm.createContext(sandbox);
  vm.runInContext(appSource, sandbox);
  const state = vm.runInContext('state', sandbox);
  state.settings = { autoAnswer: true, maxChars: 500 };
  state.listening = true;
  const advance = (ms) => {
    const target = now + ms;
    while (true) {
      const entry = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      now = entry[1].at;
      timers.delete(entry[0]);
      entry[1].callback();
    }
    now = target;
  };
  const runAutoTimer = () => {
    const timer = timers.get(state.autoTimer);
    assert.ok(timer, 'an auto-answer timer was scheduled');
    advance(timer.at - now);
  };
  return { sandbox, state, sent, element, runAutoTimer, advance };
}

test('auto mode sends the current question explicitly and queues a new follow-up while busy', () => {
  const { sandbox, state, sent, element, runAutoTimer } = createRenderer();
  const first = '请介绍一下消息队列的整体架构。';
  state.history.push({ role: 'interviewer', text: first });
  state.autoBuffer.append(first);
  vm.runInContext("scheduleAuto('interviewer')", sandbox);
  runAutoTimer();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].question, first);
  assert.equal(element('questionBox').value, first);
  assert.equal(state.generating, true);

  const followUp = '那请求重试呢？';
  state.history.push({ role: 'interviewer', text: followUp });
  state.autoBuffer.append(followUp);
  vm.runInContext("scheduleAuto('interviewer')", sandbox);
  runAutoTimer();
  assert.equal(sent.length, 1, 'the follow-up waits for the first answer');
  assert.equal(state.queuedAuto.question, followUp);

  vm.runInContext('endGenerate()', sandbox);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].question, followUp);
  assert.equal(element('questionBox').value, followUp);
  assert.equal(state.queuedAuto, null);
});

test('a later statement cannot retrigger an old question', () => {
  const { sandbox, state, sent, runAutoTimer } = createRenderer();
  state.autoBuffer.append('怎么保证隐藏信息不泄漏？');
  vm.runInContext("scheduleAuto('interviewer')", sandbox);
  runAutoTimer();
  vm.runInContext('endGenerate()', sandbox);

  state.autoBuffer.append('好的，我们换下一个话题。');
  vm.runInContext("scheduleAuto('interviewer')", sandbox);
  runAutoTimer();
  assert.equal(sent.length, 1);
});

test('microphone crosstalk cannot relabel an interviewer question as Candidate', () => {
  const { sandbox, state } = createRenderer();
  vm.runInContext("pushHistory('interviewer', '为什么新增一个服务只需要注册模块？')", sandbox);
  vm.runInContext("pushHistory('interviewee', '为什么新增一个服务只需要注册模块？对吗')", sandbox);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].role, 'interviewer');

  state.history = [];
  vm.runInContext("pushHistory('interviewee', '为什么新增一个服务只需要注册模块？')", sandbox);
  vm.runInContext("pushHistory('interviewer', '为什么新增一个服务只需要注册模块？')", sandbox);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].role, 'interviewer');
});

test('microphone echo does not cancel a pending interviewer answer', () => {
  const { sandbox, state, sent, runAutoTimer } = createRenderer();
  // The fake DOM need not render transcript bubbles for this state-machine test.
  vm.runInContext('appendFinalLine = () => {}', sandbox);
  vm.runInContext(
    "handleTranscript('interviewer', { text: '什么是数据库索引？', isFinal: true })",
    sandbox,
  );
  const pendingTimer = state.autoTimer;
  vm.runInContext(
    "handleTranscript('interviewee', { text: '什么是数据库索引。', isFinal: true })",
    sandbox,
  );

  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].role, 'interviewer');
  assert.equal(state.autoBuffer.parts.length, 1);
  assert.equal(state.autoTimer, pendingTimer);
  runAutoTimer();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].question, '什么是数据库索引？');
});

test('distinct candidate speech still cancels a pending interviewer answer', () => {
  const { sandbox, state, sent } = createRenderer();
  vm.runInContext('appendFinalLine = () => {}', sandbox);
  vm.runInContext(
    "handleTranscript('interviewer', { text: '什么是事务隔离级别？', isFinal: true })",
    sandbox,
  );
  assert.equal(state.autoBuffer.parts.length, 1);
  assert.notEqual(state.autoTimer, null);
  vm.runInContext(
    "handleTranscript('interviewee', { text: '我觉得这与并发控制有关。', isFinal: true })",
    sandbox,
  );

  assert.equal(state.autoBuffer.parts.length, 0);
  assert.equal(state.autoTimer, null);
  assert.equal(sent.length, 0);
});

test('candidate repeating the question before answering is not mistaken for echo', () => {
  const { sandbox, state } = createRenderer();
  vm.runInContext('appendFinalLine = () => {}', sandbox);
  vm.runInContext(
    "handleTranscript('interviewer', { text: '什么是事务隔离级别？', isFinal: true })",
    sandbox,
  );
  vm.runInContext(
    "handleTranscript('interviewee', { text: '什么是事务隔离级别？我的理解是数据库如何隔离并发操作。', isFinal: true })",
    sandbox,
  );

  assert.equal(state.autoBuffer.parts.length, 0);
  assert.equal(state.autoTimer, null);
});

test('a short pause followed by a second clause cancels the early answer', () => {
  const { sandbox, state, sent, runAutoTimer } = createRenderer();
  const first = '数据库中的乐观锁和悲观锁分别是什么意思？';
  const second = '分别可以应用在哪些场景中？';
  state.autoBuffer.append(first);
  vm.runInContext("scheduleAuto('interviewer')", sandbox);
  vm.runInContext('noteInterviewerSpeechStart()', sandbox);
  state.autoBuffer.append(second);
  state.interviewerSpeaking = false;
  vm.runInContext("scheduleAuto('interviewer')", sandbox);
  runAutoTimer();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].question, `${first} ${second}`);
});

test('a discarded tail resumes the original deadline instead of adding another merge window', () => {
  const { sandbox, state, sent, advance } = createRenderer();
  state.autoBuffer.append('什么是事务隔离级别？');
  vm.runInContext("scheduleAuto('interviewer')", sandbox);
  advance(200);
  vm.runInContext('noteInterviewerSpeechStart()', sandbox);
  advance(700);
  assert.equal(sent.length, 0);
  vm.runInContext('noteInterviewerUtteranceEnd()', sandbox);
  advance(99);
  assert.equal(sent.length, 0);
  advance(1);
  assert.equal(sent.length, 1, 'the original 1000 ms deadline is retained');
});

test('a discarded tail after the deadline triggers immediately without answering during sound', () => {
  const { sandbox, state, sent, advance } = createRenderer();
  state.autoBuffer.append('什么是数据库索引？');
  vm.runInContext("scheduleAuto('interviewer')", sandbox);
  advance(800);
  vm.runInContext('noteInterviewerSpeechStart()', sandbox);
  advance(900);
  assert.equal(sent.length, 0);
  vm.runInContext('noteInterviewerUtteranceEnd()', sandbox);
  advance(0);
  assert.equal(sent.length, 1);
});

test('confirmed continuation gets a fresh merge window and retains all subquestions', () => {
  const { sandbox, sent, advance } = createRenderer();
  vm.runInContext('appendFinalLine = () => {}', sandbox);
  vm.runInContext(
    "handleTranscript('interviewer', { text: '乐观锁和悲观锁分别是什么意思？', isFinal: true })",
    sandbox,
  );
  advance(900);
  vm.runInContext('noteInterviewerSpeechStart()', sandbox);
  advance(1200);
  vm.runInContext(
    "handleTranscript('interviewer', { text: '分别可以应用在哪些场景中？', isFinal: true })",
    sandbox,
  );
  advance(999);
  assert.equal(sent.length, 0);
  advance(1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].question, '乐观锁和悲观锁分别是什么意思？ 分别可以应用在哪些场景中？');
});

test('ASR returning during a tail sets a deadline that can later be resumed', () => {
  const { sandbox, state, sent, advance } = createRenderer();
  vm.runInContext('appendFinalLine = () => {}', sandbox);
  vm.runInContext('noteInterviewerSpeechStart()', sandbox);
  vm.runInContext(
    "handleTranscript('interviewer', { text: '数据库事务有哪些隔离级别？', isFinal: true, speechActive: true })",
    sandbox,
  );
  assert.equal(state.autoTimer, null);
  advance(1400);
  assert.equal(sent.length, 0);
  vm.runInContext('noteInterviewerUtteranceEnd()', sandbox);
  advance(0);
  assert.equal(sent.length, 1);
});

test('a discarded sound cannot restore an answer cancelled by candidate speech', () => {
  const { sandbox, state, sent, advance } = createRenderer();
  vm.runInContext('appendFinalLine = () => {}', sandbox);
  state.autoBuffer.append('为什么使用WebSocket？');
  vm.runInContext("scheduleAuto('interviewer')", sandbox);
  advance(300);
  vm.runInContext('noteInterviewerSpeechStart()', sandbox);
  vm.runInContext(
    "handleTranscript('interviewee', { text: '我来说明一下原因。', isFinal: true })",
    sandbox,
  );
  vm.runInContext('noteInterviewerUtteranceEnd()', sandbox);
  advance(3000);
  assert.equal(sent.length, 0);
  assert.equal(state.autoDeadlineAt, null);
});

test('the same ASR question does not produce a second answer or queued answer', () => {
  const { sandbox, state, sent, runAutoTimer } = createRenderer();
  const question = '请求失败后，系统如何安全重试？';
  state.autoBuffer.append(question);
  vm.runInContext("scheduleAuto('interviewer')", sandbox);
  runAutoTimer();
  assert.equal(sent.length, 1);

  state.autoBuffer.append('请求失败后系统如何安全重试');
  vm.runInContext("scheduleAuto('interviewer')", sandbox);
  runAutoTimer();
  assert.equal(sent.length, 1);
  assert.equal(state.queuedAuto, null);
});

test('stopping waits for the final queued transcription before releasing the client', async () => {
  const { sandbox, state } = createRenderer();
  let finishClose;
  state.dgSys = { close: () => new Promise((resolve) => (finishClose = resolve)) };
  const stopping = vm.runInContext('stopListening()', sandbox);
  assert.ok(state.stopPromise);
  assert.ok(state.dgSys, 'the client is retained while its final ASR drains');
  finishClose();
  await stopping;
  assert.equal(state.dgSys, null);
  assert.equal(state.stopPromise, null);
});
