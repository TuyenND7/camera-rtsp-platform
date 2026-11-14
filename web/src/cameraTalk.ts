import { api } from './api';
import { Microphone } from './microphone';
import { SpeechActivity } from './speechActivity';

export type CameraTalkState = { cameraId: number | null; cameraIds: number[]; duplexCameraIds: number[]; broadcast: boolean; phase: 'idle' | 'preparing' | 'talking'; level: number; message: string };
export const idleCameraTalk: CameraTalkState = { cameraId: null, cameraIds: [], duplexCameraIds: [], broadcast: false, phase: 'idle', level: 0, message: '' };
type Run = { microphone: Microphone; controller: AbortController; activity: SpeechActivity; queue: ArrayBuffer[]; sending: boolean; sequence: number; opening: Promise<void>; startingPlayback?: boolean; id?: string; limit?: number; silence?: number };

/** One explicitly started single-camera or broadcast call; late replies are cleaned up. */
export class CameraTalk {
  state: CameraTalkState = idleCameraTalk;
  private run: Run | null = null;
  private closing: Promise<void> = Promise.resolve();
  private masterVolume = 1;
  constructor(private onChange: (state: CameraTalkState) => void, private initialListenGain = (_cameraId: number) => 1) {}
  private update(change: Partial<CameraTalkState>) { this.state = { ...this.state, ...change }; this.onChange(this.state); }

  stop(message = '') {
    const current = this.run; this.run = null;
    if (current) {
      current.microphone.stop(); current.controller.abort(); current.queue.length = 0;
      window.clearTimeout(current.limit); window.clearInterval(current.silence);
    }
    this.update({ phase: 'idle', duplexCameraIds: [], level: 0, message });
    if (current?.id) this.closing = api.stopTalk(current.id).catch(() => undefined);
    else if (current) this.closing = current.opening;
    return this.closing;
  }

  dispose() { this.onChange = () => undefined; this.stop(); }
  setListenGain(cameraId: number, gain: number) { if (Number.isFinite(gain)) this.run?.microphone.listenGain(cameraId, Math.max(0, Math.min(1, gain))); }
  setListenVolume(gain: number) { if (Number.isFinite(gain)) { this.masterVolume = Math.max(0, Math.min(1, gain)); this.run?.microphone.listenVolume(this.masterVolume); } }

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
      current.id = session.id;
      current.limit = window.setTimeout(() => {
        if (this.run === current) this.stop('Đã đạt thời lượng đàm thoại. Nhấn mic để nói tiếp.');
      }, session.max_seconds * 1000);
      const duplexIds = session.listen_camera_ids ?? [];
      if (duplexIds.length) {
        current.startingPlayback = true;
        await current.microphone.startPlayback(message => { if (this.run === current) this.stop(message); });
        if (this.run !== current) return;
        current.microphone.listenVolume(this.masterVolume);
        duplexIds.forEach(id => current.microphone.listenGain(id, this.initialListenGain(id)));
        this.update({ duplexCameraIds: duplexIds });
        duplexIds.forEach(id => { void this.listen(current, id); });
        current.startingPlayback = false;
      }
      current.activity.start(performance.now());
      current.silence = window.setInterval(() => {
        if (this.run === current && current.activity.expired(performance.now())) this.stop('Đàm thoại đã kết thúc vì không có giọng nói trong 5 giây.');
      }, 100);
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
        if (this.run === current && !current.startingPlayback) this.update({ phase: 'talking' });
      }
    } catch (error) {
      if (this.run === current) this.stop(error instanceof Error ? error.message : 'Đường truyền audio bị gián đoạn.');
    } finally { current.sending = false; }
  }
  private async listen(current: Run, cameraId: number) {
    let pending = new Uint8Array(0), activity = new Uint8Array(0);
    try {
      const response = await api.listenTalk(current.id!, cameraId, current.controller.signal), reader = response.body?.getReader();
      if (!reader) throw new Error('Trình duyệt chưa hỗ trợ nghe đàm thoại trực tiếp.');
      while (this.run === current) {
        const next = await reader.read();
        if (next.done) throw new Error('Kênh nghe từ camera đã ngắt.');
        const joined = new Uint8Array(pending.length + next.value.length); joined.set(pending); joined.set(next.value, pending.length);
        const size = joined.length - joined.length % 2;
        pending = joined.slice(size);
        if (!size) continue;
        const pcm = joined.slice(0, size);
        const observed = new Uint8Array(activity.length + pcm.length); observed.set(activity); observed.set(pcm, activity.length);
        if (observed.length >= 1600) { current.activity.observe(observed.buffer, performance.now()); activity = new Uint8Array(0); } else activity = observed;
        // Fetch chunks can coalesce after a stall. Keep at most 200 ms of
        // current speech rather than replaying a delayed conversation.
        current.microphone.playAudio(cameraId, pcm.byteLength > 3200 ? pcm.slice(-3200).buffer : pcm.buffer);
        if (this.run === current) this.update({ phase: 'talking' });
      }
    } catch (error) {
      if (this.run === current) this.stop(error instanceof Error ? error.message : 'Kênh nghe từ camera đã ngắt.');
    }
  }
}
