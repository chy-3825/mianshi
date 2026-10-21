'use strict';

const readline = require('readline');
let initialized = false;
let warmed = false;
let busy = false;
let model = '';

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.command === 'init') {
    model = request.model;
    if (request.model === 'hang') return;
    setTimeout(() => {
      initialized = true;
      send({ id: request.id, ok: true, ready: true });
    }, 80);
  } else if (request.command === 'warm') {
    if (!initialized || warmed || busy) {
      send({ id: request.id, ok: false, error: 'Warm must run once after init, without overlap' });
      return;
    }
    if (model === 'hang-warm') return;
    if (model === 'fail-warm') {
      send({ id: request.id, ok: false, error: 'Synthetic warm failure' });
      return;
    }
    busy = true;
    setTimeout(() => {
      busy = false;
      warmed = true;
      send({ id: request.id, ok: true, warmMs: 40 });
    }, 40);
  } else if (request.command === 'transcribe') {
    if (!initialized || !warmed || busy) {
      send({ id: request.id, ok: false, error: 'Transcribe must run after warm, without overlap' });
      return;
    }
    busy = true;
    if (request.sampleRate === 12345) return;
    setTimeout(() => {
      busy = false;
      send({
        id: request.id,
        ok: true,
        text: model === 'echo-context' ? request.context || '无提示' : `识别:${request.sampleRate}`,
        inferenceMs: 80,
        ...(model === 'echo-context'
          ? {
              hintApplied: !!request.context,
              hintFallback: false,
              hintChars: request.context?.length || 0,
            }
          : {}),
      });
    }, 80);
  }
});
