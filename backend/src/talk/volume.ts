import { TalkError } from './rtsp';

export function talkGains(value: unknown, cameraIds: number[]): Record<number, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TalkError(400, 'Mức giọng nói không hợp lệ.');
  const entries = Object.entries(value);
  if (entries.length > 16 || entries.some(([key, gain]) => !cameraIds.some(id => String(id) === key) || typeof gain !== 'number' || !Number.isFinite(gain) || gain < 0 || gain > 4)) throw new TalkError(400, 'Mức giọng nói phải từ 0 đến 4× cho camera trong phiên hiện tại.');
  return Object.fromEntries(entries);
}

/** One limiter per camera/call. A 5 ms lookahead reduces gain ahead of peaks,
 * rather than bending individual samples and adding audible harmonics. Quiet
 * speech retains the requested boost; gain recovers smoothly over about 80 ms.
 * VAD still receives the original microphone PCM in the browser. */
export class PcmAmplifier {
  private delay = new Float64Array(40);
  private cursor = 0;
  private envelope = 1;
  private readonly release = 1 - Math.exp(-1 / (8000 * 0.08));

  process(frame: Buffer, gain: number): Buffer {
    if (!Number.isFinite(gain) || gain < 0 || gain > 4 || frame.length % 2) throw new TalkError(400, 'Mức giọng nói hoặc PCM không hợp lệ.');
    const result = Buffer.alloc(frame.length);
    if (gain === 0) { this.delay.fill(0); this.cursor = 0; this.envelope = 1; return result; }
    for (let i = 0; i < frame.length; i += 2) {
      const sample = this.delay[this.cursor];
      this.delay[this.cursor] = frame.readInt16LE(i) / 32768 * gain;
      this.cursor = (this.cursor + 1) % this.delay.length;
      let peak = Math.abs(sample);
      for (const upcoming of this.delay) peak = Math.max(peak, Math.abs(upcoming));
      const target = peak > 0.82 ? 0.82 / peak : 1;
      this.envelope += (target - this.envelope) * (target < this.envelope ? 0.25 : this.release);
      // Reserve extra headroom for isolated transients and the camera's encoder.
      const output = Math.max(-0.9, Math.min(0.9, sample * this.envelope));
      result.writeInt16LE(Math.round(output * 32768), i);
    }
    return result;
  }
}
