'use strict';

// 本地诊断日志只保留有限的结构化会话事件。不要把音频、完整提示词、知识库或设置对象写入此文件。
const fs = require('fs');
const path = require('path');

const LOG_NAME = 'session-diagnostics.jsonl';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const EVENTS = new Set([
  'session_start',
  'session_stop',
  'vad_flush',
  'vad_discard',
  'asr_final',
  'asr_timing',
  'stt_warm',
  'transcript_final',
  'auto_decision',
  'auto_trigger',
  'answer_request',
  'answer_question',
  'answer_start',
  'answer_context',
  'answer_timing',
  'answer_done',
  'answer_error',
]);
const TEXT_LIMITS = Object.freeze({
  text: 4000,
  transcript: 4000,
  question: 2000,
  answer: 10000,
  reason: 500,
  error: 500,
  message: 500,
  role: 40,
  source: 80,
  provider: 80,
  model: 120,
  primary: 120,
  engine: 80,
  language: 40,
  stage: 80,
  outcome: 80,
  status: 80,
  trigger: 80,
  errorName: 80,
  errorCode: 80,
  reqId: 100,
  sttId: 100,
  segmentId: 100,
  sessionId: 100,
  projectId: 100,
  finishReason: 40,
  hintFallbackReason: 40,
});
const NUMERIC_FIELDS = new Set([
  'elapsedMs',
  'atMs',
  'durationMs',
  'audioMs',
  'speechMs',
  'rms',
  'peak',
  'startedAtMs',
  'endAtMs',
  'chars',
  'samples',
  'channelCount',
  'sampleRate',
  'asrSampleRate',
  'confidence',
  'reasoningFragments',
  'asrToTriggerMs',
  'vadToTriggerMs',
  'contextChars',
  'sourceCount',
  'chunkCount',
  'queueMs',
  'inferenceMs',
  'retrievalMs',
  'inputChars',
  'promptTokens',
  'completionTokens',
  'reasoningTokens',
  'cachedPromptTokens',
  'totalTokens',
  'hintChars',
  'hintTermCount',
]);
const BOOLEAN_FIELDS = new Set([
  'auto',
  'accepted',
  'deduped',
  'isQuestion',
  'hasTranscript',
  'micEnabled',
  'systemEnabled',
  'utteranceEnd',
  'speechActive',
  'aborted',
  'echoCancellation',
  'noiseSuppression',
  'autoGainControl',
  'hintApplied',
  'hintFallback',
  'answerIncomplete',
]);
const SECRET_SETTING_FIELDS = [
  'deepgramApiKey',
  'geminiApiKey',
  'deepseekApiKey',
  'openaiApiKey',
  'customApiKey',
];

function logPath(userDataDir) {
  return path.join(userDataDir, LOG_NAME);
}

function secretValues(settings) {
  if (!settings || typeof settings !== 'object') return [];
  return SECRET_SETTING_FIELDS.map((field) => settings[field])
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .sort((a, b) => b.length - a.length);
}

function redact(value, secrets) {
  let safe = value;
  for (const secret of secrets) safe = safe.split(secret).join('[REDACTED]');
  // 兜底处理常见密钥形态；未知密钥也可能被误放进转写或错误文本。
  safe = safe.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]');
  safe = safe.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,})\b/g, '[REDACTED]');
  safe = safe.replace(
    /\b((?:api[_ -]?key|access[_ -]?token|secret|password)\s*[:=]\s*)[^\s"',;]{4,}/gi,
    '$1[REDACTED]',
  );
  safe = safe.replace(/([?&](?:key|api_key|access_token)=)[^&#\s]+/gi, '$1[REDACTED]');
  return safe;
}

function sanitizeEntry(entry, settings) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !EVENTS.has(entry.event)) {
    return null;
  }

  const secrets = secretValues(settings);
  const safe = { timestamp: new Date().toISOString(), event: entry.event };
  for (const [field, limit] of Object.entries(TEXT_LIMITS)) {
    const value = entry[field];
    if (typeof value === 'string') safe[field] = redact(value, secrets).slice(0, limit);
    else if (field === 'status' && Number.isFinite(value)) safe[field] = value;
    else if (['reqId', 'sttId', 'segmentId'].includes(field) && Number.isSafeInteger(value)) {
      safe[field] = value;
    }
  }
  for (const field of NUMERIC_FIELDS) {
    const value = entry[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e15) {
      safe[field] = value;
    }
  }
  for (const field of BOOLEAN_FIELDS) {
    if (typeof entry[field] === 'boolean') safe[field] = entry[field];
  }
  return safe;
}

function contextMetadata(context) {
  const text = typeof context === 'string' ? context : '';
  const sources = new Set();
  let chunkCount = 0;
  for (const match of text.matchAll(/【来源：(.+?)，片段 \d+】/g)) {
    sources.add(match[1]);
    chunkCount++;
  }
  return { contextChars: text.length, sourceCount: sources.size, chunkCount };
}

function ensurePrivateDirectory(userDataDir) {
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(userDataDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('日志目录不是普通目录');
  fs.chmodSync(userDataDir, 0o700);
}

function checkExistingFile(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('日志文件不是普通文件');
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function openPrivateLog(filePath) {
  checkExistingFile(filePath);
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_APPEND |
    fs.constants.O_CREAT |
    (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(filePath, flags, 0o600);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('日志文件不是普通文件');
    fs.fchmodSync(fd, 0o600);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function appendSessionLog(userDataDir, entry, settings = {}) {
  if (settings && settings.diagnosticLogging === false) return false;
  const safe = sanitizeEntry(entry, settings);
  if (!safe) return false;

  const line = `${JSON.stringify(safe)}\n`;
  const lineBytes = Buffer.byteLength(line, 'utf8');
  ensurePrivateDirectory(userDataDir);
  const currentPath = logPath(userDataDir);
  let fd = openPrivateLog(currentPath);
  try {
    if (fs.fstatSync(fd).size + lineBytes > MAX_FILE_BYTES) {
      fs.closeSync(fd);
      fd = null;
      const previousPath = `${currentPath}.1`;
      checkExistingFile(previousPath);
      fs.renameSync(currentPath, previousPath);
      fd = openPrivateLog(currentPath);
    }
    fs.writeFileSync(fd, line, 'utf8');
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return true;
}

function clearSessionLog(userDataDir) {
  try {
    const stat = fs.lstatSync(userDataDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('日志目录不是普通目录');
    fs.chmodSync(userDataDir, 0o700);
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
  const currentPath = logPath(userDataDir);
  const existingPaths = [];
  for (const filePath of [currentPath, `${currentPath}.1`]) {
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('日志文件不是普通文件');
      existingPaths.push(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  for (const filePath of existingPaths) fs.unlinkSync(filePath);
  return true;
}

module.exports = {
  appendSessionLog,
  clearSessionLog,
  logPath,
  sanitizeEntry,
  contextMetadata,
  MAX_FILE_BYTES,
};
