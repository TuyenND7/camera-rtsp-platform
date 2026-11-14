import { randomUUID } from 'crypto';
import { TalkError } from '../talk/rtsp';

type Channel = { generation: string; pending: Buffer; frames: Array<{ sequence: number; pcm: Buffer }>; sequence: number; updated: number };
export type AudioReader = { read(): Buffer };

/** Latest 500 ms of decoded mono PCM, in memory only. Readers have independent
 * cursors and skip stale speech after a slow connection instead of replaying it. */
export class LiveAudio {
  private channels = new Map<number, Channel>();
  constructor(private now = Date.now) {}
  begin(id: number) {
    const generation = randomUUID();
    this.channels.set(id, { generation, pending: Buffer.alloc(0), frames: [], sequence: 0, updated: 0 });
    return generation;
  }
  end(id: number, generation: string) { if (this.channels.get(id)?.generation === generation) this.channels.delete(id); }
  push(id: number, generation: string, bytes: Buffer) {
    const channel = this.channels.get(id);
    if (!channel || channel.generation !== generation || bytes.length > 1_048_576) return;
    const joined = channel.pending.length ? Buffer.concat([channel.pending, bytes]) : bytes;
    for (let i = 0; i + 320 <= joined.length; i += 320) {
      channel.frames.push({ sequence: channel.sequence++, pcm: Buffer.from(joined.subarray(i, i + 320)) });
      if (channel.frames.length > 25) channel.frames.shift();
    }
    channel.pending = Buffer.from(joined.subarray(joined.length - joined.length % 320));
    channel.updated = this.now();
  }
  ready(id: number) {
    const channel = this.channels.get(id);
    return !!channel?.frames.length && this.now() - channel.updated < 1500;
  }
  open(id: number): AudioReader {
    const channel = this.channels.get(id);
    if (!channel || !this.ready(id)) throw new TalkError(503, 'Camera chưa có tiếng nghe trực tiếp.');
    const generation = channel.generation;
    let cursor = Math.max(0, channel.sequence - 4);
    return { read: () => {
      const current = this.channels.get(id);
      if (!current || current.generation !== generation || !this.ready(id)) throw new TalkError(503, 'Luồng âm thanh camera đã ngắt.');
      cursor = Math.max(cursor, current.sequence - 10);
      const frames = current.frames.filter(frame => frame.sequence >= cursor).slice(0, 5);
      if (!frames.length) return Buffer.alloc(0);
      cursor = frames[frames.length - 1].sequence + 1;
      return Buffer.concat(frames.map(frame => frame.pcm));
    } };
  }
}
export const liveAudio = new LiveAudio();
