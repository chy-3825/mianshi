'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runSelfCheck, toPcm16, summarize } = require('../src/main/selfCheck');

const gpuProbe = async () => ({ name: 'Test GPU', memoryMiB: 12288 });
const provider = () => ({
  id: 'custom',
  label: '自定义接口',
  type: 'openai',
  needsKey: true,
  apiKey: 'private-test-key',
  baseURL: 'https://example.invalid',
  models: ['test-model'],
  streamFn: async () => '2',
});

test('self-check reports local STT and answer timings without including private data', async () => {
  const report = await runSelfCheck({
    settings: { sttProvider: 'local' },
    localStt: {
      ensure: async () => {},
      transcribe: async () => '这是私人转写文本',
    },
    resolveProvider: provider,
    generateWithFallback: async ({ onChunk }) => {
      onChunk('2');
      return { model: 'test-model', text: '2' };
    },
    gpuProbe,
    pcm: Array(16000).fill(0.1),
    sampleRate: 16000,
    audio: { micDeviceCount: 1, interviewerSource: 'input', micPermissionState: 'granted' },
  });
  assert.equal(report.summary, 'warning');
  assert.equal(report.checks.find((x) => x.id === 'microphone').status, 'pass');
  assert.equal(report.checks.find((x) => x.id === 'interviewer-audio').status, 'warning');
  assert.equal(report.checks.find((x) => x.id === 'stt-sample').metrics.chars, 8);
  assert.equal(report.checks.find((x) => x.id === 'answer').status, 'pass');
  assert.doesNotMatch(JSON.stringify(report), /private-test-key|私人转写文本|example.invalid/);
});

test('self-check exposes missing provider configuration and STT failure as structured results', async () => {
  const report = await runSelfCheck({
    settings: { sttProvider: 'local' },
    localStt: {
      ensure: async () => {
        throw Object.assign(new Error('secret path ENOENT'), { code: 'ENOENT' });
      },
    },
    resolveProvider: () => ({ ...provider(), apiKey: '' }),
    generateWithFallback: async () => {
      throw new Error('must not run');
    },
    gpuProbe,
  });
  assert.equal(report.summary, 'fail');
  assert.equal(report.checks.find((x) => x.id === 'stt').status, 'fail');
  assert.equal(report.checks.find((x) => x.id === 'answer').status, 'fail');
  assert.doesNotMatch(JSON.stringify(report), /secret path/);
});

test('PCM validation and summary are bounded', () => {
  assert.throws(() => toPcm16([0]), /0.5–10 秒/);
  assert.throws(() => toPcm16(Array(8000).fill(NaN)), /录音数据无效/);
  assert.equal(toPcm16(Array(8000).fill(0.5)).byteLength, 16000);
  assert.equal(summarize([{ status: 'skipped' }]), 'pass');
  assert.equal(summarize([{ status: 'warning' }]), 'warning');
  assert.equal(summarize([{ status: 'fail' }]), 'fail');
});

test('self-check shares warmup and separates queued time from actual inference', async () => {
  let warmed = 0;
  const report = await runSelfCheck({
    settings: { sttProvider: 'local' },
    localStt: {
      warm: async () => {
        warmed++;
      },
      ensure: async () => {
        throw new Error('warmup must be used');
      },
      transcribe: async (_settings, _pcm, _rate, _language, { onTiming }) => {
        onTiming({ queueMs: 300, inferenceMs: 125, elapsedMs: 425 });
        return '测试';
      },
    },
    resolveProvider: () => ({ ...provider(), apiKey: '' }),
    generateWithFallback: async () => {
      throw new Error('must not call unconfigured model');
    },
    gpuProbe,
    pcm: Array(8000).fill(0.1),
    sampleRate: 16000,
  });
  assert.equal(warmed, 1);
  const sample = report.checks.find((check) => check.id === 'stt-sample').metrics;
  assert.equal(sample.inferenceMs, 125);
  assert.equal(sample.queueMs, 300);
});
