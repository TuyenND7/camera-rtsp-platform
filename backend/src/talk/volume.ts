import { TalkError } from './rtsp';

export function talkGains(value: unknown, cameraIds: number[]): Record<number, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TalkError(400, 'Mức giọng nói không hợp lệ.');
  const entries = Object.entries(value);
  if (entries.length > 16 || entries.some(([key, gain]) => !cameraIds.some(id => String(id) === key) || typeof gain !== 'number' || !Number.isFinite(gain) || gain < 0 || gain > 4)) throw new TalkError(400, 'Mức giọng nói phải từ 0 đến 4× cho camera trong phiên hiện tại.');
  return Object.fromEntries(entries);
}

/** Boost quiet speech, keep raw VAD upstream, and limit peaks without Int16 wrap. */
export function amplifyPcm(frame: Buffer, gain: number): Buffer {
  if (!Number.isFinite(gain) || gain < 0 || gain > 4) throw new TalkError(400, 'Mức giọng nói không hợp lệ.');
  if (gain === 1) return frame;
  const result = Buffer.alloc(frame.length);
  if (gain === 0) return result;
  for (let i = 0; i < frame.length; i += 2) {
    const sample = frame.readInt16LE(i), scale = sample < 0 ? 32768 : 32767;
    const boosted = sample / scale * gain, peak = Math.abs(boosted);
    const limited = gain <= 1 || peak <= 0.8 ? boosted : Math.sign(boosted) * (0.8 + 0.2 * Math.tanh((peak - 0.8) / 0.2));
    result.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(limited * scale))), i);
  }
  return result;
}
