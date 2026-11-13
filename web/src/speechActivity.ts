/** Energy after browser echo cancellation/noise suppression, in 10 ms PCM frames. */
export class SpeechActivity {
  private lastVoice: number | null = null;
  start(now: number) { this.lastVoice = now; }

  observe(pcm: ArrayBuffer, now: number) {
    const samples = new Int16Array(pcm);
    let voicedFrames = 0, peak = 0;
    for (let offset = 0; offset + 80 <= samples.length; offset += 80) {
      let sum = 0, squares = 0;
      for (let i = offset; i < offset + 80; i++) {
        const sample = samples[i] / 32768;
        sum += sample; squares += sample * sample; peak = Math.max(peak, Math.abs(sample));
      }
      // Remove DC offset; a click shorter than 30 ms must not keep the mic open.
      const rms = Math.sqrt(Math.max(0, squares / 80 - (sum / 80) ** 2));
      if (rms >= 0.012) voicedFrames++;
    }
    if (this.lastVoice !== null && voicedFrames >= 3) this.lastVoice = now;
    return Math.min(1, peak * 2);
  }

  expired(now: number) { return this.lastVoice !== null && now - this.lastVoice >= 5000; }
}
