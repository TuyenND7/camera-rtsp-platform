import { api } from './api';
import { Microphone } from './microphone';
import { SpeechActivity } from './speechActivity';

export type CameraTalkState = { cameraId: number | null; cameraIds: number[]; broadcast: boolean; phase: 'idle' | 'preparing' | 'talking'; level: number; message: string };
export const idleCameraTalk: CameraTalkState = { cameraId: null, cameraIds: [], broadcast: false, phase: 'idle', level: 0, message: '' };
type Run = { microphone: Microphone; controller: AbortController; activity: SpeechActivity; queue: ArrayBuffer[]; sending: boolean; sequence: number; opening: Promise<void>; id?: string; limit?: number; silence?: number };

/** One explicitly started single-camera or broadcast call; late replies are cleaned up. */
export class CameraTalk {
  state: CameraTalkState = idleCameraTalk;
  private run: Run | null = null;
  private closing: Promise<void> = Promise.resolve();
  constructor(private onChange: (state: CameraTalkState) => void) {}
  private update(change: Partial<CameraTalkState>) { this.state = { ...this.state, ...change }; this.onChange(this.state); }

  stop(message = '') {
    const current = this.run; this.run = null;
    if (current) {
      current.microphone.stop(); current.controller.abort(); current.queue.length = 0;
      window.clearTimeout(current.limit); window.clearInterval(current.silence);
    }
    this.update({ phase: 'idle', level: 0, message });
    if (current?.id) this.closing = api.stopTalk(current.id).catch(() => undefined);
    else if (current) this.closing = current.opening;
    return this.closing;
  }

  dispose() { this.onChange = () => undefined; this.stop(); }

  async start(target: number | number[], prepare?: () => Promise<void>) {
    if (this.run) return;
    const cameraIds = Array.isArray(target) ? [...target] : [target], broadcast = Array.isArray(target);
    if (!cameraIds.length || cameraIds.length > 16 || new Set(cameraIds).size !== cameraIds.length || cameraIds.some(id => !Number.isSafeInteger(id) || id < 1)) {
      this.update({ message: 'Chọn từ 1 đến 16 camera khác nhau để đàm thoại.' }); return;
    }
    let opened!: () => void;
    const opening = new Promise<void>(resolve => { opened = resolve; });
    const closing = this.closing;
    const current: Run = { microphone: new Microphone(), controller: new AbortController(), activity: new SpeechActivity(), queue: [], sending: false, sequence: 0, opening };
    this.run = current; this.update({ cameraId: broadcast ? null : cameraIds[0], cameraIds, broadcast, phase: 'preparing', level: 0, message: '' });
    try {
      await current.microphone.start(pcm => {
        if (this.run !== current) return;
        this.update({ level: current.activity.observe(pcm, performance.now()) });
        if (!current.id) return;
        if (current.queue.length >= 2) current.queue.shift();
        current.queue.push(pcm); void this.send(current);
      });
      if (this.run !== current) { current.microphone.stop(); return; }
      await closing;
      if (this.run !== current) return;
      if (prepare) await prepare();
      if (this.run !== current) return;
      const session = await api.startTalk(cameraIds);
      if (this.run !== current) { await api.stopTalk(session.id).catch(() => undefined); return; }
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
    } finally { opened(); }
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
