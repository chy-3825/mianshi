'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isQuestion,
  isNearDuplicateQuestion,
  selectCurrentQuestion,
  AutoQuestionBuffer,
} = require('../src/renderer/question-detection');

const sampleAsrQuestions = [
  '请介绍一下你设计的消息队列架构，为什么采用这种方案。',
  '在服务中如何避免重复处理请求并保证数据一致性。',
  '系统发生故障后如何恢复服务状态并确保数据完整？',
  '用户连续提交相同请求时，如何防止创建重复记录？',
  '你如何设计缓存失效策略，避免读取到过期数据？',
];

test('sample Chinese ASR questions are actionable, including questions without question marks', () => {
  assert.equal(/[?？]/.test(sampleAsrQuestions[0]), false);
  assert.equal(/[?？]/.test(sampleAsrQuestions[1]), false);
  for (const question of sampleAsrQuestions) {
    assert.equal(isQuestion(question), true, question);
    assert.equal(selectCurrentQuestion([question]), question);
  }
});

test('short Chinese questions and requests work without a length floor', () => {
  for (const question of ['为什么？', '怎么做', '重连呢', '讲讲缓存', '请举例', '能说说吗']) {
    assert.equal(isQuestion(question), true, question);
  }
  for (const statement of ['好的。', '我们接下来聊项目。', '我先介绍一下背景。']) {
    assert.equal(isQuestion(statement), false, statement);
  }
});

test('only the current buffered turn is selected across consecutive follow-ups', () => {
  const buffer = new AutoQuestionBuffer();
  buffer.append('请介绍一下消息队列的整体架构。');
  buffer.append('为什么采用这种方案。', { segmentId: 2 });
  const first = buffer.take();
  assert.match(first.question, /整体架构/);
  assert.match(first.question, /采用这种方案/);
  assert.equal(first.timing.segmentId, 2);

  buffer.append('这是前一个问题的补充说明。');
  assert.equal(buffer.take(), null, 'an old question cannot trigger from a new statement');
  buffer.append('那请求重试呢？');
  assert.equal(buffer.take().question, '那请求重试呢？');
});

test('a non-question lead-in is retained with the current short question', () => {
  assert.equal(
    selectCurrentQuestion(['关于服务架构的设计。', '怎么防止重复请求？']),
    '关于服务架构的设计。 怎么防止重复请求？',
  );
  assert.equal(isQuestion('Tell me about the architecture'), true);
});

test('near-duplicate ASR wording is one question, but a follow-up is new', () => {
  assert.equal(
    isNearDuplicateQuestion(
      '请求失败后，如何安全地重试？',
      '请求失败后如何安全地重试',
    ),
    true,
  );
  assert.equal(
    isNearDuplicateQuestion('请介绍项目的整体架构。', '请求超时后怎么处理？'),
    false,
  );
});
