'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const QuestionDetection = require('../src/renderer/question-detection');

const appSource = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');

function settingsFixture(t, saved) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-stt-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  if (saved) {
    fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify(saved));
  }
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return { app: { getPath: () => directory } };
    return originalLoad.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve('../src/main/settings')];
    return require('../src/main/settings');
  } finally {
    Module._load = originalLoad;
  }
}

function rendererFixture(settings) {
  const elements = new Map();
  const saved = [];
  const logged = [];
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        value: '',
        textContent: '',
        checked: false,
        disabled: false,
        addEventListener() {},
        classList: {
          add: (...names) => names.forEach((name) => classes.add(name)),
          remove: (...names) => names.forEach((name) => classes.delete(name)),
          toggle: (name, force) => {
            if (force === undefined ? !classes.has(name) : force) classes.add(name);
            else classes.delete(name);
          },
          contains: (name) => classes.has(name),
        },
      });
    }
    return elements.get(id);
  }
  const api = new Proxy(
    {
      saveSettings: async (partial) => {
        saved.push(partial);
        return { ...settings, ...partial };
      },
      logSessionEvent: (payload) => logged.push(payload),
    },
    { get: (target, name) => target[name] || (() => {}) },
  );
  const sandbox = {
    window: { QuestionDetection, api, addEventListener() {} },
    document: { getElementById: element, querySelectorAll: () => [] },
    navigator: { mediaDevices: { addEventListener() {} } },
    console: { info: (...args) => logged.push(args) },
    setTimeout: () => 1,
    clearTimeout() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(appSource, sandbox);
  vm.runInContext('state', sandbox).settings = settings;
  return { sandbox, element, saved, logged };
}

test('new installation and existing settings without context keys enable domain hints', (t) => {
  const fresh = settingsFixture(t);
  assert.equal(fresh.load().localSttContextEnabled, true);
  assert.equal(fresh.load().localSttContextTerms, '');

  const legacy = settingsFixture(t, { provider: 'ollama' });
  assert.equal(legacy.load().localSttContextEnabled, true);
  assert.equal(legacy.load().localSttContextTerms, '');
  assert.equal(legacy.load().provider, 'ollama');
});

test('explicit disabled hints persist through save and unrelated settings changes', (t) => {
  const settings = settingsFixture(t, {
    localSttContextEnabled: false,
    localSttContextTerms: '幂等性，WebSocket',
  });
  assert.equal(settings.load().localSttContextEnabled, false);
  settings.save({ hotkey: 'Control+B' });
  assert.equal(settings.load().localSttContextEnabled, false);
  assert.equal(settings.load().localSttContextTerms, '幂等性，WebSocket');
  settings.save({ localSttContextEnabled: true });
  assert.equal(settings.load().localSttContextEnabled, true);
  settings.save({ localSttContextEnabled: false });
  assert.equal(settings.load().localSttContextEnabled, false);
});

test('supplemental terms are normalized and bounded at the persistence boundary', (t) => {
  const settings = settingsFixture(t, { localSttContextTerms: { unexpected: 'object' } });
  assert.equal(settings.load().localSttContextTerms, '');
  settings.save({ localSttContextTerms: '  幂等性\nWebSocket  ' });
  assert.equal(settings.load().localSttContextTerms, '幂等性\nWebSocket');
  settings.save({ localSttContextTerms: '术'.repeat(700) });
  assert.equal(settings.load().localSttContextTerms.length, 500);
});

test('settings modal loads default-on hints and retains explicit disabled choice', () => {
  const { sandbox, element } = rendererFixture({ sttProvider: 'local' });
  vm.runInContext('openSettings()', sandbox);
  assert.equal(element('setLocalSttContextEnabled').checked, true);
  assert.equal(element('setLocalSttContextTerms').disabled, false);
  assert.equal(element('localSttContextFields').classList.contains('hidden'), false);

  const state = vm.runInContext('state', sandbox);
  state.settings.localSttContextEnabled = false;
  state.settings.localSttContextTerms = 'Demo App';
  vm.runInContext('openSettings()', sandbox);
  assert.equal(element('setLocalSttContextEnabled').checked, false);
  assert.equal(element('setLocalSttContextTerms').value, 'Demo App');
  assert.equal(element('setLocalSttContextTerms').disabled, true);
});

test('saving disabled hints keeps supplemental terms without logging their contents', async () => {
  const { sandbox, element, saved, logged } = rendererFixture({ sttProvider: 'local' });
  vm.runInContext('openSettings()', sandbox);
  element('setLocalSttContextEnabled').checked = false;
  element('setLocalSttContextTerms').value = '  private-project-term  ';
  await vm.runInContext('saveSettings()', sandbox);
  assert.equal(saved[0].localSttContextEnabled, false);
  assert.equal(saved[0].localSttContextTerms, 'private-project-term');
  assert.equal(JSON.stringify(logged).includes('private-project-term'), false);
  vm.runInContext('openSettings()', sandbox);
  assert.equal(element('setLocalSttContextEnabled').checked, false);
  assert.equal(element('setLocalSttContextTerms').value, 'private-project-term');

  element('setLocalSttContextTerms').value = '词'.repeat(800);
  await vm.runInContext('saveSettings()', sandbox);
  assert.equal(saved[1].localSttContextTerms.length, 500);
});

test('provider, engine and hint-switch events update field visibility without erasing terms', () => {
  const { sandbox, element } = rendererFixture({
    sttProvider: 'local',
    localSttContextTerms: 'WebSocket',
  });
  vm.runInContext('openSettings(); bindEvents()', sandbox);
  const hidden = () => element('localSttContextFields').classList.contains('hidden');
  assert.equal(hidden(), false);

  element('setSttProvider').value = 'deepgram';
  element('setSttProvider').onchange();
  assert.equal(hidden(), true);
  element('setSttProvider').value = 'local';
  element('setSttProvider').onchange();
  assert.equal(hidden(), false);

  element('setLocalSttEngine').value = 'sensevoice';
  element('setLocalSttEngine').onchange();
  assert.equal(hidden(), true);
  assert.equal(element('setLocalSttModel').value, 'iic/SenseVoiceSmall');
  element('setLocalSttEngine').value = 'qwen3-asr';
  element('setLocalSttEngine').onchange();
  assert.equal(hidden(), false);

  element('setLocalSttContextEnabled').checked = false;
  element('setLocalSttContextEnabled').onchange();
  assert.equal(element('setLocalSttContextTerms').disabled, true);
  assert.equal(element('setLocalSttContextTerms').value, 'WebSocket');
  element('setLocalSttContextEnabled').checked = true;
  element('setLocalSttContextEnabled').onchange();
  assert.equal(element('setLocalSttContextTerms').disabled, false);
});

test('Chinese hint controls declare bounded textarea and short-vocabulary guidance', () => {
  assert.match(htmlSource, /id="setLocalSttContextEnabled"[^>]*\/?>领域词提示/);
  assert.match(htmlSource, /id="setLocalSttContextTerms"[\s\S]*?maxlength="500"/);
  assert.match(htmlSource, /短词表更可靠，不要粘贴 README 或整段描述/);
});
