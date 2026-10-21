'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  // 设置
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (partial) => ipcRenderer.invoke('save-settings', partial),
  logSessionEvent: (entry) => ipcRenderer.invoke('append-session-log', entry),
  clearSessionLog: () => ipcRenderer.invoke('clear-session-log'),

  // 资料
  pickDocuments: () => ipcRenderer.invoke('pick-documents'),
  listDocuments: () => ipcRenderer.invoke('list-documents'),
  removeDocument: (id) => ipcRenderer.invoke('remove-document', id),
  clearDocuments: () => ipcRenderer.invoke('clear-documents'),
  addTextDocument: (payload) => ipcRenderer.invoke('add-text-document', payload),
  pickProjectFolder: () => ipcRenderer.invoke('pick-project-folder'),
  listProjects: () => ipcRenderer.invoke('list-projects'),
  setProjectKeywords: (payload) => ipcRenderer.invoke('set-project-keywords', payload),
  removeProject: (id) => ipcRenderer.invoke('remove-project', id),
  pickJD: () => ipcRenderer.invoke('pick-jd'),

  // 权限
  ensureMicPermission: () => ipcRenderer.invoke('ensure-mic-permission'),
  getScreenPermission: () => ipcRenderer.invoke('get-screen-permission'),
  openScreenSettings: () => ipcRenderer.invoke('open-screen-settings'),
  transcribeLocal: (pcm, sampleRate, language, role, timing = {}) =>
    ipcRenderer.invoke('local-stt-transcribe', {
      pcm,
      sampleRate,
      language,
      role,
      sttId: timing.sttId,
      segmentId: timing.segmentId,
    }),
  warmLocalStt: () => ipcRenderer.invoke('local-stt-warm'),
  runSelfCheck: (options) => ipcRenderer.invoke('run-self-check', options || {}),

  // 生成答案
  generateAnswer: (payload) => ipcRenderer.send('generate-answer', payload),
  cancelGenerate: () => ipcRenderer.send('cancel-generate'),

  // 事件订阅
  onHotkeyGenerate: (cb) => {
    const h = () => cb();
    ipcRenderer.on('hotkey-generate', h);
    return () => ipcRenderer.removeListener('hotkey-generate', h);
  },
  onAnswerStart: (cb) => sub('answer-start', cb),
  onAnswerQuestion: (cb) => sub('answer-question', cb),
  onAnswerChunk: (cb) => sub('answer-chunk', cb),
  onAnswerTiming: (cb) => sub('answer-timing', cb),
  onAnswerDone: (cb) => sub('answer-done', cb),
  onAnswerError: (cb) => sub('answer-error', cb),
});

function sub(channel, cb) {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
}
