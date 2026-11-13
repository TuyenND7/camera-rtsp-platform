import { api } from './api';
import { Microphone } from './microphone';
import { SpeechActivity } from './speechActivity';

export type CameraTalkState = { cameraId: number | null; phase: 'idle' | 'preparing' | 'talking'; level: number; message: string };
export const idleCameraTalk: CameraTalkState = { cameraId: null, phase: 'idle', level: 0, message: '' };
type Run = { cameraId: number; microphone: Microphone; controller: AbortController; activity: SpeechActivity; queue: ArrayBuffer[]; sending: boolean; sequence: number; id?: string; limit?: number; silence?: number };

/** One explicitly started per-tile call; late permission/session replies are always cleaned up. */
export class CameraTalk {
  state: CameraTalkState = idleCameraTalk;
  private run: Run | null = null;
  constructor(private onChange: (state: CameraTalkState) => void) {}
  private update(change: Partial<CameraTalkState>) { this.state = { ...this.state, ...change }; this.onChange(this.state); }

  stop(message = '') {
    const current = this.run; this.run = null;
    if (current) {
      current.microphone.stop(); current.controller.abort(); current.queue.length = 0;
      window.clearTimeout(current.limit); window.clearInterval(current.silence);
      if (current.id) void api.stopTalk(current.id).catch(() => undefined);
    }
    this.update({ phase: 'idle', level: 0, message });
  }

  dispose() { this.onChange = () => undefined; this.stop(); }

  async start(cameraId: number) {
    if (this.run) return;
    const current: Run = { cameraId, microphone: new Microphone(), controller: new AbortController(), activity: new SpeechActivity(), queue: [], sending: false, sequence: 0 };
    this.run = current; this.update({ cameraId, phase: 'preparing', level: 0, message: '' });
    try {
      await current.microphone.start(pcm => {
        if (this.run !== current) return;
        this.update({ level: current.activity.observe(pcm, performance.now()) });
        if (!current.id) return;
        if (current.queue.length >= 2) current.queue.shift();
        current.queue.push(pcm); void this.send(current);
      });
      if (this.run !== current) { current.microphone.stop(); return; }
      const session = await api.startTalk([cameraId]);
      if (this.run !== current) { void api.stopTalk(session.id).catch(() => undefined); return; }
      current.id = session.id; current.activity.start(performance.now());
      current.silence = window.setInterval(() => {
        if (this.run === current && current.activity.expired(performance.now())) this.stop('Đàm thoại đã kết thúc vì không có giọng nói trong 5 giây.');
      }, 100);
      current.limit = window.setTimeout(() => {
        if (this.run === current) this.stop('Đã đạt thời lượng đàm thoại. Nhấn mic để nói tiếp.');
      }, session.max_seconds * 1000);
    } catch (error) {
      current.microphone.stop();
      if (this.run !== current) return;
      const message = error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name) ? 'Hãy cho phép truy cập mic trong trình duyệt hoặc cài đặt ứng dụng.'
        : error instanceof DOMException && error.name === 'NotReadableError' ? 'Không mở được mic. Kiểm tra quyền mic hoặc ứng dụng khác đang sử dụng mic.'
        : error instanceof DOMException && error.name === 'NotFoundError' ? 'Thiết bị này không có mic.'
        : error instanceof Error ? error.message : 'Không mở được đàm thoại.';
      this.stop(message);
    }
  }

  private async send(current: Run) {
    if (current.sending || !current.id) return;
    current.sending = true;
    try {
      while (this.run === current && current.queue.length) {
        const chunks = current.queue.splice(0, 2);
        let pcm = chunks[0];
        if (chunks.length > 1) {
          const joined = new Uint8Array(chunks[0].byteLength + chunks[1].byteLength);
          joined.set(new Uint8Array(chunks[0])); joined.set(new Uint8Array(chunks[1]), chunks[0].byteLength); pcm = joined.buffer;
        }
        await api.talkAudio(current.id, current.sequence++, pcm, current.controller.signal);
        if (this.run === current) this.update({ phase: 'talking' });
      }
    } catch (error) {
      if (this.run === current) this.stop(error instanceof Error ? error.message : 'Đường truyền audio bị gián đoạn.');
    } finally { current.sending = false; }
  }
}
