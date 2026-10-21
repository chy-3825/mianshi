'use strict';
/* global module */

// Browser-side utterance splitter. Audio stays local and is sent to Electron's
// persistent local ASR worker after a short silence.
let nextSttClientId = 0;

const SILENCE_SECONDS = 0.65;
const MAX_SEGMENT_SECONDS = 18;
const PRE_ROLL_SECONDS = 0.25;
// Ignore isolated clicks, but recognize a 0.3-second spoken word promptly.
const MIN_SPEECH_SECONDS = 0.16;
const MIN_MEAN_ABS_PCM = 240;

function roundMetric(value) {
  return Math.round(value * 10000) / 10000;
}

function logStt(event, fields) {
  if (typeof window === 'undefined') return;
  Promise.resolve(window.api?.logSessionEvent?.({ event, ...fields })).catch(() => {});
}

class LocalSttLive {
  constructor(opts) {
    this.sttId = ++nextSttClientId;
    this.segmentId = 0;
    this.role = opts.role || 'unknown';
    this.language = opts.language || 'zh';
    this.sampleRate = opts.sampleRate || 16000;
    this.onTranscript = opts.onTranscript || (() => {});
    this.onSpeechStart = opts.onSpeechStart || (() => {});
    this.onUtteranceEnd = opts.onUtteranceEnd || (() => {});
    this.onState = opts.onState || (() => {});
    this.chunks = [];
    this.samples = 0;
    this.speechSamples = 0;
    this.silenceSamples = 0;
    this.sumSquares = 0;
    this.peakSample = 0;
    this.preRollChunks = [];
    this.preRollSamples = 0;
    this.inputSamples = 0;
    this.startedInputSample = null;
    this.lastFlushInputSample = null;
    this.lastFlushReason = null;
    this.lastFlushedRms = 0;
    this.lastFlushedSpeechMs = 0;
    this.active = false;
    this.maxSplitPending = false;
    this.trailingSilenceSamples = 0;
    this.closed = false;
    this.closing = false;
    this.closePromise = null;
    this.queue = Promise.resolve();
    this.pendingSegments = 0;
  }

  connect() {
    this.closed = false;
    this.onState('open');
  }

  // Keep only the preceding 250ms, even during hours of silence. This gives
  // the recognizer a quiet lead-in and recovers low-volume initial syllables.
  rememberPreRoll(samples) {
    const limit = Math.round(this.sampleRate * PRE_ROLL_SECONDS);
    if (samples.length >= limit) {
      this.preRollChunks = [new Int16Array(samples.subarray(samples.length - limit))];
      this.preRollSamples = limit;
      return;
    }
    this.preRollChunks.push(new Int16Array(samples));
    this.preRollSamples += samples.length;
    while (this.preRollSamples > limit && this.preRollChunks.length) {
      const oldest = this.preRollChunks[0];
      const excess = this.preRollSamples - limit;
      if (oldest.length <= excess) {
        this.preRollChunks.shift();
        this.preRollSamples -= oldest.length;
      } else {
        this.preRollChunks[0] = oldest.subarray(excess);
        this.preRollSamples -= excess;
      }
    }
  }

  append(samples) {
    const copy = new Int16Array(samples);
    this.chunks.push(copy);
    this.samples += copy.length;
    for (const sample of copy) {
      this.sumSquares += sample * sample;
      this.peakSample = Math.max(this.peakSample, Math.abs(sample));
    }
  }

  resetSegment() {
    this.chunks = [];
    this.samples = 0;
    this.speechSamples = 0;
    this.silenceSamples = 0;
    this.sumSquares = 0;
    this.peakSample = 0;
    this.active = false;
    this.startedInputSample = null;
  }

  send(buffer) {
    if (this.closed || this.closing) return;
    const samples = new Int16Array(buffer);
    if (!samples.length) return;
    this.inputSamples += samples.length;
    let energy = 0;
    for (const sample of samples) energy += Math.abs(sample);
    const speech = energy / samples.length > MIN_MEAN_ABS_PCM;
    if (this.maxSplitPending) {
      if (speech) {
        this.maxSplitPending = false;
        this.trailingSilenceSamples = 0;
      } else {
        this.trailingSilenceSamples += samples.length;
        if (this.trailingSilenceSamples >= this.sampleRate * SILENCE_SECONDS) {
          this.maxSplitPending = false;
          this.trailingSilenceSamples = 0;
          // Wait for the preceding forced chunk's ASR result before telling
          // the UI that the utterance has actually ended.
          this.queue = this.queue.then(() => {
            if (!this.closed && !this.active && !this.pendingSegments) this.onUtteranceEnd();
          });
        }
      }
    }
    if (speech) {
      if (!this.active) {
        this.onSpeechStart();
        this.active = true;
        this.startedInputSample = this.inputSamples - samples.length;
        for (const chunk of this.preRollChunks) this.append(chunk);
        this.preRollChunks = [];
        this.preRollSamples = 0;
      }
      this.speechSamples += samples.length;
      this.silenceSamples = 0;
    } else if (this.active) {
      this.silenceSamples += samples.length;
    } else {
      this.rememberPreRoll(samples);
      return;
    }
    this.append(samples);
    if (this.silenceSamples >= this.sampleRate * SILENCE_SECONDS) {
      if (this.speechSamples >= this.sampleRate * MIN_SPEECH_SECONDS) {
        this.flush('silence');
      } else {
        // Do not feed isolated clicks or tiny sound effects into ASR.
        this.resetSegment();
        this.queue = this.queue.then(() => {
          if (!this.closed && !this.active && !this.pendingSegments) this.onUtteranceEnd();
        });
      }
    } else if (this.samples >= this.sampleRate * MAX_SEGMENT_SECONDS) {
      this.flush('max_duration');
    }
  }

  flush(reason = 'silence') {
    if (!this.samples) return;
    const metrics = {
      audioMs: Math.round((this.samples / this.sampleRate) * 1000),
      speechMs: Math.round((this.speechSamples / this.sampleRate) * 1000),
      rms: roundMetric(Math.sqrt(this.sumSquares / this.samples) / 32768),
      peak: roundMetric(this.peakSample / 32768),
    };
    const gapMs =
      this.lastFlushInputSample === null || this.startedInputSample === null
        ? Infinity
        : ((this.startedInputSample - this.lastFlushInputSample) / this.sampleRate) * 1000;
    // A very short, unusually quiet tail immediately after a normal question
    // is likely a sound effect or breath. Avoid asking ASR to hallucinate a
    // standalone word. A first/independent short question is never filtered.
    if (
      reason === 'silence' &&
      this.lastFlushReason === 'silence' &&
      this.lastFlushedSpeechMs >= 500 &&
      gapMs >= 0 &&
      gapMs <= 1500 &&
      metrics.speechMs < 350 &&
      metrics.rms < 0.03 &&
      metrics.rms < this.lastFlushedRms * 0.15
    ) {
      const segmentId = ++this.segmentId;
      if (this.role === 'interviewer') {
        logStt('vad_discard', {
          role: this.role,
          sttId: this.sttId,
          segmentId,
          reason: 'weak_short_tail',
          ...metrics,
        });
      }
      this.resetSegment();
      this.queue = this.queue.then(() => {
        if (!this.closed && !this.active && !this.pendingSegments) this.onUtteranceEnd();
      });
      return;
    }
    const merged = new Int16Array(this.samples);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.lastFlushInputSample = this.inputSamples;
    this.lastFlushReason = reason;
    this.lastFlushedRms = metrics.rms;
    this.lastFlushedSpeechMs = metrics.speechMs;
    this.resetSegment();
    if (reason === 'max_duration') this.maxSplitPending = true;
    const timing = {
      sttId: this.sttId,
      segmentId: ++this.segmentId,
      vadFlushAtMs: Date.now(),
    };
    if (this.role === 'interviewer') {
      logStt('vad_flush', {
        role: this.role,
        sttId: timing.sttId,
        segmentId: timing.segmentId,
        reason,
        ...metrics,
      });
      console.info(
        JSON.stringify({
          event: 'vad_flush',
          role: this.role,
          sttId: timing.sttId,
          segmentId: timing.segmentId,
          atMs: timing.vadFlushAtMs,
          reason,
          ...metrics,
        }),
      );
    }
    this.pendingSegments++;
    this.queue = this.queue
      .then(() =>
        window.api.transcribeLocal(merged.buffer, this.sampleRate, this.language, this.role, {
          sttId: timing.sttId,
          segmentId: timing.segmentId,
        }),
      )
      .then((text) => {
        this.pendingSegments--;
        if (this.closed) return;
        timing.asrFinalAtMs = Date.now();
        if (this.role === 'interviewer') {
          logStt('asr_final', {
            role: this.role,
            sttId: timing.sttId,
            segmentId: timing.segmentId,
            reason,
            text,
            elapsedMs: timing.asrFinalAtMs - timing.vadFlushAtMs,
          });
          console.info(
            JSON.stringify({
              event: 'asr_final',
              role: this.role,
              sttId: timing.sttId,
              segmentId: timing.segmentId,
              atMs: timing.asrFinalAtMs,
              vadToAsrMs: timing.asrFinalAtMs - timing.vadFlushAtMs,
              reason,
            }),
          );
        }
        if (text)
          this.onTranscript({
            text,
            isFinal: true,
            utteranceEnd: reason !== 'max_duration',
            speechActive: this.active || this.pendingSegments > 0,
            timing,
          });
        else if (reason !== 'max_duration' && !this.active && !this.pendingSegments)
          this.onUtteranceEnd();
      })
      .catch((e) => {
        // Errors from callbacks must not decrement the queue count twice.
        if (!timing.asrFinalAtMs) this.pendingSegments--;
        this.onState('error', e.message);
        if (reason !== 'max_duration' && !this.active && !this.pendingSegments)
          this.onUtteranceEnd();
      });
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    if (this.samples && this.speechSamples >= this.sampleRate * MIN_SPEECH_SECONDS) {
      this.flush('close');
    } else {
      this.resetSegment();
    }
    this.maxSplitPending = false;
    this.preRollChunks = [];
    this.preRollSamples = 0;
    this.closePromise = this.queue.finally(() => {
      this.closed = true;
      this.onState('closed');
    });
    return this.closePromise;
  }
}

if (typeof window !== 'undefined') window.LocalSttLive = LocalSttLive;
if (typeof module !== 'undefined') module.exports = LocalSttLive;
