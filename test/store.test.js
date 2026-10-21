'use strict';

const test = require('node:test');
const assert = require('node:assert');
const store = require('../src/main/store');

test('store: add / summary / buildContext / remove / clear', () => {
  store.clear();
  assert.deepEqual(store.summary(), []);

  const s1 = store.add('resume.txt', 'I am a backend engineer.');
  assert.equal(s1.length, 1);
  assert.equal(s1[0].name, 'resume.txt');
  assert.equal(s1[0].chars, 'I am a backend engineer.'.length);

  store.add('jd.txt', 'We need a forward deployed engineer.');
  const ctx = store.buildContext(60000);
  assert.match(ctx, /resume\.txt/);
  assert.match(ctx, /forward deployed engineer/);

  const id = store.summary()[0].id;
  const after = store.remove(id);
  assert.equal(after.length, 1);
  assert.equal(after[0].name, 'jd.txt');

  store.clear();
  assert.equal(store.buildContext(60000), '');
});

test('store: update changes a doc in place', () => {
  store.clear();
  store.add('a.txt', 'old');
  const id = store.summary()[0].id;
  const after = store.update(id, { name: 'b.txt', text: 'new longer text' });
  assert.equal(after[0].name, 'b.txt');
  assert.equal(after[0].chars, 'new longer text'.length);
  assert.match(store.buildContext(60000), /new longer text/);
  store.clear();
});

test('store: buildContext truncates when over the limit', () => {
  store.clear();
  store.add('big.txt', 'x'.repeat(1000));
  const ctx = store.buildContext(200);
  assert.ok(ctx.length <= 200 + 40);
  assert.match(ctx, /已截断/);
  store.clear();
});

test('store: question retrieves a relevant passage near the end of a large document', () => {
  store.clear();
  store.add(
    'service-architecture.md',
    `${'管理界面展示处理结果。'.repeat(7000)}\n\n请求超时后，客户端根据请求 ID 安全重试，并重新读取最新状态。`,
  );
  store.add('old-notes.md', '管理界面展示用户名称。');

  const ctx = store.buildContext({
    maxChars: 350,
    question: '请求超时后如何安全重试？',
  });
  assert.ok(ctx.length <= 350);
  assert.match(ctx, /请求 ID 安全重试/);
  assert.match(ctx, /来源：Demo App-architecture\.md/);
  store.clear();
});

test('store: context identifies static sources and does not treat old test counts as current', () => {
  store.clear();
  store.add('project-report-2024.md', '旧报告记录 512 项测试。');
  store.add('src/room.js', 'function reconnectPlayer(token) { return token; }');

  const ctx = store.buildContext({ maxChars: 1000, question: '目前有多少项测试？' });
  assert.match(ctx, /来源：project-report-2024\.md/);
  assert.match(ctx, /静态导入资料/);
  assert.match(ctx, /测试数量.*不能仅凭旧报告确认/);
  assert.match(ctx, /没有实际运行结果就不要报具体当前数字/);
  store.clear();
});

test('store: updating a document refreshes the retrieval index', () => {
  store.clear();
  store.add('technical-notes.md', '身份伪造通过连接绑定处理。');
  store.buildContext({ maxChars: 500, question: '如何防止身份伪造？' });
  const id = store.summary()[0].id;
  store.update(id, { text: '请求超时后可按请求 ID 安全重试。' });
  const ctx = store.buildContext({ maxChars: 500, question: '如何处理请求超时？' });
  assert.match(ctx, /会话令牌恢复/);
  assert.doesNotMatch(ctx, /身份伪造通过连接绑定/);
  store.clear();
});
