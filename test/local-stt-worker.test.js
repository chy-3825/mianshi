'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { setImmediate } = require('timers');
const {
  LocalStt,
  resolvePython,
  resolveWorkerScript,
  userSttDir,
} = require('../src/main/localStt');

const fixture = path.join(__dirname, '..', 'fixtures', 'fake-stt-worker.js');

test('local STT paths are independent of cwd and packaged worker is outside app.asar', () => {
  const root = '/some/source/tree';
  const resources = '/some/installed/app/resources';
  assert.equal(
    resolvePython({}, { isPackaged: false, projectRoot: root }),
    path.join(root, '.venv-stt', 'bin', 'python'),
  );
  assert.equal(
    resolveWorkerScript({ isPackaged: false, projectRoot: root }),
    path.join(root, 'local_stt', 'server.py'),
  );
  assert.equal(
    resolveWorkerScript({ isPackaged: true, resourcesPath: resources }),
    path.join(resources, 'local_stt', 'server.py'),
  );
  assert.equal(
    resolvePython({}, { isPackaged: true, env: { XDG_DATA_HOME: '/tmp/stt-user-data' } }),
    '/tmp/stt-user-data/interview-copilot/stt-venv/bin/python',
  );
  assert.equal(
    resolvePython({ localSttPython: '/custom/python' }, { isPackaged: true }),
    '/custom/python',
  );
  assert.equal(
    userSttDir({ XDG_DATA_HOME: 'relative/path' }).endsWith('/interview-copilot/stt-venv'),
    true,
  );
});

test('missing Python executable rejects without crashing the process', async () => {
  const stt = new LocalStt({ scriptPath: fixture });
  try {
    await assert.rejects(
      stt.ensure({ localSttPython: '/definitely/missing/stt-python' }),
      /无法启动本地语音服务|发送请求失败/,
    );
    assert.equal(stt.child, null);
    assert.equal(stt.pending.size, 0);
  } finally {
    stt.stop();
  }
});

test('concurrent requests share initialization and wait until the worker is ready', async () => {
  let starts = 0;
  const stt = new LocalStt({
    scriptPath: fixture,
    spawn: (...args) => {
      starts++;
      return spawn(...args);
    },
  });
  const settings = { localSttPython: process.execPath };
  try {
    const answers = await Promise.all([
      stt.transcribe(settings, Buffer.alloc(4), 16000, 'zh'),
      stt.transcribe(settings, Buffer.alloc(4), 8000, 'zh'),
      stt.ensure(settings),
    ]);
    assert.deepEqual(answers, ['识别:16000', '识别:8000', undefined]);
    assert.equal(starts, 1);
    assert.equal(stt.pending.size, 0);
  } finally {
    stt.stop();
  }
});

test('concurrent warm and transcription share one real warm-up, reset when models change', async () => {
  let starts = 0;
  const stt = new LocalStt({
    scriptPath: fixture,
    spawn: (...args) => {
      starts++;
      return spawn(...args);
    },
  });
  const settings = { localSttPython: process.execPath };
  try {
    const firstWarm = stt.warm(settings);
    assert.equal(stt.warm(settings), firstWarm);
    const results = await Promise.all([
      firstWarm,
      stt.ensure(settings),
      stt.transcribe(settings, Buffer.alloc(4), 16000, 'zh'),
    ]);
    assert.deepEqual(results, [{ warmMs: 40 }, undefined, '识别:16000']);
    assert.deepEqual(await stt.warm(settings), { warmMs: 40 });
    assert.equal(starts, 1);
    assert.deepEqual(await stt.warm({ ...settings, localSttModel: 'other' }), { warmMs: 40 });
    assert.equal(starts, 2);
  } finally {
    stt.stop();
  }
});

test('waiting interviewer audio has priority, without interrupting active work or reordering a role', async () => {
  const stt = new LocalStt({ scriptPath: fixture });
  const settings = { localSttPython: process.execPath };
  const timings = [];
  const completions = [];
  const transcribe = (sampleRate, role) =>
    stt
      .transcribe(settings, Buffer.alloc(4), sampleRate, 'zh', {
        role,
        onTiming: (timing) => timings.push(timing),
      })
      .then((text) => {
        completions.push(text);
        return text;
      });
  try {
    await stt.warm(settings);
    const active = transcribe(16001, 'interviewee');
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(stt.activeTask);
    await Promise.all([
      active,
      transcribe(16002, 'interviewee'),
      transcribe(16003, 'interviewer'),
      transcribe(16004, 'interviewer'),
      transcribe(16005, 'interviewee'),
    ]);
    assert.deepEqual(completions, [
      '识别:16001',
      '识别:16003',
      '识别:16004',
      '识别:16002',
      '识别:16005',
    ]);
    assert.deepEqual(
      timings.map((timing) => timing.role),
      ['interviewee', 'interviewer', 'interviewer', 'interviewee', 'interviewee'],
    );
    for (const timing of timings) {
      assert.deepEqual(Object.keys(timing).sort(), ['elapsedMs', 'inferenceMs', 'queueMs', 'role']);
      assert.equal(timing.inferenceMs, 80);
      assert.ok(Number.isFinite(timing.queueMs) && timing.queueMs >= 0);
      assert.ok(Number.isFinite(timing.elapsedMs) && timing.elapsedMs >= timing.queueMs);
    }
    assert.ok(timings[3].queueMs > timings[1].queueMs);
  } finally {
    stt.stop();
  }
});

test('bounded queue rejects excess audio and stop rejects active and queued work', async () => {
  const stt = new LocalStt({ scriptPath: fixture, maxQueueSize: 2 });
  const settings = { localSttPython: process.execPath };
  try {
    await stt.warm(settings);
    const active = stt.transcribe(settings, Buffer.alloc(4), 12345, 'zh');
    await new Promise((resolve) => setImmediate(resolve));
    const queued = [
      stt.transcribe(settings, Buffer.alloc(4), 16000, 'zh'),
      stt.transcribe(settings, Buffer.alloc(4), 16001, 'zh'),
    ];
    const stopped = Promise.allSettled([active, ...queued]);
    await assert.rejects(stt.transcribe(settings, Buffer.alloc(4), 16002, 'zh'), /队列已满/);
    assert.equal(stt.queue.length, 2);
    stt.stop();
    const results = await stopped;
    assert.ok(
      results.every(
        (result) => result.status === 'rejected' && /已停止/.test(result.reason.message),
      ),
    );
    assert.equal(stt.queue.length, 0);
    assert.equal(stt.activeTask, null);
    assert.equal(stt.pending.size, 0);
  } finally {
    stt.stop();
  }
});

test('a stalled transcription rejects the entire waiting queue and allows a clean retry', async () => {
  const stt = new LocalStt({ scriptPath: fixture, transcribeTimeoutMs: 250 });
  const settings = { localSttPython: process.execPath };
  try {
    await stt.warm(settings);
    const results = await Promise.allSettled([
      stt.transcribe(settings, Buffer.alloc(4), 12345, 'zh'),
      stt.transcribe(settings, Buffer.alloc(4), 16000, 'zh'),
    ]);
    assert.ok(
      results.every(
        (result) =>
          result.status === 'rejected' && /transcribe 请求超时/.test(result.reason.message),
      ),
    );
    assert.equal(stt.queue.length, 0);
    assert.equal(stt.pending.size, 0);
    assert.equal(stt.child, null);
    assert.equal(await stt.transcribe(settings, Buffer.alloc(4), 16000, 'zh'), '识别:16000');
  } finally {
    stt.stop();
  }
});

test('warm failure or timeout rejects waiting audio and resets initialization', async () => {
  for (const model of ['fail-warm', 'hang-warm']) {
    const stt = new LocalStt({ scriptPath: fixture, warmTimeoutMs: 150 });
    const settings = { localSttPython: process.execPath, localSttModel: model };
    try {
      const results = await Promise.allSettled([
        stt.warm(settings),
        stt.transcribe(settings, Buffer.alloc(4), 16000, 'zh'),
      ]);
      assert.ok(results.every((result) => result.status === 'rejected'));
      assert.equal(stt.queue.length, 0);
      assert.equal(stt.child, null);
      assert.equal(stt.warmPromise, null);
      assert.equal(
        await stt.transcribe({ localSttPython: process.execPath }, Buffer.alloc(4), 16000, 'zh'),
        '识别:16000',
      );
    } finally {
      stt.stop();
    }
  }
});

test('diagnostic callback failures do not lose recognized text', async () => {
  const stt = new LocalStt({ scriptPath: fixture });
  try {
    const text = await stt.transcribe(
      { localSttPython: process.execPath },
      Buffer.alloc(4),
      16000,
      'zh',
      {
        onTiming: () => {
          throw new Error('logging unavailable');
        },
      },
    );
    assert.equal(text, '识别:16000');
  } finally {
    stt.stop();
  }
});

test('switching models rejects old work without draining or stopping the new model queue', async () => {
  const stt = new LocalStt({ scriptPath: fixture });
  const settings = { localSttPython: process.execPath };
  try {
    await stt.warm(settings);
    const oldResults = Promise.allSettled([
      stt.transcribe(settings, Buffer.alloc(4), 12345, 'zh'),
      stt.transcribe(settings, Buffer.alloc(4), 16001, 'zh'),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    const timing = [];
    const newResult = stt.transcribe(
      { ...settings, localSttModel: 'new-model' },
      Buffer.alloc(4),
      16000,
      'zh',
      { role: 'untrusted-role', onTiming: (entry) => timing.push(entry) },
    );
    assert.ok((await oldResults).every((result) => result.status === 'rejected'));
    assert.equal(await newResult, '识别:16000');
    assert.equal(timing[0].role, 'unknown');
    assert.equal(stt.queue.length, 0);
  } finally {
    stt.stop();
  }
});

test('stopping a worker rejects outstanding requests and permits restart', async () => {
  const stt = new LocalStt({ scriptPath: fixture });
  const settings = { localSttPython: process.execPath };
  try {
    await stt.ensure(settings);
    const pending = stt.transcribe(settings, Buffer.alloc(4), 16000, 'zh');
    await new Promise((resolve) => setTimeout(resolve, 0));
    stt.stop();
    await assert.rejects(pending, /已停止/);
    assert.equal(stt.pending.size, 0);
    assert.equal(await stt.transcribe(settings, Buffer.alloc(4), 16000, 'zh'), '识别:16000');
  } finally {
    stt.stop();
  }
});

test('a stalled model initialization times out and can be retried', async () => {
  const stt = new LocalStt({ scriptPath: fixture, initTimeoutMs: 250 });
  try {
    await assert.rejects(
      stt.ensure({ localSttPython: process.execPath, localSttModel: 'hang' }),
      /init 请求超时/,
    );
    assert.equal(stt.child, null);
    assert.equal(stt.pending.size, 0);
    await stt.ensure({ localSttPython: process.execPath });
  } finally {
    stt.stop();
  }
});

test('a stalled transcription times out without leaving pending calls', async () => {
  const stt = new LocalStt({ scriptPath: fixture, transcribeTimeoutMs: 250 });
  const settings = { localSttPython: process.execPath };
  try {
    await assert.rejects(
      stt.transcribe(settings, Buffer.alloc(4), 12345, 'zh'),
      /transcribe 请求超时/,
    );
    assert.equal(stt.pending.size, 0);
    assert.equal(stt.child, null);
  } finally {
    stt.stop();
  }
});
