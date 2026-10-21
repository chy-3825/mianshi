'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createWorklet() {
  let Worklet;
  const posted = [];
  class FakeAudioWorkletProcessor {
    constructor() {
      this.port = { postMessage: (buffer) => posted.push(buffer) };
    }
  }
  const script = fs.readFileSync(path.join(__dirname, '../src/renderer/pcm-worklet.js'), 'utf8');
  vm.runInNewContext(script, {
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    registerProcessor: (_name, constructor) => {
      Worklet = constructor;
    },
    sampleRate: 16000,
  });
  return { worklet: new Worklet(), posted };
}

test('PCM worklet downmixes both stereo channels and keeps right-only speech', () => {
  const { worklet, posted } = createWorklet();
  const left = new Float32Array(1600);
  const right = new Float32Array(1600).fill(0.5);
  worklet.process([[left, right]]);

  assert.equal(posted.length, 1);
  const pcm = new Int16Array(posted[0]);
  assert.equal(pcm.length, 1600);
  assert.ok(pcm.every((value) => Math.abs(value - 8191) <= 1));
});

test('PCM worklet preserves mono input level', () => {
  const { worklet, posted } = createWorklet();
  worklet.process([[new Float32Array(1600).fill(0.5)]]);
  assert.equal(posted.length, 1);
  assert.ok(new Int16Array(posted[0]).every((value) => Math.abs(value - 16383) <= 1));
});
