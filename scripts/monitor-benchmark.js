#!/usr/bin/env node
'use strict';

// Separate sampler: /proc resident memory and nvidia-smi per-process VRAM.
// It does not execute inference or change benchmark/application configuration.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { writePrivateJson } = require('../src/main/private-json');

const [pidText, resultFile, outputFile] = process.argv.slice(2);
if (!/^\d+$/.test(pidText || '') || !resultFile || !outputFile) {
  throw new Error(
    '用法：node scripts/monitor-benchmark.js <worker PID> <结果.json> <新资源记录.json>',
  );
}
const workerPid = Number(pidText);
const root = path.resolve(__dirname, '../artifacts/benchmark-100');
const output = path.resolve(outputFile);
if (!output.startsWith(root + path.sep) || fs.existsSync(output))
  throw new Error('输出必须是测试目录内的新文件');
const report = {
  startedAt: new Date().toISOString(),
  workerPid,
  intervalMs: 5000,
  note: '续跑阶段采样，未覆盖最初冷启动；GPU数值为该ASR进程的显存占用，RSS/HWM来自Linux /proc。周期采样的GPU峰值可能漏掉短瞬时峰值。',
  samples: [],
};
let timer;
function sample() {
  let status;
  try {
    status = fs.readFileSync(`/proc/${workerPid}/status`, 'utf8');
  } catch (_error) {
    return finish('worker_exited');
  }
  const field = (name) => Number(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(status)?.[1]) || null;
  const metric = {
    at: new Date().toISOString(),
    rssKiB: field('VmRSS'),
    highWaterRssKiB: field('VmHWM'),
  };
  try {
    const text = execFileSync(
      'nvidia-smi',
      ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', timeout: 3000 },
    );
    const entry = text
      .split('\n')
      .map((line) => line.split(',').map((value) => value.trim()))
      .find((entry) => Number(entry[0]) === workerPid);
    metric.vramMiB = entry && Number.isFinite(Number(entry[1])) ? Number(entry[1]) : null;
  } catch (_error) {
    metric.vramMiB = null;
  }
  report.samples.push(metric);
  report.peakRssKiB = Math.max(
    ...report.samples.map((sample) => sample.highWaterRssKiB || sample.rssKiB || 0),
  );
  report.peakVramMiB = Math.max(...report.samples.map((sample) => sample.vramMiB || 0));
  writePrivateJson(output, report);
  try {
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    if (result.finishedAt && (result.completed || result.stopReason))
      return finish('benchmark_finished');
  } catch (_error) {
    /* The benchmark can be writing its first checkpoint. */
  }
  timer = setTimeout(sample, report.intervalMs);
}
function finish(reason) {
  if (timer) clearTimeout(timer);
  report.finishedAt = new Date().toISOString();
  report.reason = reason;
  writePrivateJson(output, report);
  console.log(
    JSON.stringify({
      event: 'resource_sampling_complete',
      samples: report.samples.length,
      peakRssKiB: report.peakRssKiB,
      peakVramMiB: report.peakVramMiB,
    }),
  );
}
console.log(JSON.stringify({ event: 'resource_sampling_start', workerPid }));
sample();
