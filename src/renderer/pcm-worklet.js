// AudioWorklet：把麦克风/系统声音的 Float32 采样转成 16-bit PCM，
// 累积到约 100ms 再 postMessage，降低消息频率。
class PCMWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    this._count = 0;
    // sampleRate 是 AudioWorkletGlobalScope 的全局变量
    this._target = Math.max(1024, Math.floor(sampleRate * 0.1));
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length && input[0]) {
      const channels = input.filter((channel) => channel && channel.length);
      if (!channels.length) return true;
      const length = channels[0].length; // AudioWorklet 常见为 128 帧
      const mono = new Float32Array(length);
      // System audio can put speech in either stereo channel. Average every
      // channel instead of silently dropping everything except the first.
      for (const channel of channels) {
        for (let i = 0; i < length; i++) mono[i] += channel[i] || 0;
      }
      for (let i = 0; i < length; i++) mono[i] /= channels.length;
      this._buf.push(mono);
      this._count += length;

      if (this._count >= this._target) {
        const merged = new Int16Array(this._count);
        let o = 0;
        for (const frame of this._buf) {
          for (let i = 0; i < frame.length; i++) {
            let s = frame[i];
            if (s > 1) s = 1;
            else if (s < -1) s = -1;
            merged[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
        }
        this._buf = [];
        this._count = 0;
        this.port.postMessage(merged.buffer, [merged.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('pcm-worklet', PCMWorklet);
