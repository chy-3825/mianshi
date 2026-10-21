'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const LocalSttLive = require('../src/renderer/local-stt');

test('18-second max-duration chunk is not marked as a completed question', async () => {
  const originalWindow = globalThis.window;
  const events = [];
  let transcriptions = 0;
  globalThis.window = {
    api: {
      transcribeLocal: async () => `语音片段 ${++transcriptions}`,
    },
  };
  try {
    const stt = new LocalSttLive({
      role: 'test',
      sampleRate: 100,
      onTranscript: (event) => events.push(event),
    });
    stt.connect();
    stt.send(new Int16Array(1800).fill(1000).buffer);
    stt.send(new Int16Array(40).fill(1000).buffer);
    stt.send(new Int16Array(65).buffer);
    await stt.queue;

    assert.equal(events.length, 2);
    assert.equal(events[0].utteranceEnd, false);
    assert.equal(events[1].utteranceEnd, true);
    assert.equal(events[1].timing.segmentId, events[0].timing.segmentId + 1);
    assert.ok(events[0].timing.asrFinalAtMs >= events[0].timing.vadFlushAtMs);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('silence after a max-duration split ends the utterance after ASR completes', async () => {
  const originalWindow = globalThis.window;
  const events = [];
  globalThis.window = {
    api: { transcribeLocal: async () => '长问题的最后一段' },
  };
  try {
    const stt = new LocalSttLive({
      role: 'test',
      sampleRate: 100,
      onTranscript: (event) => events.push(event.utteranceEnd ? 'final' : 'chunk'),
      onUtteranceEnd: () => events.push('end'),
    });
    stt.connect();
    stt.send(new Int16Array(1800).fill(1000).buffer);
    stt.send(new Int16Array(65).buffer);
    await stt.queue;
    assert.deepEqual(events, ['chunk', 'end']);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('0.3-second speech followed by silence flushes promptly and logs audio metrics', async () => {
  const originalWindow = globalThis.window;
  const transcripts = [];
  const logs = [];
  let asrCalls = 0;
  globalThis.window = {
    api: {
      transcribeLocal: async () => {
        asrCalls++;
        return '请介绍项目';
      },
      logSessionEvent: (entry) => logs.push(entry),
    },
  };
  try {
    const stt = new LocalSttLive({
      role: 'interviewer',
      sampleRate: 1000,
      onTranscript: (event) => transcripts.push(event),
    });
    stt.connect();
    stt.send(new Int16Array(300).fill(1000).buffer);
    stt.send(new Int16Array(700).buffer);
    stt.send(new Int16Array(17000).buffer);
    await stt.queue;

    assert.equal(asrCalls, 1);
    assert.equal(transcripts.length, 1);
    assert.equal(transcripts[0].utteranceEnd, true);
    const flush = logs.find((event) => event.event === 'vad_flush');
    assert.equal(flush.reason, 'silence');
    assert.equal(flush.audioMs, 1000);
    assert.equal(flush.speechMs, 300);
    assert.ok(flush.rms > 0);
    assert.ok(flush.peak > flush.rms);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('pre-roll recovers weak speech onset that is below the VAD threshold', async () => {
  const originalWindow = globalThis.window;
  let audio;
  globalThis.window = {
    api: {
      transcribeLocal: async (buffer) => {
        audio = new Int16Array(buffer);
        return '完整问题';
      },
    },
  };
  try {
    const stt = new LocalSttLive({ role: 'test', sampleRate: 1000 });
    stt.connect();
    stt.send(new Int16Array(100).fill(200).buffer);
    stt.send(new Int16Array(300).fill(1000).buffer);
    stt.send(new Int16Array(650).buffer);
    await stt.queue;
    assert.equal(audio.length, 1050);
    assert.deepEqual([...audio.subarray(0, 100)], Array(100).fill(200));
  } finally {
    globalThis.window = originalWindow;
  }
});

test('isolated 0.1-second transient does not invoke ASR or block utterance end', async () => {
  const originalWindow = globalThis.window;
  let asrCalls = 0;
  let ended = 0;
  globalThis.window = { api: { transcribeLocal: async () => asrCalls++ } };
  try {
    const stt = new LocalSttLive({
      role: 'test',
      sampleRate: 1000,
      onUtteranceEnd: () => ended++,
    });
    stt.connect();
    stt.send(new Int16Array(100).fill(1000).buffer);
    stt.send(new Int16Array(700).buffer);
    await stt.queue;
    assert.equal(asrCalls, 0);
    assert.equal(ended, 1);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('a short weak tail directly after a loud question is logged and skipped', async () => {
  const originalWindow = globalThis.window;
  const logs = [];
  let asrCalls = 0;
  globalThis.window = {
    api: {
      transcribeLocal: async () => {
        asrCalls++;
        return '刚才的问题';
      },
      logSessionEvent: (entry) => logs.push(entry),
    },
  };
  try {
    const stt = new LocalSttLive({ role: 'interviewer', sampleRate: 1000 });
    stt.connect();
    stt.send(new Int16Array(1000).fill(6000).buffer);
    stt.send(new Int16Array(650).buffer);
    stt.send(new Int16Array(300).fill(1000).buffer);
    stt.send(new Int16Array(700).buffer);
    await stt.queue;

    assert.equal(asrCalls, 1);
    const discarded = logs.find((event) => event.event === 'vad_discard');
    assert.equal(discarded.reason, 'weak_short_tail');
    assert.equal(discarded.speechMs, 300);
    assert.ok(discarded.rms < 0.03);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('a separate weak 0.3-second question after a long pause is retained', async () => {
  const originalWindow = globalThis.window;
  let asrCalls = 0;
  globalThis.window = {
    api: {
      transcribeLocal: async () => {
        asrCalls++;
        return '问题';
      },
    },
  };
  try {
    const stt = new LocalSttLive({ role: 'test', sampleRate: 1000 });
    stt.connect();
    stt.send(new Int16Array(1000).fill(6000).buffer);
    stt.send(new Int16Array(650).buffer);
    stt.send(new Int16Array(2500).buffer);
    stt.send(new Int16Array(300).fill(1000).buffer);
    stt.send(new Int16Array(700).buffer);
    await stt.queue;
    assert.equal(asrCalls, 2);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('queued ASR keeps the earlier result marked active until the continuation is recognized', async () => {
  const originalWindow = globalThis.window;
  const events = [];
  const roles = [];
  let finishFirst;
  let calls = 0;
  globalThis.window = {
    api: {
      transcribeLocal: (_pcm, _rate, _language, role) => {
        roles.push(role);
        if (++calls === 1) return new Promise((resolve) => (finishFirst = resolve));
        return Promise.resolve('分别用在哪里？');
      },
    },
  };
  try {
    const stt = new LocalSttLive({
      role: 'test',
      sampleRate: 1000,
      onTranscript: (event) => events.push(event),
    });
    stt.connect();
    stt.send(new Int16Array(500).fill(3000).buffer);
    stt.send(new Int16Array(700).buffer);
    await Promise.resolve();
    stt.send(new Int16Array(600).fill(3000).buffer);
    stt.send(new Int16Array(700).buffer);
    finishFirst('乐观锁和悲观锁是什么？');
    await stt.queue;
    assert.deepEqual(
      events.map((event) => event.speechActive),
      [true, false],
    );
    assert.deepEqual(roles, ['test', 'test']);
    assert.equal(stt.pendingSegments, 0);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('an empty ASR result releases the speech hold for the previous pending question', async () => {
  const originalWindow = globalThis.window;
  let ended = 0;
  globalThis.window = { api: { transcribeLocal: async () => '' } };
  try {
    const stt = new LocalSttLive({
      role: 'test',
      sampleRate: 1000,
      onUtteranceEnd: () => ended++,
    });
    stt.send(new Int16Array(500).fill(3000).buffer);
    stt.send(new Int16Array(700).buffer);
    await stt.queue;
    assert.equal(ended, 1);
    assert.equal(stt.pendingSegments, 0);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('close waits for the pending final segment and does not submit it twice', async () => {
  const originalWindow = globalThis.window;
  const events = [];
  let asrCalls = 0;
  globalThis.window = {
    api: {
      transcribeLocal: async () => {
        asrCalls++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return '最后一句';
      },
    },
  };
  try {
    const stt = new LocalSttLive({
      role: 'test',
      sampleRate: 1000,
      onTranscript: (event) => events.push(event),
    });
    stt.connect();
    stt.send(new Int16Array(300).fill(1000).buffer);
    const closing = stt.close();
    assert.equal(stt.close(), closing);
    stt.send(new Int16Array(300).fill(1000).buffer);
    await closing;
    assert.equal(asrCalls, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].text, '最后一句');
    assert.equal(events[0].utteranceEnd, true);
    assert.equal(stt.closed, true);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('close drains an already queued segment before the unsent tail', async () => {
  const originalWindow = globalThis.window;
  const texts = [];
  let call = 0;
  globalThis.window = {
    api: {
      transcribeLocal: async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return `片段 ${++call}`;
      },
    },
  };
  try {
    const stt = new LocalSttLive({
      role: 'test',
      sampleRate: 1000,
      onTranscript: (event) => texts.push(event.text),
    });
    stt.connect();
    stt.send(new Int16Array(300).fill(1000).buffer);
    stt.send(new Int16Array(650).buffer);
    stt.send(new Int16Array(300).fill(1000).buffer);
    await stt.close();
    assert.deepEqual(texts, ['片段 1', '片段 2']);
    assert.equal(call, 2);
  } finally {
    globalThis.window = originalWindow;
  }
});
