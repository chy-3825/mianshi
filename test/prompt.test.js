'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildPrompt, EXTRACTION_SYSTEM, buildExtractionUser } = require('../src/main/prompt');

test('buildPrompt: explicit question mode includes the question and history', () => {
  const { systemInstruction, userText } = buildPrompt({
    question: 'What is a database index?',
    transcript: 'Interviewer: tell me about inference\nCandidate: sure',
    context: '',
    answerLanguage: 'en',
    maxChars: 500,
    profile: '',
  });
  assert.match(systemInstruction, /500/);
  assert.match(systemInstruction, /Answer in English\./);
  assert.match(userText, /What is a database index\?/);
  assert.match(userText, /对话历史/);
});

test('buildPrompt: extract mode (no question) instructs to find the latest question', () => {
  const { userText } = buildPrompt({
    question: '',
    transcript: 'Interviewer: what is a KV cache?',
    context: '',
    answerLanguage: 'auto',
    maxChars: 500,
  });
  assert.match(userText, /最新\/当前/);
  assert.doesNotMatch(userText, /需要回答的问题/); // no explicit-question block
});

test('buildPrompt: maxChars and profile are injected', () => {
  const { systemInstruction } = buildPrompt({
    question: 'q',
    transcript: '',
    context: '',
    answerLanguage: 'zh',
    maxChars: 250,
    profile: 'You are interviewing at Example Company.',
  });
  assert.match(systemInstruction, /250 字符以内/);
  assert.match(systemInstruction, /You are interviewing at Example Company\./);
  assert.match(systemInstruction, /请用中文作答/);
});

test('buildPrompt: knowledge-base context is included when provided', () => {
  const { userText } = buildPrompt({
    question: 'q',
    transcript: '',
    context: 'RESUME: senior engineer',
    answerLanguage: 'en',
    maxChars: 500,
  });
  assert.match(userText, /RESUME: senior engineer/);
});

test('buildPrompt: job description is injected as tailoring context', () => {
  const { systemInstruction } = buildPrompt({
    question: 'q',
    transcript: '',
    context: '',
    answerLanguage: 'en',
    maxChars: 500,
    jobDescription: 'Backend Engineer — must know SQL and distributed systems.',
  });
  assert.match(systemInstruction, /目标岗位 JD/);
  assert.match(systemInstruction, /must know SQL and distributed systems/);
});

test('extraction prompt helpers', () => {
  assert.match(EXTRACTION_SYSTEM, /ONLY that question/);
  assert.match(buildExtractionUser('Interviewer: hi'), /Interviewer: hi/);
  assert.match(buildExtractionUser('x'), /current core question is:/);
});

test('general theory answers keep prerequisites without unrelated project disclaimers', () => {
  const { systemInstruction } = buildPrompt({
    question: '事务隔离级别有哪些？',
    context: '',
    maxChars: 500,
  });
  assert.match(systemInstruction, /没有询问个人项目或经历时/);
  assert.match(systemInstruction, /近似公式要说明近似条件/);
});

test('multi-category questions preserve order and exclude already specified categories', () => {
  const { userText } = buildPrompt({
    question: '账户、搜索和报表模块分别负责什么？',
    context: '项目分类资料',
    maxChars: 500,
  });
  assert.match(userText, /按子问题顺序逐项回答/);
  assert.match(userText, /排除前面已经指定的类别/);
  assert.match(userText, /不按名称或常识补齐/);
});

test('theory questions asking which scenarios do not inherit project enumeration constraints', () => {
  const { userText } = buildPrompt({
    question: '乐观锁和悲观锁分别适用于哪些场景？',
    context: '',
    maxChars: 500,
  });
  assert.doesNotMatch(userText, /资料已明确列出|归属|不按名称或常识补齐/);
});
