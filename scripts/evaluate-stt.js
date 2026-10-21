#!/usr/bin/env node
'use strict';

// Replays local recordings through the same VAD/client path used by the UI.
// Usage: node scripts/evaluate-stt.js <audio-dir> [reference-json] [engine] [model]
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { LocalStt } = require('../src/main/localStt');

const audioDir = process.argv[2];
if (!audioDir) {
  console.error('用法：node scripts/evaluate-stt.js <录音目录> [标准答案.json] [引擎] [模型]');
  process.exit(2);
}
const referencePath = process.argv[3];
const engine = process.argv[4] || 'qwen3-asr';
const defaultModels = {
  'qwen3-asr': 'Qwen/Qwen3-ASR-0.6B-hf',
  sensevoice: 'iic/SenseVoiceSmall',
  'faster-whisper': 'large-v3-turbo',
};
const model = process.argv[5] || defaultModels[engine] || defaultModels['qwen3-asr'];
const references = referencePath ? JSON.parse(fs.readFileSync(referencePath, 'utf8')) : {};
const worker = new LocalStt();
const settings = { localSttEngine: engine, localSttModel: model };
const diagnostics = [];
global.window = {
  api: {
    transcribeLocal: (pcm, sampleRate, language) =>
      worker.transcribe(settings, pcm, sampleRate, language),
    logSessionEvent: (entry) => diagnostics.push(entry),
  },
};
const LocalSttLive = require('../src/renderer/local-stt');

function decode(filePath) {
  const bytes = execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      filePath,
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      's16le',
      'pipe:1',
    ],
    { maxBuffer: 20 * 1024 * 1024 },
  );
  return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function normalize(text) {
  return [
    ...String(text || '')
      .toLowerCase()
      .replace(/[\s\p{P}]/gu, ''),
  ];
}

function characterErrorRate(actual, expected) {
  const a = normalize(actual);
  const b = normalize(expected);
  if (!b.length) return null;
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return Math.round((row[b.length] / b.length) * 1000) / 1000;
}

async function replay(pcm) {
  const segments = [];
  const diagnosticStart = diagnostics.length;
  const client = new LocalSttLive({
    role: 'interviewer',
    language: 'zh',
    onTranscript: ({ text, utteranceEnd }) => segments.push({ text, utteranceEnd }),
    onState: (state, info) => {
      if (state === 'error') throw new Error(info);
    },
  });
  client.connect();
  const started = performance.now();
  const originalInfo = console.info;
  console.info = () => {};
  try {
    for (let offset = 0; offset < pcm.length; offset += 1600) {
      client.send(pcm.slice(offset, offset + 1600).buffer);
    }
    // Keep the source alive after playback, as the desktop Monitor normally is.
    for (let i = 0; i < 200; i++) client.send(new Int16Array(1600).buffer);
    await client.queue;
    await client.close();
  } finally {
    console.info = originalInfo;
  }
  return {
    segments,
    vad: diagnostics.slice(diagnosticStart).filter((entry) => entry.event === 'vad_flush'),
    batchReplayMs: Math.round(performance.now() - started),
  };
}

async function main() {
  const files = fs
    .readdirSync(audioDir)
    .filter((name) => /\.(?:m4a|wav|mp3|flac|ogg)$/i.test(name))
    .sort();
  if (!files.length) throw new Error('录音目录里没有可测试的音频文件');
  const warmStarted = performance.now();
  await worker.ensure(settings);
  console.log(
    JSON.stringify({
      event: 'model_ready',
      engine,
      model,
      warmMs: Math.round(performance.now() - warmStarted),
    }),
  );
  for (const file of files) {
    const pcm = decode(path.join(audioDir, file));
    const started = performance.now();
    const full = await worker.transcribe(settings, pcm.buffer, 16000, 'zh');
    const fullMs = Math.round(performance.now() - started);
    const live = await replay(pcm);
    const liveText = live.segments.map((segment) => segment.text).join(' ');
    const expected = references[file];
    const reference = typeof expected === 'string' ? expected : expected?.reference;
    const keyTerms = typeof expected === 'object' && expected ? expected.keyTerms || [] : [];
    console.log(
      JSON.stringify({
        file,
        audioMs: Math.round(pcm.length / 16),
        fullMs,
        full,
        live: liveText,
        liveSegments: live.segments,
        vadSegments: live.vad,
        batchReplayMs: live.batchReplayMs,
        ...(reference
          ? {
              fullCer: characterErrorRate(full, reference),
              liveCer: characterErrorRate(liveText, reference),
              missingKeyTerms: keyTerms.filter(
                (term) => !normalize(liveText).join('').includes(normalize(term).join('')),
              ),
            }
          : {}),
      }),
    );
  }
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => worker.stop());
