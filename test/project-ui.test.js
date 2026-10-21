'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const QuestionDetection = require('../src/renderer/question-detection');

const appSource = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');

function createRenderer(api, confirm = () => true) {
  const elements = new Map();
  class FakeElement {
    constructor() {
      this.children = [];
      this.attributes = {};
      this.value = '';
      this.textContent = '';
      this.disabled = false;
      this.classes = new Set(['hidden']);
      this.classList = {
        add: (name) => this.classes.add(name),
        remove: (name) => this.classes.delete(name),
        toggle: (name, force) => {
          if (force === undefined ? !this.classes.has(name) : force) this.classes.add(name);
          else this.classes.delete(name);
        },
        contains: (name) => this.classes.has(name),
      };
    }
    set innerHTML(value) {
      this.children = [];
      this._innerHTML = value;
    }
    append(...children) {
      this.children.push(...children);
    }
    appendChild(child) {
      this.children.push(child);
    }
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
    focus() {}
  }
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  };
  const sandbox = {
    window: { QuestionDetection, api, confirm, addEventListener() {} },
    document: { getElementById: element, createElement: () => new FakeElement() },
    console,
    setTimeout: () => 1,
    clearTimeout() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(appSource, sandbox);
  return { sandbox, element };
}

test('importing a folder renders README project and saves deduplicated keywords', async () => {
  const project = {
    id: 'project-1',
    name: 'Demo App',
    keywords: ['Demo App'],
    readmeName: 'README.md',
    chars: 1234,
  };
  const saved = [];
  const { sandbox, element } = createRenderer({
    pickProjectFolder: async () => ({ canceled: false, project, projects: [project] }),
    setProjectKeywords: async (payload) => {
      saved.push(payload);
      return [{ ...project, keywords: payload.keywords }];
    },
  });

  await vm.runInContext('importProjectFolder()', sandbox);
  assert.equal(element('projectList').children.length, 1);
  assert.equal(element('projectList').children[0].children[0].children[0].textContent, 'Demo App');
  assert.equal(element('projectKeywordsModal').classList.contains('hidden'), false);
  assert.equal(element('projectKeywordInput').value, 'Demo App');

  element('projectKeywordInput').value = 'demoapp，Demo App、服务管理\ndemoapp';
  await vm.runInContext('saveProjectKeywords()', sandbox);
  assert.equal(
    JSON.stringify(saved[0]),
    JSON.stringify({
      projectId: 'project-1',
      keywords: ['demoapp', 'Demo App', '服务管理'],
    }),
  );
  assert.equal(element('projectKeywordsModal').classList.contains('hidden'), true);
  assert.equal(
    element('projectList').children[0].children[0].children[2].textContent,
    '关键词：demoapp、Demo App、服务管理',
  );
});

test('removing a project requires confirmation and does not touch file documents', async () => {
  const project = { id: 'project-2', name: 'Demo App', keywords: ['Demo App'] };
  let approved = false;
  let removed = 0;
  const { sandbox, element } = createRenderer(
    {
      listProjects: async () => [project],
      removeProject: async (id) => {
        assert.equal(id, project.id);
        removed++;
        return [];
      },
    },
    () => approved,
  );
  element('docList').appendChild({ name: 'existing-file' });
  await vm.runInContext('refreshProjects()', sandbox);
  await vm.runInContext('removeProject({ id: "project-2", name: "Demo App" })', sandbox);
  assert.equal(removed, 0);
  approved = true;
  await vm.runInContext('removeProject({ id: "project-2", name: "Demo App" })', sandbox);
  assert.equal(removed, 1);
  assert.match(element('projectList').children[0].textContent, /暂无项目/);
  assert.equal(element('docList').children.length, 1);
});

test('failed folder import keeps existing project list and re-enables the button', async () => {
  const project = { id: 'project-3', name: 'existing', keywords: ['existing'] };
  const { sandbox, element } = createRenderer({
    listProjects: async () => [project],
    pickProjectFolder: async () => {
      throw new Error('未找到 README');
    },
  });
  await vm.runInContext('refreshProjects()', sandbox);
  await vm.runInContext('importProjectFolder()', sandbox);
  assert.equal(element('projectList').children.length, 1);
  assert.equal(element('importProjectBtn').disabled, false);
  assert.match(element('toast').textContent, /未找到 README/);
  assert.equal(element('toast').classList.contains('error'), true);
});
