'use strict';

const path = require('path');
const { app } = require('electron');
const { readPrivateFile, writePrivateJson, storageError } = require('./private-json');

const DEFAULTS = {
  deepgramApiKey: process.env.DEEPGRAM_API_KEY || '',
  sttProvider: 'local',
  localSttEngine: 'qwen3-asr',
  localSttModel: 'Qwen/Qwen3-ASR-0.6B-hf',
  localSttPreferenceVersion: 2,
  localSttPython: '',
  localSttContextEnabled: true,
  localSttContextTerms: '',
  // 答案 Provider： deepseek / gemini / openai / custom / ollama
  provider: 'custom',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekModel: 'deepseek-chat',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: 'gpt-4o-mini',
  customApiKey: process.env.CUSTOM_API_KEY || '',
  customBaseURL: process.env.CUSTOM_BASE_URL || '',
  customModel: process.env.CUSTOM_MODEL || '',
  ollamaBaseURL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1/chat/completions',
  ollamaModel: 'llama3.1',
  // 转写语言： zh / en-US / multi
  sttLanguage: 'zh',
  // 生成模型（可编辑，填你账号能用的任意 Flash 模型 ID）
  genModel: 'gemini-2.5-flash',
  // 注入到上下文的资料最大字符数
  maxContextChars: 20000,
  // 全局热键：按下后自动识别问题并生成答案
  hotkey: 'Control+A',
  // 自动作答：监测到面试官问完一个问题就自动触发（无需按热键）
  autoAnswer: true,
  // V2 changes the default to on. Once saved, an explicit off choice is kept.
  autoAnswerPreferenceVersion: 2,
  diagnosticLogging: true,
  // 答案字数上限
  maxChars: 500,
  // 答案语言： auto（跟随问题） / zh / en
  answerLanguage: 'auto',
  // 面试背景与作答风格（注入到系统提示，最高优先级）
  interviewProfile: '',
  // 目标岗位 JD（持久化；上传或粘贴，作答时据此定制）
  jobDescription: '',
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function normalizeLocalSttContext(settings) {
  return {
    ...settings,
    localSttContextEnabled: settings.localSttContextEnabled !== false,
    localSttContextTerms:
      typeof settings.localSttContextTerms === 'string'
        ? settings.localSttContextTerms.trim().slice(0, 500)
        : '',
  };
}

function load() {
  let raw;
  try {
    raw = readPrivateFile(settingsPath());
  } catch (error) {
    throw storageError('读取设置', error);
  }
  if (raw === null) return { ...DEFAULTS };
  try {
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error();
    const merged = { ...DEFAULTS, ...saved };
    if (saved.autoAnswerPreferenceVersion !== 2) {
      merged.autoAnswer = true;
      merged.autoAnswerPreferenceVersion = 2;
    }
    // Existing installs that still use the old stock ASR choice receive the
    // new tested default. Keep custom models and explicit alternate engines.
    if (saved.localSttPreferenceVersion !== 2) {
      if (
        (!saved.localSttEngine || saved.localSttEngine === 'sensevoice') &&
        (!saved.localSttModel || saved.localSttModel === 'iic/SenseVoiceSmall')
      ) {
        merged.localSttEngine = DEFAULTS.localSttEngine;
        merged.localSttModel = DEFAULTS.localSttModel;
      }
      merged.localSttPreferenceVersion = 2;
    }
    if (merged.localSttEngine === 'whisper') merged.localSttEngine = 'faster-whisper';
    if (!saved.localSttModel && merged.localSttEngine === 'sensevoice') {
      merged.localSttModel = 'iic/SenseVoiceSmall';
    }
    if (!saved.localSttModel && ['faster-whisper', 'whisper'].includes(merged.localSttEngine)) {
      merged.localSttModel = 'large-v3-turbo';
    }
    return normalizeLocalSttContext(merged);
  } catch (_error) {
    throw new Error('设置文件格式错误；请先备份设置文件，再修复或移走。');
  }
}

function save(partial) {
  const merged = normalizeLocalSttContext({ ...load(), ...partial });
  try {
    writePrivateJson(settingsPath(), merged);
  } catch (error) {
    throw storageError('保存设置', error);
  }
  return merged;
}

module.exports = { load, save, DEFAULTS, settingsPath };
