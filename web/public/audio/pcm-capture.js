class CameraPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(1600);
    this.index = 0;
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
  }
  process(inputs, outputs) {
    // Keep the graph alive without playing the microphone through the tablet.
    for (const channel of outputs[0] || []) channel.fill(0);
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const sample of input) {
      this.sum += sample; this.count++;
      this.phase += 8000;
      if (this.phase < sampleRate) continue;
      this.phase -= sampleRate;
      const value = Math.max(-1, Math.min(1, this.sum / this.count));
      this.sum = 0; this.count = 0;
      this.samples[this.index++] = Math.round(value * (value < 0 ? 32768 : 32767));
      if (this.index === this.samples.length) {
        this.port.postMessage(this.samples.buffer, [this.samples.buffer]);
        this.samples = new Int16Array(1600); this.index = 0;
      }
    }
    return true;
  }
}
registerProcessor('camera-pcm-capture', CameraPcmCapture);
