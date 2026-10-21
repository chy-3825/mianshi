'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const store = require('../src/main/store');

const demoReadme = `# Demo App
这是一个包含账户、搜索和报表模块的服务管理平台。
账户模块使用会话令牌恢复用户状态。
报表支持导出为 CSV 或 PDF。
网络请求失败后可以安全重试。`;

test('project import keeps old documents separate, and reimport preserves edited keywords', () => {
  store._reset();
  store.add('resume.txt', '普通文件资料只用于非项目问题。');
  const first = store.upsertProject({
    rootPath: '/tmp/Demo App',
    readmePath: '/tmp/Demo App/README.md',
    name: 'Demo App',
    text: demoReadme,
    keywords: ['demoapp', 'Demo App', '服务管理'],
  });
  assert.deepEqual(Object.keys(first).sort(), ['chars', 'id', 'keywords', 'name', 'readmeName']);
  assert.equal(first.readmeName, 'README.md');
  assert.deepEqual(first.keywords, ['demoapp', 'Demo App']);
  assert.equal(store.summary().length, 1);
  assert.equal(store.listProjects().length, 1);

  first.keywords.push('mutated by caller');
  assert.equal(store.listProjects()[0].keywords.includes('mutated by caller'), false);
  store.setProjectKeywords(first.id, ['Demo App', '模块']);
  const second = store.upsertProject({
    rootPath: '/tmp/Demo App',
    readmePath: '/tmp/Demo App/README.md',
    name: 'Demo App',
    text: '新版 README：账户、搜索和报表模块。',
    keywords: ['suggested keyword should not replace manual edits'],
  });
  assert.equal(second.id, first.id);
  assert.deepEqual(second.keywords, ['Demo App', '模块']);
  assert.equal(store.listProjects().length, 1);
  assert.match(store.buildContext({ question: 'Demo App 有哪些模块？' }), /新版 README/);
  assert.doesNotMatch(store.buildContext({ question: 'Demo App 有哪些模块？' }), /旧版账户说明/);

  store.clear();
  assert.deepEqual(store.summary(), []);
  assert.equal(store.listProjects().length, 1, 'clearing uploaded files must not delete projects');
  assert.deepEqual(store.removeProject(first.id), []);
  assert.equal(store.buildContext({ question: 'Demo App 有哪些模块？' }), '');
});

test('project routing prioritizes the current question and avoids stale-project leakage', () => {
  store._reset();
  store.add('ordinary.md', '普通资料的标记：ORDINARY_ONLY。');
  store.upsertProject({
    rootPath: '/tmp/Demo App',
    readmePath: '/tmp/Demo App/README.md',
    name: 'Demo App',
    text: demoReadme,
    keywords: ['Demo App', '服务管理'],
  });
  const oldTranscript = 'Interviewer: Demo App 的账户模块如何恢复用户状态？';

  assert.equal(store.routeProject({ question: 'Demo App 有哪些模块？' }).name, 'Demo App');
  assert.equal(store.routeProject({ question: '搜索模块如何工作？' }).name, 'Demo App');
  assert.match(store.buildContext({ question: '搜索模块如何工作？' }), /搜索模块/);
  assert.equal(
    store.routeProject({ question: '网络请求失败时怎么重试？' }).name,
    'Demo App',
    'multiple relevant README concepts should route without an explicit project name',
  );
  assert.equal(
    store.routeProject({ question: '什么是光合作用？', transcript: oldTranscript }),
    null,
  );
  assert.equal(
    store.routeProject({
      question: '数据库索引如何工作？事务隔离级别有哪些？',
      transcript: oldTranscript,
    }),
    null,
  );
  assert.equal(
    store.routeProject({
      question: '什么是对流层？',
      transcript: oldTranscript,
    }),
    null,
  );
  assert.equal(
    store.buildContext({ question: '什么是光合作用？', transcript: oldTranscript }),
    '',
    'an unrelated ordinary document should not be sent merely to fill the context budget',
  );
  assert.doesNotMatch(
    store.buildContext({ question: '什么是光合作用？', transcript: oldTranscript }),
    /Demo App/,
  );
  assert.equal(
    store.routeProject({ question: '这个项目有哪些模块？', transcript: oldTranscript }).name,
    'Demo App',
  );
  assert.equal(
    store.routeProject({ question: '这个项目还能怎么扩展？', transcript: oldTranscript }).name,
    'Demo App',
  );
  assert.equal(
    store.routeProject({
      question: '这个项目如何实现？',
      transcript: 'Interviewer: Demo App 的架构是什么？',
    }).name,
    'Demo App',
    'speaker prefixes must not hide a project alias',
  );

  store.upsertProject({
    rootPath: '/tmp/MetricsCore',
    readmePath: '/tmp/MetricsCore/README.md',
    name: 'MetricsCore',
    text: '指标服务通过批处理聚合数据并生成每日汇总。',
    keywords: ['MetricsCore'],
  });
  assert.equal(
    store.routeProject({ question: 'MetricsCore 如何生成每日汇总？', transcript: oldTranscript }).name,
    'MetricsCore',
    'an explicit keyword in the new question must beat an old transcript keyword',
  );
  assert.equal(
    store.routeProject({
      question: '这个项目还支持什么？',
      transcript: 'Interviewer: Demo App 是什么？\nInterviewer: MetricsCore 是什么？',
    }).name,
    'MetricsCore',
    'follow-ups use the most recent explicit project mention',
  );
  store._reset();
});

test('project follow-ups inherit the referenced project before matching a different README', () => {
  store._reset();
  store.upsertProject({
    rootPath: '/tmp/demo-followup',
    readmePath: '/tmp/demo-followup/README.md',
    name: 'Demo App',
    text: demoReadme,
    keywords: ['Demo App'],
  });
  store.upsertProject({
    rootPath: '/tmp/shop-followup',
    readmePath: '/tmp/shop-followup/README.md',
    name: 'ReportKit',
    text: '# ReportKit 报表\n数据报告按模板生成并导出为 CSV，任务可以异步处理。',
    keywords: ['报表'],
  });
  const transcript = 'Interviewer: 介绍 Demo App\nCandidate: 它是一个服务管理平台。';
  assert.equal(
    store.routeProject({ question: '这个项目如何保证数据一致性？', transcript }).name,
    'Demo App',
  );
  const context = store.buildContext({ question: '这个项目如何保证数据一致性？', transcript });
  assert.match(context, /项目 Demo App/);
  assert.doesNotMatch(context, /异步处理|ReportKit/);
  assert.equal(
    store.routeProject({ question: '这个 ReportKit 项目如何导出报表？', transcript }).name,
    'ReportKit',
  );
  assert.equal(
    store.routeProject({ question: '报表如何异步生成？', transcript }).name,
    'ReportKit',
    'an independent question may match a new project',
  );
  assert.equal(
    store.routeProject({
      question: '这个项目采用什么方案？',
      transcript: `${transcript}\nInterviewer: ReportKit 是什么？`,
    }).name,
    'ReportKit',
  );
  store._reset();
});

test('context observers receive a summary once and cannot break answer preparation', () => {
  store._reset();
  store.upsertProject({
    rootPath: '/tmp/demo-observer',
    readmePath: '/tmp/demo-observer/README.md',
    name: 'Demo App',
    text: demoReadme,
  });
  const observed = [];
  const context = store.buildContext({
    question: 'Demo App 有哪些模块？',
    onProjectSelected(project) {
      observed.push(project);
      throw new Error('diagnostics unavailable');
    },
  });
  assert.equal(observed.length, 1);
  assert.equal(observed[0].name, 'Demo App');
  assert.equal('text' in observed[0], false);
  assert.equal('rootPath' in observed[0], false);
  assert.match(context, /账户模块/);
  store._reset();
});

function loadWithElectronUserData(dataDir) {
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return { app: { getPath: () => dataDir } };
    return originalLoad.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve('../src/main/store')];
    return require('../src/main/store');
  } finally {
    Module._load = originalLoad;
  }
}

test('projects persist beside old docs with private atomic writes and load old docs-only JSON', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-project-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userData = path.join(root, 'user-data');
  fs.mkdirSync(userData);
  const knowledgePath = path.join(userData, 'knowledge.json');
  fs.writeFileSync(
    knowledgePath,
    JSON.stringify({ docs: [{ id: 'doc_3', name: 'legacy.txt', text: '旧资料', chars: 3 }] }),
  );
  let persistent = loadWithElectronUserData(userData);
  assert.deepEqual(persistent.listProjects(), []);
  assert.equal(persistent.summary()[0].name, 'legacy.txt');
  const project = persistent.upsertProject({
    rootPath: path.join(root, 'Demo App'),
    readmePath: path.join(root, 'Demo App', 'README.md'),
    name: 'Demo App',
    text: demoReadme,
    keywords: ['Demo App'],
  });
  assert.equal(fs.statSync(knowledgePath).mode & 0o777, 0o600);
  const saved = JSON.parse(fs.readFileSync(knowledgePath, 'utf8'));
  assert.equal(saved.docs[0].name, 'legacy.txt');
  assert.equal(saved.projects[0].rootPath, path.join(root, 'Demo App'));

  persistent = loadWithElectronUserData(userData);
  assert.deepEqual(persistent.listProjects()[0], project);
  assert.equal(persistent.summary()[0].name, 'legacy.txt');

  const before = fs.readFileSync(knowledgePath, 'utf8');
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (destination === knowledgePath) {
      const error = new Error('private-data-must-not-appear');
      error.code = 'EIO';
      throw error;
    }
    return rename(source, destination);
  };
  try {
    assert.throws(
      () => persistent.setProjectKeywords(project.id, ['changed']),
      (error) => /保存知识库失败（EIO）/.test(error.message) && !/private-data/.test(error.message),
    );
  } finally {
    fs.renameSync = rename;
  }
  assert.deepEqual(persistent.listProjects()[0], project);
  assert.equal(fs.readFileSync(knowledgePath, 'utf8'), before);
  assert.equal(
    fs.readdirSync(userData).some((name) => name.endsWith('.tmp')),
    false,
  );
});
