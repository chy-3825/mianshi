'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const mode = (filePath) => fs.statSync(filePath).mode & 0o777;

function loadWithElectronUserData(dataDir) {
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return { app: { getPath: () => dataDir } };
    return originalLoad.apply(this, arguments);
  };
  try {
    for (const name of ['settings', 'store']) {
      delete require.cache[require.resolve(`../src/main/${name}`)];
    }
    return {
      settings: require('../src/main/settings'),
      store: require('../src/main/store'),
    };
  } finally {
    Module._load = originalLoad;
  }
}

function withFailedRename(target, callback) {
  const originalRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === target) {
      const error = new Error('secret-value-must-not-appear');
      error.code = 'EIO';
      throw error;
    }
    return originalRename(from, to);
  };
  try {
    callback();
  } finally {
    fs.renameSync = originalRename;
  }
}

test('settings and knowledge use private permissions and migrate old files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-private-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'profile');
  fs.mkdirSync(dataDir);
  fs.chmodSync(dataDir, 0o755);

  const settingsPath = path.join(dataDir, 'settings.json');
  const knowledgePath = path.join(dataDir, 'knowledge.json');
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ provider: 'gemini', customApiKey: 'old-test-key' }),
  );
  fs.writeFileSync(
    knowledgePath,
    JSON.stringify({ docs: [{ id: 'doc_2', name: 'private.txt', text: 'my project', chars: 10 }] }),
  );
  fs.chmodSync(settingsPath, 0o664);
  fs.chmodSync(knowledgePath, 0o664);

  const { settings, store } = loadWithElectronUserData(dataDir);
  assert.equal(settings.load().provider, 'gemini', 'existing provider choice must be preserved');
  assert.equal(settings.load().customApiKey, 'old-test-key');
  assert.equal(store.summary()[0].name, 'private.txt');
  assert.equal(mode(dataDir), 0o700);
  assert.equal(mode(settingsPath), 0o600);
  assert.equal(mode(knowledgePath), 0o600);

  settings.save({ customApiKey: 'new-test-key' });
  store.add('another.txt', 'updated');
  assert.equal(mode(settingsPath), 0o600);
  assert.equal(mode(knowledgePath), 0o600);
  assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).customApiKey, 'new-test-key');
  assert.equal(JSON.parse(fs.readFileSync(knowledgePath, 'utf8')).docs.length, 2);

  const savedSettings = fs.readFileSync(settingsPath, 'utf8');
  const savedKnowledge = fs.readFileSync(knowledgePath, 'utf8');
  const beforeSummary = store.summary();
  withFailedRename(settingsPath, () => {
    assert.throws(
      () => settings.save({ customApiKey: 'unsaved-test-key' }),
      (error) => /保存设置失败（EIO）/.test(error.message) && !/secret-value/.test(error.message),
    );
  });
  withFailedRename(knowledgePath, () => {
    assert.throws(
      () => store.add('unsaved.txt', 'must not enter memory'),
      (error) => /保存知识库失败（EIO）/.test(error.message) && !/secret-value/.test(error.message),
    );
  });
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), savedSettings);
  assert.equal(fs.readFileSync(knowledgePath, 'utf8'), savedKnowledge);
  assert.deepEqual(store.summary(), beforeSummary);
  assert.equal(
    fs.readdirSync(dataDir).some((name) => name.endsWith('.tmp')),
    false,
  );
});

test('new installation defaults to custom provider and does not overwrite invalid data', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-private-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'profile');
  const { settings, store } = loadWithElectronUserData(dataDir);
  assert.equal(settings.load().provider, 'custom');
  assert.equal(settings.load().autoAnswer, true);
  assert.equal(settings.load().localSttEngine, 'qwen3-asr');
  assert.equal(settings.load().localSttModel, 'Qwen/Qwen3-ASR-0.6B-hf');
  assert.equal(mode(dataDir), 0o700);

  const settingsPath = path.join(dataDir, 'settings.json');
  fs.writeFileSync(settingsPath, '{invalid json', { mode: 0o666 });
  assert.throws(() => settings.load(), /设置文件格式错误/);
  assert.throws(() => settings.save({ provider: 'custom' }), /设置文件格式错误/);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), '{invalid json');
  assert.equal(mode(settingsPath), 0o600);

  const knowledgePath = path.join(dataDir, 'knowledge.json');
  fs.writeFileSync(knowledgePath, '{invalid json', { mode: 0o666 });
  assert.throws(() => store.summary(), /读取知识库失败/);
  assert.throws(() => store.add('new.txt', 'new material'), /读取知识库失败/);
  assert.equal(fs.readFileSync(knowledgePath, 'utf8'), '{invalid json');
  assert.equal(mode(knowledgePath), 0o600);
});

test('old installations enable auto-answer once and retain a later explicit off choice', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-auto-default-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { settings } = loadWithElectronUserData(path.join(root, 'profile'));
  settings.save({ autoAnswer: false, autoAnswerPreferenceVersion: 1 });
  assert.equal(settings.load().autoAnswer, true);
  settings.save({ autoAnswer: false });
  assert.equal(settings.load().autoAnswer, false);
});

test('old stock ASR choice migrates, while later explicit engine choices persist', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-asr-default-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { settings } = loadWithElectronUserData(path.join(root, 'profile'));
  settings.save({
    localSttEngine: 'sensevoice',
    localSttModel: 'iic/SenseVoiceSmall',
    localSttPreferenceVersion: 1,
  });
  assert.equal(settings.load().localSttEngine, 'qwen3-asr');
  assert.equal(settings.load().localSttModel, 'Qwen/Qwen3-ASR-0.6B-hf');

  settings.save({ localSttEngine: 'sensevoice', localSttModel: 'iic/SenseVoiceSmall' });
  assert.equal(settings.load().localSttEngine, 'sensevoice');
  assert.equal(settings.load().localSttModel, 'iic/SenseVoiceSmall');

  settings.save({
    localSttEngine: 'faster-whisper',
    localSttModel: '',
    localSttPreferenceVersion: 1,
  });
  assert.equal(settings.load().localSttEngine, 'faster-whisper');
  assert.equal(settings.load().localSttModel, 'large-v3-turbo');
});

test('symlinked settings are rejected without touching the linked file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-private-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'profile');
  fs.mkdirSync(dataDir);
  const outside = path.join(root, 'outside.json');
  fs.writeFileSync(outside, JSON.stringify({ customApiKey: 'outside-test-key' }));
  fs.symlinkSync(outside, path.join(dataDir, 'settings.json'));
  const { settings } = loadWithElectronUserData(dataDir);
  assert.throws(() => settings.load(), /读取设置失败/);
  assert.throws(() => settings.save({ provider: 'custom' }), /读取设置失败/);
  assert.equal(JSON.parse(fs.readFileSync(outside, 'utf8')).customApiKey, 'outside-test-key');
});
