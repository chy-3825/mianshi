'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  appendSessionLog,
  clearSessionLog,
  logPath,
  sanitizeEntry,
  contextMetadata,
  MAX_FILE_BYTES,
} = require('../src/main/sessionLogger');

function temporaryDataDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-session-log-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'userData');
}

test('session logger only saves approved fields and redacts configured or recognizable keys', (t) => {
  const dataDir = temporaryDataDir(t);
  const secret = 'test-secret-value-12345';
  assert.equal(
    appendSessionLog(
      dataDir,
      {
        event: 'transcript_final',
        role: 'interviewer',
        text: `我的问题 ${secret}，另外 Bearer abcdefghijklmnop 和 sk-1234567890abcdef`,
        audio: new Uint8Array([1, 2, 3]),
        prompt: 'this must never be saved',
        knowledge: 'nor this',
        apiKey: secret,
        elapsedMs: 23,
        asrToTriggerMs: 12,
        vadToTriggerMs: 40,
        micEnabled: false,
        systemEnabled: true,
        utteranceEnd: true,
      },
      { deepseekApiKey: secret },
    ),
    true,
  );
  const raw = fs.readFileSync(logPath(dataDir), 'utf8');
  const line = JSON.parse(raw.trim());
  assert.match(line.timestamp, /^\d{4}-\d\d-\d\dT/);
  assert.equal(line.event, 'transcript_final');
  assert.equal(line.role, 'interviewer');
  assert.equal(line.elapsedMs, 23);
  assert.equal(line.asrToTriggerMs, 12);
  assert.equal(line.vadToTriggerMs, 40);
  assert.equal(line.micEnabled, false);
  assert.equal(line.systemEnabled, true);
  assert.equal(line.utteranceEnd, true);
  assert.match(line.text, /\[REDACTED\]/);
  assert.equal(raw.includes(secret), false);
  assert.equal(raw.includes('abcdefghijklmnop'), false);
  assert.equal(raw.includes('1234567890abcdef'), false);
  assert.equal(raw.includes('this must never be saved'), false);
  assert.equal(raw.includes('nor this'), false);
  assert.equal(raw.includes('audio'), false);
  assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(logPath(dataDir)).mode & 0o777, 0o600);
});

test('invalid events are rejected and long answer text is bounded', (t) => {
  const dataDir = temporaryDataDir(t);
  assert.equal(appendSessionLog(dataDir, { event: 'dump_settings', text: 'private' }), false);
  assert.equal(
    appendSessionLog(
      dataDir,
      { event: 'answer_done', answer: 'private' },
      { diagnosticLogging: false },
    ),
    false,
  );
  assert.equal(fs.existsSync(dataDir), false);
  const safe = sanitizeEntry({ event: 'answer_done', answer: '中'.repeat(30000), atMs: -4 });
  assert.equal(safe.answer.length, 10000);
  assert.equal('atMs' in safe, false);
  assert.equal(safe.event, 'answer_done');
  const error = sanitizeEntry(
    { event: 'answer_error', message: 'request failed: api_key=unrecognized123456' },
    {},
  );
  assert.equal(error.message.includes('unrecognized123456'), false);
  const shortKey = sanitizeEntry(
    { event: 'answer_error', message: 'short key is abc' },
    { customApiKey: 'abc' },
  );
  assert.equal(shortKey.message.includes('abc'), false);
});

test('performance events retain bounded timing and token counts but exclude raw payloads', () => {
  const timing = sanitizeEntry({
    event: 'asr_timing',
    role: 'interviewer',
    queueMs: 12,
    inferenceMs: 145,
    elapsedMs: 160,
    pcm: 'private audio',
    textPayload: 'private transcription',
  });
  assert.equal(timing.queueMs, 12);
  assert.equal(timing.inferenceMs, 145);
  assert.equal('pcm' in timing, false);
  assert.equal('textPayload' in timing, false);
  const context = sanitizeEntry({
    event: 'answer_context',
    projectId: 'project_1',
    retrievalMs: 0.3,
    inputChars: 4000,
    promptTokens: 2200,
    completionTokens: -1,
    cachedPromptTokens: 1500,
    context: 'private document',
  });
  assert.equal(context.projectId, 'project_1');
  assert.equal(context.promptTokens, 2200);
  assert.equal(context.cachedPromptTokens, 1500);
  assert.equal('completionTokens' in context, false);
  assert.equal('context' in context, false);
});

test('session logger rotates at a size limit and clears both generations safely', (t) => {
  const dataDir = temporaryDataDir(t);
  assert.equal(clearSessionLog(dataDir), true, 'clearing before first write should succeed');
  fs.mkdirSync(dataDir);
  const filePath = logPath(dataDir);
  fs.writeFileSync(filePath, 'x'.repeat(MAX_FILE_BYTES - 20), { mode: 0o644 });
  appendSessionLog(dataDir, { event: 'session_start', source: 'monitor' });
  assert.equal(fs.readFileSync(`${filePath}.1`, 'utf8').length, MAX_FILE_BYTES - 20);
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).event, 'session_start');
  assert.equal(fs.statSync(`${filePath}.1`).mode & 0o777, 0o600);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.equal(clearSessionLog(dataDir), true);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(fs.existsSync(`${filePath}.1`), false);
  assert.equal(clearSessionLog(dataDir), true);
});

test('session logger refuses a symlinked log without modifying its target', (t) => {
  const dataDir = temporaryDataDir(t);
  fs.mkdirSync(dataDir);
  const outside = path.join(path.dirname(dataDir), 'outside.txt');
  fs.writeFileSync(outside, 'untouched');
  fs.symlinkSync(outside, logPath(dataDir));
  assert.throws(() => appendSessionLog(dataDir, { event: 'session_start' }), /普通文件/);
  assert.throws(() => clearSessionLog(dataDir), /普通文件/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'untouched');
});

test('answer context logs only retrieval counts, never knowledge snippets', (t) => {
  const dataDir = temporaryDataDir(t);
  const context =
    '【资料时效】\n【来源：resume.md，片段 1】\nprivate details\n' +
    '【来源：resume.md，片段 2】\nmore private details\n' +
    '【来源：project.md，片段 1】\nsecret project details';
  const metadata = contextMetadata(context);
  assert.deepEqual(metadata, { contextChars: context.length, sourceCount: 2, chunkCount: 3 });
  appendSessionLog(dataDir, { event: 'answer_context', reqId: 7, ...metadata, context });
  const raw = fs.readFileSync(logPath(dataDir), 'utf8');
  const entry = JSON.parse(raw);
  assert.equal(entry.event, 'answer_context');
  assert.equal(entry.sourceCount, 2);
  assert.equal(entry.chunkCount, 3);
  assert.equal(raw.includes('private details'), false);
  assert.equal(raw.includes('secret project details'), false);
  assert.equal(raw.includes('resume.md'), false);
});
