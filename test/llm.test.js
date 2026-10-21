'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { generateWithFallback, GenError } = require('../src/main/llm');

// 用一个假的 streamFn 来测试重试/兜底逻辑，不触网。
function makeStreamFn(plan) {
  // plan: { [model]: 'ok' | statusCode } ; 'ok' 会调用 onStart 并返回文本
  const calls = [];
  const fn = async ({ model, onStart, onChunk }) => {
    calls.push(model);
    const outcome = plan[model];
    if (outcome === 'ok') {
      if (onStart) onStart();
      if (onChunk) onChunk('hello from ' + model);
      return 'hello from ' + model;
    }
    throw new GenError(outcome, `fake ${outcome}`);
  };
  fn.calls = calls;
  return fn;
}

test('returns first model when it succeeds', async () => {
  const fn = makeStreamFn({ a: 'ok', b: 'ok' });
  const r = await generateWithFallback({ streamFn: fn, models: ['a', 'b'], retries: 0 });
  assert.equal(r.model, 'a');
  assert.equal(r.text, 'hello from a');
  assert.deepEqual(fn.calls, ['a']);
});

test('falls back to next model on transient 503', async () => {
  const fn = makeStreamFn({ a: 503, b: 'ok' });
  const r = await generateWithFallback({ streamFn: fn, models: ['a', 'b'], retries: 0 });
  assert.equal(r.model, 'b');
  assert.deepEqual(fn.calls, ['a', 'b']);
});

test('retries the same model on transient error before falling back', async () => {
  const fn = makeStreamFn({ a: 429, b: 'ok' });
  const r = await generateWithFallback({ streamFn: fn, models: ['a', 'b'], retries: 1 });
  assert.equal(r.model, 'b');
  // a tried twice (1 retry), then b
  assert.deepEqual(fn.calls, ['a', 'a', 'b']);
});

test('does not fall back on non-transient (400) — moves on but reports last error', async () => {
  const fn = makeStreamFn({ a: 400, b: 400 });
  await assert.rejects(
    () => generateWithFallback({ streamFn: fn, models: ['a', 'b'], retries: 0 }),
    /fake 400/,
  );
  assert.deepEqual(fn.calls, ['a', 'b']);
});

test('AbortError is not retried and propagates', async () => {
  const fn = async ({ onStart }) => {
    void onStart;
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  };
  await assert.rejects(() => generateWithFallback({ streamFn: fn, models: ['a', 'b'] }), /aborted/);
});

test('once streaming started, an error is not swallowed by fallback', async () => {
  const calls = [];
  const fn = async ({ model, onStart }) => {
    calls.push(model);
    onStart(); // started
    throw new GenError(503, 'mid-stream'); // should NOT fall back after start
  };
  await assert.rejects(
    () => generateWithFallback({ streamFn: fn, models: ['a', 'b'], retries: 1 }),
    /mid-stream/,
  );
  assert.deepEqual(calls, ['a']);
});

test('retries a known fetch connection failure once before response starts', async () => {
  let calls = 0;
  const result = await generateWithFallback({
    models: ['a'],
    streamFn: async ({ onStart }) => {
      calls++;
      if (calls === 1)
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error(), { code: 'ECONNRESET' }),
        });
      onStart();
      return 'recovered';
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.text, 'recovered');
});

test('network retry is bounded and never duplicates a started response', async () => {
  for (const started of [false, true]) {
    let calls = 0;
    await assert.rejects(
      () =>
        generateWithFallback({
          models: ['a', ...(started ? ['b'] : [])],
          streamFn: async ({ onStart }) => {
            calls++;
            if (started) onStart();
            throw new TypeError('fetch failed', {
              cause: Object.assign(new Error(), { code: 'UND_ERR_SOCKET' }),
            });
          },
        }),
      /fetch failed/,
    );
    assert.equal(calls, started ? 1 : 2);
  }
});

test('unknown TypeError and invalid TLS configuration are not retried', async () => {
  for (const code of [undefined, 'ERR_INVALID_URL', 'CERT_HAS_EXPIRED']) {
    let calls = 0;
    await assert.rejects(() =>
      generateWithFallback({
        models: ['a'],
        streamFn: async () => {
          calls++;
          throw new TypeError('failed', { cause: { code } });
        },
      }),
    );
    assert.equal(calls, 1);
  }
});

test('cancelling during backoff stops before another request', async () => {
  const controller = new AbortController();
  let calls = 0;
  const task = generateWithFallback({
    models: ['a', 'b'],
    signal: controller.signal,
    streamFn: async () => {
      calls++;
      setTimeout(() => controller.abort(), 10);
      throw new GenError(503, 'temporarily unavailable');
    },
  });
  await assert.rejects(() => task, { name: 'AbortError' });
  assert.equal(calls, 1);
});
