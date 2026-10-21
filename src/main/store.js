'use strict';

// 资料知识库：保存上传/粘贴文档的纯文本，作答时按问题选取相关片段。
// 持久化到 userData/knowledge.json —— 增/删/改/清空都会落盘，重启后仍在。
// 检索索引只在内存中构造，资料变更后自动失效。

const path = require('path');
const knowledge = require('./knowledge');
const { readPrivateFile, writePrivateJson, storageError } = require('./private-json');

// 在 Electron 主进程里能拿到 app；在纯 Node 单测里拿不到 → 自动退回内存模式（不落盘）。
let app = null;
try {
  app = require('electron').app;
} catch (_e) {
  /* not in electron */
}
const canPersist = () => !!(app && typeof app.getPath === 'function');
const filePath = () => path.join(app.getPath('userData'), 'knowledge.json');

let docs = null; // 懒加载： { id, name, text, chars }[]
let projects = null; // { id, rootPath, readmePath, name, text, keywords, chars }[]
let seq = 0;
let projectSeq = 0;
let index = null;
let projectIndexes = new Map();
let projectRouter = null;

function ensureLoaded() {
  if (docs !== null) return;
  let loadedDocs = [];
  let loadedProjects = [];
  let loadedSeq = 0;
  if (!canPersist()) {
    docs = loadedDocs;
    projects = loadedProjects;
    return;
  }
  try {
    const raw = readPrivateFile(filePath());
    if (raw !== null) {
      const data = JSON.parse(raw);
      if (
        !data ||
        !Array.isArray(data.docs) ||
        !data.docs.every(
          (doc) =>
            doc &&
            typeof doc.id === 'string' &&
            typeof doc.name === 'string' &&
            typeof doc.text === 'string',
        )
      ) {
        throw new Error('知识库数据格式错误');
      }
      loadedDocs = data.docs;
      if (data.projects !== undefined) {
        if (
          !Array.isArray(data.projects) ||
          !data.projects.every(
            (project) =>
              project &&
              typeof project.id === 'string' &&
              typeof project.rootPath === 'string' &&
              typeof project.readmePath === 'string' &&
              typeof project.name === 'string' &&
              typeof project.text === 'string' &&
              Array.isArray(project.keywords) &&
              project.keywords.every((keyword) => typeof keyword === 'string'),
          )
        ) {
          throw new Error('项目知识库数据格式错误');
        }
        loadedProjects = data.projects.map((project) => ({
          ...project,
          chars: project.text.length,
          keywords: normalizeKeywords(project.keywords),
        }));
      }
      loadedSeq = loadedDocs.reduce((m, d) => {
        const n = parseInt(String(d.id).replace(/\D/g, ''), 10) || 0;
        return Math.max(m, n);
      }, 0);
    }
  } catch (error) {
    throw storageError('读取知识库', error);
  }
  docs = loadedDocs;
  projects = loadedProjects;
  seq = loadedSeq;
  projectSeq = loadedProjects.reduce((m, project) => {
    const n = parseInt(String(project.id).replace(/\D/g, ''), 10) || 0;
    return Math.max(m, n);
  }, 0);
  index = null;
  projectIndexes = new Map();
  projectRouter = null;
}

function persist(nextDocs, nextProjects) {
  if (!canPersist()) return;
  try {
    writePrivateJson(filePath(), { docs: nextDocs, projects: nextProjects });
  } catch (error) {
    throw storageError('保存知识库', error);
  }
}

function add(name, text) {
  ensureLoaded();
  const clean = (text || '').trim();
  const id = `doc_${seq + 1}`;
  const nextDocs = [...docs, { id, name, text: clean, chars: clean.length }];
  persist(nextDocs, projects);
  docs = nextDocs;
  seq++;
  index = null;
  return summary();
}

// 更新某条资料的名称/内容（删了重加也行，这个用于原地更新）
function update(id, { name, text } = {}) {
  ensureLoaded();
  const position = docs.findIndex((x) => x.id === id);
  if (position !== -1) {
    const updated = { ...docs[position] };
    if (typeof name === 'string') updated.name = name;
    if (typeof text === 'string') {
      updated.text = text.trim();
      updated.chars = updated.text.length;
    }
    const nextDocs = [...docs];
    nextDocs[position] = updated;
    persist(nextDocs, projects);
    docs = nextDocs;
    index = null;
  }
  return summary();
}

function remove(id) {
  ensureLoaded();
  const nextDocs = docs.filter((d) => d.id !== id);
  persist(nextDocs, projects);
  docs = nextDocs;
  index = null;
  return summary();
}

function clear() {
  ensureLoaded();
  // 界面的“清空文件资料”只作用于旧式上传文档；项目有独立删除入口。
  persist([], projects);
  docs = [];
  index = null;
  return summary();
}

function normalizeKeywords(keywords) {
  if (!Array.isArray(keywords)) throw new TypeError('项目关键词必须是数组');
  const result = [];
  const seen = new Set();
  for (const item of keywords) {
    if (typeof item !== 'string') throw new TypeError('项目关键词必须是文本');
    const keyword = item.trim();
    const normalized = keyword.normalize('NFKC').toLowerCase();
    if (!keyword || seen.has(normalized)) continue;
    result.push(keyword);
    seen.add(normalized);
  }
  return result;
}

function projectSummary(project) {
  return {
    id: project.id,
    name: project.name,
    keywords: [...project.keywords],
    readmeName: path.basename(project.readmePath),
    chars: project.chars,
  };
}

function listProjects() {
  ensureLoaded();
  return projects.map(projectSummary);
}

function upsertProject({ rootPath, readmePath, name, text, keywords = [] } = {}) {
  ensureLoaded();
  if (
    typeof rootPath !== 'string' ||
    !rootPath.trim() ||
    typeof readmePath !== 'string' ||
    !readmePath.trim() ||
    typeof text !== 'string'
  ) {
    throw new TypeError('项目路径、README 路径和内容必须有效');
  }
  const normalizedRoot = path.resolve(rootPath);
  const normalizedReadme = path.resolve(readmePath);
  const cleanText = text.trim();
  const existing = projects.find((project) => project.rootPath === normalizedRoot);
  const project = {
    id: existing ? existing.id : `project_${projectSeq + 1}`,
    rootPath: normalizedRoot,
    readmePath: normalizedReadme,
    name: typeof name === 'string' && name.trim() ? name.trim() : path.basename(normalizedRoot),
    text: cleanText,
    // 重新导入只刷新 README；用户手工编辑的关键词由专用 API 维护。
    keywords: existing ? existing.keywords : normalizeKeywords(keywords),
    chars: cleanText.length,
  };
  const nextProjects = existing
    ? projects.map((item) => (item.id === existing.id ? project : item))
    : [...projects, project];
  persist(docs, nextProjects);
  projects = nextProjects;
  if (!existing) projectSeq++;
  projectIndexes.set(project.id, makeProjectIndex(project));
  projectRouter = knowledge.buildProjectRouter(projects, projectRouter || []);
  return projectSummary(project);
}

function setProjectKeywords(id, keywords) {
  ensureLoaded();
  const position = projects.findIndex((project) => project.id === id);
  if (position < 0) throw new Error('未找到项目知识库');
  const project = { ...projects[position], keywords: normalizeKeywords(keywords) };
  const nextProjects = [...projects];
  nextProjects[position] = project;
  persist(docs, nextProjects);
  projects = nextProjects;
  projectRouter = knowledge.buildProjectRouter(projects, projectRouter || []);
  return projectSummary(project);
}

function removeProject(id) {
  ensureLoaded();
  const nextProjects = projects.filter((project) => project.id !== id);
  if (nextProjects.length === projects.length) return listProjects();
  persist(docs, nextProjects);
  projects = nextProjects;
  projectIndexes.delete(id);
  projectRouter = knowledge.buildProjectRouter(projects, projectRouter || []);
  return listProjects();
}

function selectedProject(options) {
  if (!projectRouter) projectRouter = knowledge.buildProjectRouter(projects);
  return knowledge.selectProject(projectRouter, options);
}

function routeProject({ question = '', transcript = '' } = {}) {
  ensureLoaded();
  const project = selectedProject({ question, transcript });
  return project ? projectSummary(project) : null;
}

function summary() {
  ensureLoaded();
  return docs.map((d) => ({ id: d.id, name: d.name, chars: d.chars }));
}

function makeProjectIndex(project) {
  return knowledge.buildIndex([
    { name: `项目 ${project.name} / ${path.basename(project.readmePath)}`, text: project.text },
  ]);
}

/**
 * 按问题选取资料片段。兼容旧调用 buildContext(60000)。
 * 推荐 buildContext({ maxChars: 60000, question })。
 */
function buildContext(maxChars = 60000, question = '') {
  ensureLoaded();
  const options = maxChars && typeof maxChars === 'object' ? maxChars : { maxChars, question };
  const project = selectedProject(options);
  if (typeof options.onProjectSelected === 'function') {
    try {
      options.onProjectSelected(project ? projectSummary(project) : null);
    } catch (_error) {
      // 诊断观察者不能中断作答。
    }
  }
  if (project) {
    let projectIndex = projectIndexes.get(project.id);
    if (!projectIndex) {
      projectIndex = makeProjectIndex(project);
      projectIndexes.set(project.id, projectIndex);
    }
    const normalizedName = project.name.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    const aliases = [
      project.name,
      ...project.keywords.filter(
        (keyword) => keyword.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '') === normalizedName,
      ),
    ];
    return knowledge.buildKnowledgeContext(projectIndex, {
      ...options,
      queryAliases: aliases,
      projectName: project.name,
    });
  }
  if (docs.length === 0) return '';
  if (!index) index = knowledge.buildIndex(docs);
  return knowledge.buildKnowledgeContext(index, options);
}

// 仅供单测：重置内存状态
function _reset() {
  docs = [];
  projects = [];
  seq = 0;
  projectSeq = 0;
  index = null;
  projectIndexes = new Map();
  projectRouter = null;
}

module.exports = {
  add,
  update,
  remove,
  clear,
  summary,
  upsertProject,
  setProjectKeywords,
  listProjects,
  removeProject,
  routeProject,
  buildContext,
  _reset,
};
