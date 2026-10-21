'use strict';

const path = require('path');
const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  globalShortcut,
  session,
  desktopCapturer,
  systemPreferences,
  shell,
} = require('electron');

const settingsStore = require('./settings');
const store = require('./store');
const docs = require('./documents');
const { readProjectFolder } = require('./projectFolder');
const llm = require('./llm');
const gemini = require('./gemini');
const openaiCompat = require('./openaiCompat');
const prompt = require('./prompt');
const questionDetection = require('../renderer/question-detection');
const { PROVIDERS } = require('./config');
const localStt = require('./localStt');
const { buildAsrContext } = require('./stt-context');
const { checkAnswerCompleteness } = require('./answer-quality');
const selfCheck = require('./selfCheck');
const sessionLogger = require('./sessionLogger');

// 按当前 Provider（config.js 注册表）解析出：流式实现 / Key / baseURL / 模型链
function resolveProvider(s) {
  const id = s.provider && PROVIDERS[s.provider] ? s.provider : 'custom';
  const p = PROVIDERS[id];
  const model = ((s[p.modelField] || '') + '').trim() || p.defaultModel;
  const models = [model, ...(p.fallbacks || [])].filter((m, i, a) => a.indexOf(m) === i);
  return {
    id,
    label: p.label,
    type: p.type,
    needsKey: !!p.keyField,
    apiKey: p.keyField ? s[p.keyField] || '' : '',
    baseURL: p.baseURLField ? s[p.baseURLField] || p.baseURL : p.baseURL,
    models,
    streamFn: p.type === 'gemini' ? gemini.generateAnswerStream : openaiCompat.generateAnswerStream,
  };
}

// 固定 app 名，保证 dev 运行与打包后的 .app 使用同一份 userData/settings.json
app.setName('interview-copilot');

let mainWindow = null;
let startupSettingsError = null;
let currentSettings;
try {
  currentSettings = settingsStore.load();
} catch (error) {
  // 损坏的设置不能静默覆盖，也不应让整个桌面程序在创建窗口前直接崩溃。
  startupSettingsError = error.message;
  currentSettings = { ...settingsStore.DEFAULTS };
}
let activeGen = null; // { id, controller }
const diagnosticRunId = randomUUID();

function recordSession(entry) {
  if (currentSettings.diagnosticLogging === false) return false;
  try {
    return sessionLogger.appendSessionLog(
      app.getPath('userData'),
      { ...entry, sessionId: diagnosticRunId },
      currentSettings,
    );
  } catch (error) {
    // 写日志失败不能中断录音或回答，也不能把可能含敏感信息的错误详情再打到控制台。
    console.warn('[session-log] write failed', error.code || error.name || 'unknown');
    return false;
  }
}

function createWindow() {
  const smoke = !!process.env.INTERVIEW_SMOKE;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: !smoke,
    backgroundColor: '#0f1117',
    title: '实时面试助手',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (smoke) {
    mainWindow.webContents.on('did-finish-load', () => {
      console.log('[smoke] window loaded OK');
      app.quit();
    });
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
      console.error('[smoke] load failed', code, desc);
      process.exit(1);
    });
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      console.log('[renderer]', message);
    });
  }

  // 截图模式：注入一段演示对话，截取窗口写到 assets/screenshot.png 后退出（仅用于生成 README 图）。
  if (process.env.INTERVIEW_SCREENSHOT) {
    mainWindow.webContents.on('did-finish-load', () => {
      // 等 init() 跑完再注入演示内容，避免被 showEmptyState 覆盖。
      setTimeout(async () => {
        try {
          const fs = require('fs');
          await mainWindow.webContents.executeJavaScript(require('./_screenshotDemo').demoJs());
          await new Promise((r) => setTimeout(r, 350));
          const img = await mainWindow.webContents.capturePage();
          const out = path.join(__dirname, '..', '..', 'assets', 'screenshot.png');
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, img.toPNG());
          console.log('[screenshot] wrote', out);
        } catch (e) {
          console.error('[screenshot] failed', e);
        }
        app.quit();
      }, 1000);
    });
  }

  // GIF 模式：按 _gifDemo 的时间线逐帧截图，用 ffmpeg 合成 assets/demo.gif（需要 ffmpeg）。
  if (process.env.INTERVIEW_GIF) {
    mainWindow.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        const fs = require('fs');
        const os = require('os');
        const { spawnSync } = require('child_process');
        try {
          const { steps } = require('./_gifDemo');
          const tmp = path.join(os.tmpdir(), 'ic-gif-frames');
          fs.rmSync(tmp, { recursive: true, force: true });
          fs.mkdirSync(tmp, { recursive: true });
          let n = 0;
          for (const s of steps()) {
            await mainWindow.webContents.executeJavaScript(s.js);
            for (let h = 0; h < (s.hold || 1); h++) {
              await new Promise((r) => setTimeout(r, 50));
              const img = await mainWindow.webContents.capturePage();
              fs.writeFileSync(
                path.join(tmp, `f_${String(n++).padStart(4, '0')}.png`),
                img.toPNG(),
              );
            }
          }
          const out = path.join(__dirname, '..', '..', 'assets', 'demo.gif');
          fs.mkdirSync(path.dirname(out), { recursive: true });
          const vf =
            'scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer';
          const r = spawnSync(
            'ffmpeg',
            [
              '-y',
              '-framerate',
              '9',
              '-i',
              path.join(tmp, 'f_%04d.png'),
              '-vf',
              vf,
              '-loop',
              '0',
              out,
            ],
            { encoding: 'utf8' },
          );
          if (r.status === 0) console.log('[gif] wrote', out, `(${n} frames)`);
          else
            console.error(
              '[gif] ffmpeg failed',
              (r.stderr || r.error || '').toString().slice(-600),
            );
        } catch (e) {
          console.error('[gif] failed', e);
        }
        app.quit();
      }, 1000);
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 允许渲染进程通过 getDisplayMedia 采集系统声音（面试官）。
function setupDisplayMediaLoopback() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      // macOS 13+ : audio: 'loopback' 直接抓系统声音（需要「屏幕录制」权限）。
      // getSources 失败几乎都是没授予屏幕录制权限——安静地拒绝，由渲染层引导用户去授权。
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        if (sources && sources.length) {
          callback({ video: sources[0], audio: 'loopback' });
        } else {
          console.warn('No screen sources (grant Screen Recording permission for system audio).');
          callback({});
        }
      } catch (_e) {
        console.warn('System-audio capture unavailable — grant Screen Recording permission.');
        callback({});
      }
    },
    { useSystemPicker: false },
  );
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  const key = currentSettings.hotkey || 'Control+A';
  try {
    const ok = globalShortcut.register(key, () => {
      if (mainWindow) mainWindow.webContents.send('hotkey-generate');
    });
    if (!ok) console.warn(`热键 ${key} 注册失败（可能被占用）`);
    return ok;
  } catch (e) {
    console.error('注册热键出错:', e);
    return false;
  }
}

// ---------- IPC ----------

ipcMain.handle('get-settings', () => currentSettings);

ipcMain.handle('save-settings', (_e, partial) => {
  currentSettings = settingsStore.save(partial || {});
  registerHotkey();
  return currentSettings;
});

ipcMain.handle('append-session-log', (_e, entry) => recordSession(entry));
ipcMain.handle('clear-session-log', () => {
  try {
    return sessionLogger.clearSessionLog(app.getPath('userData'));
  } catch (error) {
    console.warn('[session-log] clear failed', error.code || error.name || 'unknown');
    return false;
  }
});

ipcMain.handle('list-documents', () => store.summary());

ipcMain.handle('list-projects', () => store.listProjects());

ipcMain.handle('pick-project-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择包含 README 的项目文件夹',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true, projects: store.listProjects() };
  }
  const folder = readProjectFolder(result.filePaths[0]);
  const project = store.upsertProject({
    rootPath: folder.rootPath,
    readmePath: folder.readmePath,
    name: folder.name,
    text: folder.text,
    keywords: folder.suggestedKeywords,
  });
  return { canceled: false, project, projects: store.listProjects() };
});

ipcMain.handle('set-project-keywords', (_e, { projectId, keywords }) => {
  store.setProjectKeywords(projectId, keywords);
  return store.listProjects();
});

ipcMain.handle('remove-project', (_e, projectId) => store.removeProject(projectId));

ipcMain.handle('remove-document', (_e, id) => store.remove(id));

ipcMain.handle('clear-documents', () => store.clear());
function currentAsrContext() {
  try {
    return buildAsrContext(currentSettings, store.listProjects()).prompt;
  } catch (_error) {
    // A corrupt or inaccessible knowledge file must not break transcription.
    return buildAsrContext(currentSettings).prompt;
  }
}
ipcMain.handle(
  'local-stt-transcribe',
  async (_e, { pcm, sampleRate, language, role, sttId, segmentId }) => {
    return localStt.transcribe(currentSettings, new Uint8Array(pcm), sampleRate, language, {
      role,
      context: currentAsrContext(),
      onTiming: (timing) => recordSession({ event: 'asr_timing', sttId, segmentId, ...timing }),
    });
  },
);
ipcMain.handle('local-stt-warm', async () => {
  await localStt.warm(currentSettings);
  return true;
});
ipcMain.handle('run-self-check', (_e, options = {}) =>
  selfCheck.runSelfCheck({
    settings: currentSettings,
    localStt,
    resolveProvider,
    generateWithFallback: llm.generateWithFallback,
    pcm: options.pcm,
    sampleRate: options.sampleRate,
    audio: options.audio,
    asrContext: currentAsrContext(),
  }),
);

ipcMain.handle('pick-documents', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择面试资料（简历 / JD / 笔记等）',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '文档', extensions: ['txt', 'md', 'markdown', 'pdf', 'docx', 'json', 'csv', 'log'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (result.canceled) return { canceled: true, docs: store.summary() };

  const errors = [];
  for (const filePath of result.filePaths) {
    try {
      const text = await docs.parseFile(filePath);
      store.add(path.basename(filePath), text);
    } catch (e) {
      errors.push(`${path.basename(filePath)}: ${e.message}`);
    }
  }
  return { canceled: false, docs: store.summary(), errors };
});

// 添加手动粘贴的资料文本
ipcMain.handle('add-text-document', (_e, { name, text }) => {
  store.add(name || '手动输入', text || '');
  return store.summary();
});

// 选择并解析一个 JD 文件，返回纯文本（持久化由设置完成）
ipcMain.handle('pick-jd', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择岗位 JD 文件',
    properties: ['openFile'],
    filters: [
      { name: '文档', extensions: ['txt', 'md', 'markdown', 'pdf', 'docx', 'json'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  try {
    const text = await docs.parseFile(result.filePaths[0]);
    return { name: path.basename(result.filePaths[0]), text };
  } catch (e) {
    return { name: '', text: '', error: e.message };
  }
});

// 取消正在进行的生成
ipcMain.on('cancel-generate', () => {
  if (activeGen) {
    try {
      activeGen.controller.abort();
    } catch (_e) {
      /* ignore */
    }
    activeGen = null;
  }
});

// 生成答案（流式）
ipcMain.on('generate-answer', async (_e, { reqId, question, transcript }) => {
  const requestStartedAt = Date.now();
  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, { reqId, ...payload });
    }
  };

  let q = (question || '').trim();
  const tr = (transcript || '').trim();
  if (!q && !tr) {
    recordSession({
      event: 'answer_error',
      reqId,
      reason: 'empty_input',
      message: '没有识别到对话内容，请先开始监听，或在问题框手动输入。',
    });
    send('answer-error', { message: '没有识别到对话内容，请先开始监听，或在问题框手动输入。' });
    return;
  }
  if (!q && !/^Interviewer:/im.test(tr)) {
    recordSession({
      event: 'answer_error',
      reqId,
      reason: 'no_interviewer_question',
      message: '最近没有面试官的问题，请在问题框中手动输入。',
    });
    send('answer-error', { message: '最近没有面试官的问题，请在问题框中手动输入。' });
    return;
  }

  const prov = resolveProvider(currentSettings);
  if (prov.needsKey && !prov.apiKey) {
    recordSession({
      event: 'answer_error',
      reqId,
      provider: prov.id,
      reason: 'missing_api_key',
      message: `未配置 ${prov.label} API Key，请在「设置」中填写。`,
    });
    send('answer-error', { message: `未配置 ${prov.label} API Key，请在「设置」中填写。` });
    return;
  }
  if (prov.id === 'custom') {
    let validURL = false;
    try {
      const url = new URL(prov.baseURL);
      validURL = url.protocol === 'https:' || url.protocol === 'http:';
    } catch (_error) {
      /* invalid URL */
    }
    if (!validURL || !prov.models[0]) {
      recordSession({
        event: 'answer_error',
        reqId,
        provider: prov.id,
        reason: 'invalid_provider',
        message: '请在设置中填写有效的自定义接口地址和模型 ID。',
      });
      send('answer-error', { message: '请在设置中填写有效的自定义接口地址和模型 ID。' });
      return;
    }
  }

  // 取消上一个
  if (activeGen) {
    try {
      activeGen.controller.abort();
    } catch (_e) {
      /* ignore */
    }
  }
  const controller = new AbortController();
  activeGen = { id: reqId, controller };

  // 输出 token 上限。
  // - OpenAI 兼容类（含 DeepSeek/Ollama）可能是“推理模型”：max_tokens 需同时覆盖隐藏思考链，
  //   预算太小会导致答案为空，因此放宽，答案长度交给提示词控制（思考链不展示给用户）。
  // - Gemini 已关闭思考(thinkingBudget=0)，可按字数上限收紧做长度兜底。
  const maxChars = currentSettings.maxChars || 500;
  const lang = currentSettings.answerLanguage || 'auto';
  const perChar = lang === 'en' ? 0.5 : 1.1;
  const maxOutputTokens =
    prov.type === 'openai'
      ? 4096
      : Math.min(4096, Math.max(160, Math.ceil(maxChars * perChar * 1.15)));
  const extractTokens = prov.type === 'openai' ? 1024 : 80;

  const common = {
    streamFn: prov.streamFn,
    apiKey: prov.apiKey,
    baseURL: prov.baseURL,
    models: prov.models,
    ...(prov.type === 'gemini' ? { thinkingBudget: 0 } : {}),
    signal: controller.signal,
  };

  let firstContentTimer = null;
  let firstContentTimedOut = false;
  let overallTimedOut = false;
  const overallTimer = setTimeout(() => {
    overallTimedOut = true;
    controller.abort();
  }, 60000);
  try {
    if (!q && tr) {
      // 明确的最新面试官问句直接作答；复杂/不完整问句才调用模型提取。
      // 提取结果必须参与作答，避免界面显示的问题与实际答案不一致。
      const recentTr = tr.split('\n').slice(-6).join('\n');
      const lastLine = recentTr.split('\n').at(-1) || '';
      const lastInterviewer = /^Interviewer:\s*(.*)$/i.exec(lastLine);
      if (lastInterviewer && questionDetection.isQuestion(lastInterviewer[1])) {
        q = lastInterviewer[1].trim();
      } else {
        const extractionTimeout = globalThis.AbortSignal.timeout(12000);
        try {
          const extracted = await llm.generateWithFallback({
            ...common,
            signal: globalThis.AbortSignal.any([controller.signal, extractionTimeout]),
            systemInstruction: prompt.EXTRACTION_SYSTEM,
            userText: prompt.buildExtractionUser(recentTr),
            maxOutputTokens: extractTokens,
            onChunk: () => {},
          });
          q = (extracted.text || '').trim();
        } catch (error) {
          if (extractionTimeout.aborted)
            throw new Error('识别当前问题超过 12 秒，请在问题框中手动输入。');
          throw error;
        }
      }
      if (!q || /^NO_QUESTION\b/i.test(q) || !questionDetection.isQuestion(q))
        throw new Error('没有识别到明确的面试官问题，请在问题框中手动输入。');
      send('answer-question', { question: q });
    }

    const retrievalStarted = performance.now();
    const retrievalOptions = {
      maxChars: currentSettings.maxContextChars || 20000,
      question: q,
      transcript: tr.split('\n').slice(-6).join('\n'),
    };
    let project;
    const context = store.buildContext({
      ...retrievalOptions,
      onProjectSelected: (selected) => {
        project = selected;
      },
    });
    const retrievalMs = Math.round((performance.now() - retrievalStarted) * 100) / 100;
    const { systemInstruction, userText } = prompt.buildPrompt({
      question: q,
      transcript: tr,
      context,
      answerLanguage: currentSettings.answerLanguage || 'auto',
      maxChars,
      profile: currentSettings.interviewProfile || '',
      jobDescription: currentSettings.jobDescription || '',
    });
    recordSession({
      event: 'answer_context',
      reqId,
      projectId: project?.id,
      retrievalMs,
      inputChars: systemInstruction.length + userText.length,
      ...sessionLogger.contextMetadata(context),
    });

    // 兼容接口偶尔只返回响应头却长时间无正文；超时后明确报错，避免一直空等。
    if (prov.type === 'openai') {
      firstContentTimer = setTimeout(() => {
        firstContentTimedOut = true;
        controller.abort();
      }, 25000);
    }
    const result = await llm.generateWithFallback({
      ...common,
      systemInstruction,
      userText,
      maxOutputTokens,
      onStart: (model) => send('answer-start', { question: q, model, primary: prov.models[0] }),
      onChunk: (delta) => send('answer-chunk', { delta }),
      onTiming: (timing) => {
        const metric = { stage: timing.stage, elapsedMs: Math.round(timing.elapsedMs) };
        if (timing.status != null) metric.status = timing.status;
        if (timing.stage === 'first-content' && firstContentTimer) {
          clearTimeout(firstContentTimer);
          firstContentTimer = null;
        }
        if (timing.stage === 'complete') {
          metric.outcome = timing.outcome;
          metric.reasoningFragments = timing.reasoningFragments;
          for (const field of [
            'promptTokens',
            'completionTokens',
            'reasoningTokens',
            'cachedPromptTokens',
            'totalTokens',
          ]) {
            if (Number.isFinite(timing[field])) metric[field] = timing[field];
          }
          if (timing.finishReason) metric.finishReason = timing.finishReason;
        }
        console.info('[answer-timing]', JSON.stringify({ reqId, provider: prov.id, ...metric }));
        recordSession({ event: 'answer_timing', reqId, provider: prov.id, ...metric });
        send('answer-timing', metric);
      },
    });
    if (!result.text.trim()) throw new Error('模型没有输出答案，请重试或切换回答模型。');
    const completeness = checkAnswerCompleteness(result.text);
    recordSession({
      event: 'answer_done',
      reqId,
      provider: prov.id,
      model: result.model,
      question: q,
      answer: result.text,
      elapsedMs: Date.now() - requestStartedAt,
      outcome: 'complete',
      answerIncomplete: completeness.suspected,
      ...(completeness.suspected ? { reason: completeness.reason } : {}),
    });
    send(
      'answer-done',
      completeness.suspected
        ? {
            answerIncomplete: true,
            reason: completeness.reason,
            warning: '回答可能未说完，原文已保留。请检查末尾，必要时手动重试。',
          }
        : {},
    );
  } catch (e) {
    if (overallTimedOut) {
      recordSession({
        event: 'answer_error',
        reqId,
        provider: prov.id,
        reason: 'overall_timeout',
        message: '回答等待超过 60 秒，请重试或切换模型。',
      });
      send('answer-error', { message: '回答等待超过 60 秒，请重试或切换模型。' });
    } else if (firstContentTimedOut) {
      recordSession({
        event: 'answer_error',
        reqId,
        provider: prov.id,
        reason: 'first_content_timeout',
        message: '回答首字等待超过 25 秒，请重试或切换模型。',
      });
      send('answer-error', { message: '回答首字等待超过 25 秒，请重试或切换模型。' });
    } else if (e.name === 'AbortError') {
      recordSession({ event: 'answer_done', reqId, provider: prov.id, outcome: 'aborted' });
      send('answer-done', { aborted: true });
    } else {
      recordSession({
        event: 'answer_error',
        reqId,
        provider: prov.id,
        reason: 'generation_error',
        errorName: e.name || 'Error',
        errorCode: llm.networkErrorCode(e),
        status: e.status,
        message: e.message,
        elapsedMs: Date.now() - requestStartedAt,
      });
      send('answer-error', { message: e.message });
    }
  } finally {
    if (firstContentTimer) clearTimeout(firstContentTimer);
    clearTimeout(overallTimer);
    if (activeGen && activeGen.id === reqId) activeGen = null;
  }
});

// 屏幕录制权限（macOS）—— 抓系统声音(Loopback) 需要它
ipcMain.handle('get-screen-permission', () => {
  if (process.platform !== 'darwin') return 'granted';
  return systemPreferences.getMediaAccessStatus('screen');
});

ipcMain.handle('open-screen-settings', () => {
  if (process.platform === 'darwin') {
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
  }
  return true;
});

// 麦克风权限（macOS）
ipcMain.handle('ensure-mic-permission', async () => {
  if (process.platform !== 'darwin') return true;
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (status === 'granted') return true;
  try {
    return await systemPreferences.askForMediaAccess('microphone');
  } catch (_e) {
    return false;
  }
});

// ---------- app lifecycle ----------

app.whenReady().then(() => {
  // dev 运行(npm start)时也给 dock 上我们的图标；打包后用 bundle 自带的 icns。
  if (process.platform === 'darwin' && app.dock) {
    try {
      const devIcon = path.join(__dirname, '..', '..', 'build', 'icon.png');
      if (require('fs').existsSync(devIcon)) app.dock.setIcon(devIcon);
    } catch (_e) {
      /* ignore */
    }
  }
  setupDisplayMediaLoopback();
  createWindow();
  registerHotkey();
  if (
    !startupSettingsError &&
    currentSettings.sttProvider === 'local' &&
    !process.env.INTERVIEW_SMOKE &&
    !process.env.INTERVIEW_SCREENSHOT &&
    !process.env.INTERVIEW_GIF
  ) {
    // UI creation does not wait for model loading. Listening/self-check share
    // this same promise if the user starts before background warmup finishes.
    const warmStarted = performance.now();
    localStt.warm(currentSettings).then(
      () =>
        recordSession({
          event: 'stt_warm',
          outcome: 'ready',
          elapsedMs: Math.round(performance.now() - warmStarted),
        }),
      (error) =>
        recordSession({ event: 'stt_warm', outcome: 'error', errorName: error.name || 'Error' }),
    );
  }
  if (startupSettingsError && !process.env.INTERVIEW_SMOKE) {
    dialog.showErrorBox(
      '设置读取失败',
      `${startupSettingsError}\n\n请先备份并修复或移走设置文件，再重启应用：\n${settingsStore.settingsPath()}`,
    );
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  localStt.stop();
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
