'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateAnswerStream } = require('../src/main/openaiCompat');

function streamResponse(chunks) {
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () =>
          index < chunks.length
            ? { value: Buffer.from(chunks[index++]), done: false }
            : { value: undefined, done: true },
      }),
    },
  };
}

test('stream timing reports stages and counts without exposing request or reasoning text', async () => {
  const originalFetch = globalThis.fetch;
  const events = [];
  const chunks = [];
  let requestBody;
  try {
    globalThis.fetch = async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return streamResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"private reasoning"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    };

    const answer = await generateAnswerStream({
      apiKey: 'private-key',
      model: 'test-model',
      systemInstruction: 'private system',
      userText: 'private prompt',
      thinking: { type: 'disabled' },
      onTiming: (event) => events.push(event),
      onChunk: (delta) => chunks.push(delta),
    });

    assert.equal(answer, '你好');
    assert.deepEqual(chunks, ['你', '好']);
    assert.deepEqual(requestBody.thinking, { type: 'disabled' });
    assert.deepEqual(
      events.map((event) => event.stage),
      ['request-start', 'response-headers', 'first-reasoning', 'first-content', 'complete'],
    );
    assert.equal(events[1].status, 200);
    assert.deepEqual(
      {
        outcome: events.at(-1).outcome,
        reasoningFragments: events.at(-1).reasoningFragments,
        contentFragments: events.at(-1).contentFragments,
      },
      { outcome: 'success', reasoningFragments: 1, contentFragments: 2 },
    );
    assert.ok(events.every((event) => event.elapsedMs >= 0));
    assert.ok(events.every((event, i) => i === 0 || event.elapsedMs >= events[i - 1].elapsedMs));
    const report = JSON.stringify(events);
    for (const secret of ['private-key', 'private system', 'private prompt', 'private reasoning']) {
      assert.equal(report.includes(secret), false);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('thinking is omitted by default and timing observer errors do not interrupt generation', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  try {
    globalThis.fetch = async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return streamResponse(['data: {"choices":[{"delta":{"content":"OK"}}]}\n\n']);
    };
    const answer = await generateAnswerStream({
      model: 'test-model',
      systemInstruction: '',
      userText: 'test',
      onTiming: () => {
        throw new Error('observer failed');
      },
    });
    assert.equal(answer, 'OK');
    assert.equal(Object.hasOwn(requestBody, 'thinking'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('failed responses report completion with error outcome', async () => {
  const originalFetch = globalThis.fetch;
  const events = [];
  try {
    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      body: null,
      text: async () => 'busy',
    });
    await assert.rejects(
      generateAnswerStream({
        model: 'test-model',
        systemInstruction: '',
        userText: 'test',
        onTiming: (event) => events.push(event),
      }),
      /503/,
    );
    assert.deepEqual(
      events.map((event) => event.stage),
      ['request-start', 'response-headers', 'complete'],
    );
    assert.equal(events.at(-1).outcome, 'error');
    assert.equal(events.at(-1).status, 503);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('stream usage is measured without enabling unsupported request options or retaining extra fields', async () => {
  const originalFetch = globalThis.fetch;
  const events = [];
  try {
    globalThis.fetch = async (_url, options) => {
      assert.equal(Object.hasOwn(JSON.parse(options.body), 'stream_options'), false);
      return streamResponse([
        'data: {"choices":[{"delta":{"content":"答案"},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120,"prompt_tokens_details":{"cached_tokens":60},"private":"do not log"}}\n\n',
        'data: [DONE]\n\n',
      ]);
    };
    assert.equal(
      await generateAnswerStream({
        model: 'test',
        userText: 'test',
        onTiming: (e) => events.push(e),
      }),
      '答案',
    );
    const complete = events.at(-1);
    assert.equal(complete.promptTokens, 100);
    assert.equal(complete.completionTokens, 20);
    assert.equal(complete.totalTokens, 120);
    assert.equal(complete.cachedPromptTokens, 60);
    assert.equal(complete.finishReason, 'stop');
    assert.equal(JSON.stringify(events).includes('do not log'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
