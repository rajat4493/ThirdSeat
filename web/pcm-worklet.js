// AudioWorklet: converts Float32 audio to 16-bit PCM (interleaved when stereo) in ~100 ms frames.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.frames = 0;
    this.target = Math.round(sampleRate / 10);
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;
    const channels = input.length;
    const n = input[0].length;
    const out = new Int16Array(n * channels);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < channels; c++) {
        const s = Math.max(-1, Math.min(1, input[c][i]));
        out[i * channels + c] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
    }
    this.chunks.push(out);
    this.frames += n;
    if (this.frames >= this.target) {
      const merged = new Int16Array(this.chunks.reduce((s, c) => s + c.length, 0));
      let o = 0;
      for (const c of this.chunks) {
        merged.set(c, o);
        o += c.length;
      }
      this.port.postMessage(merged.buffer, [merged.buffer]);
      this.chunks = [];
      this.frames = 0;
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
