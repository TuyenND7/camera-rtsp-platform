import { randomUUID, createHash } from 'crypto';
import { RtspTalk, TalkError } from './rtsp';

export type TalkCamera = { id: number; rtsp_url: string };
export type TalkCapability = { camera_id: number; supported: boolean; reason: string; codec?: string };
type Transport = Pick<RtspTalk, 'open' | 'describe' | 'send' | 'close' | 'onClose'>;
type Call = {
  id: string; owner: string; cameras: TalkCamera[]; clients: Transport[]; queue: Buffer[];
  created: number; lastAudio: number; lastValidation: number; sequence: number; ready: boolean; checking: boolean;
  validate: () => Promise<boolean>;
};

export class TalkManager {
  private calls = new Map<string, Call>();
  private locks = new Map<number, string>();
  private probes = new Map<string, { expires: number; promise: Promise<TalkCapability> }>();
  private timer: NodeJS.Timeout;
  private silence = Buffer.alloc(320);
  constructor(private transport: (url: string) => Transport = url => new RtspTalk(url), private now = Date.now) {
    this.timer = setInterval(() => this.tick(), 20); this.timer.unref();
  }

  async probe(camera: TalkCamera): Promise<TalkCapability> {
    const key = createHash('sha256').update(`${camera.id}:${camera.rtsp_url}`).digest('hex');
    const cached = this.probes.get(key);
    if (cached && cached.expires > this.now()) return cached.promise;
    for (const [k, v] of this.probes) if (v.expires <= this.now()) this.probes.delete(k);
    if (this.probes.size >= 256) this.probes.delete(this.probes.keys().next().value!);
    const promise = (async () => {
      let client: Transport | undefined;
      try {
        client = this.transport(camera.rtsp_url);
        const track = await client.describe();
        // A missing receive track is stable until camera configuration changes.
        // Avoid repeatedly opening RTSP connections on session-limited cameras.
        if (!track) {
          const entry = this.probes.get(key);
          if (entry) entry.expires = this.now() + 30 * 60_000;
        }
        return track ? { camera_id: camera.id, supported: true, codec: track.codec, reason: 'Sẵn sàng đàm thoại' }
          : { camera_id: camera.id, supported: false, reason: 'Camera chưa cung cấp kênh nhận giọng nói ONVIF/RTSP. Đàm thoại qua ứng dụng hãng có thể dùng giao thức riêng.' };
      } catch (error) {
        return { camera_id: camera.id, supported: false, reason: error instanceof TalkError ? error.message : 'Không kiểm tra được kênh đàm thoại của camera.' };
      } finally { client?.close(); }
    })();
    this.probes.set(key, { expires: this.now() + 30_000, promise });
    return promise;
  }

  async start(owner: string, cameras: TalkCamera[], validate: () => Promise<boolean>) {
    if (this.calls.size >= 4 || this.locks.size + cameras.length > 16) throw new TalkError(409, 'Máy chủ đã đạt giới hạn đàm thoại đồng thời.');
    if (cameras.some(c => this.locks.has(c.id))) throw new TalkError(409, 'Một camera đang được sử dụng trong cuộc đàm thoại khác.');
    if (!cameras.length || cameras.length > 16 || new Set(cameras.map(c => c.id)).size !== cameras.length) throw new TalkError(400, 'Chọn từ 1 đến 16 camera khác nhau.');
    const id = randomUUID(), time = this.now();
    const call: Call = { id, owner, cameras, clients: [], queue: [], created: time, lastAudio: time, lastValidation: time, sequence: -1, ready: false, checking: false, validate };
    this.calls.set(id, call); cameras.forEach(c => this.locks.set(c.id, id));
    try {
      // Assign every client before opening, so partial failures can close all sockets.
      call.clients = cameras.map(c => this.transport(c.rtsp_url));
      const results = await Promise.allSettled(call.clients.map(c => c.open()));
      const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failure) throw failure.reason;
      if (!await validate() || !this.calls.has(id)) throw new TalkError(403, 'Phiên đăng nhập hoặc cấu hình camera đã thay đổi.');
      call.ready = true; call.created = this.now(); call.lastAudio = call.created; call.lastValidation = call.created;
      call.clients.forEach(c => { c.onClose = () => this.stop(id); });
      return { id, camera_ids: cameras.map(c => c.id), sample_rate: 8000, max_seconds: 60 };
    } catch (error) {
      this.stop(id);
      throw error instanceof TalkError ? error : new TalkError(502, 'Không mở được kênh đàm thoại tới camera.');
    }
  }

  push(id: string, owner: string, sequence: number, pcm: Buffer) {
    const call = this.owned(id, owner);
    if (!call.ready) throw new TalkError(409, 'Kênh đàm thoại chưa sẵn sàng.');
    if (!Number.isSafeInteger(sequence) || sequence !== call.sequence + 1) throw new TalkError(409, 'Gói audio không đúng thứ tự.');
    if (!Buffer.isBuffer(pcm) || pcm.length < 320 || pcm.length > 6400 || pcm.length % 320) throw new TalkError(400, 'Audio phải là PCM 16-bit mono 8 kHz, từ 20 đến 400 ms.');
    if (call.queue.length * 320 + pcm.length > 8000) { this.stop(id); throw new TalkError(409, 'Đường truyền chậm. Hãy nhấn giữ để nói lại.'); }
    call.sequence = sequence; call.lastAudio = this.now();
    for (let i = 0; i < pcm.length; i += 320) call.queue.push(Buffer.from(pcm.subarray(i, i + 320)));
  }

  end(id: string, owner: string) { this.owned(id, owner); this.stop(id); }

  private owned(id: string, owner: string) {
    const call = this.calls.get(id);
    // Do not reveal whether another user's call exists.
    if (!call || call.owner !== owner) throw new TalkError(404, 'Cuộc đàm thoại đã kết thúc.');
    return call;
  }

  private tick() {
    const time = this.now();
    for (const call of this.calls.values()) {
      if (time - call.created >= 60_000 || (!call.ready && time - call.created > 12_000) || (call.ready && time - call.lastAudio > 1500)) { this.stop(call.id); continue; }
      if (!call.ready) continue;
      try { const frame = call.queue.shift() ?? this.silence; call.clients.forEach(c => c.send(frame)); }
      catch { this.stop(call.id); continue; }
      if (!call.checking && time - call.lastValidation >= 1000) {
        call.checking = true; call.lastValidation = time;
        void call.validate().then(valid => { if (!valid) this.stop(call.id); }, () => this.stop(call.id)).finally(() => { call.checking = false; });
      }
    }
  }

  private stop(id: string) {
    const call = this.calls.get(id);
    if (!call) return;
    this.calls.delete(id); call.queue.length = 0;
    call.cameras.forEach(c => { if (this.locks.get(c.id) === id) this.locks.delete(c.id); });
    call.clients.forEach(c => c.close());
  }

  invalidateCamera(id: number) { const call = this.locks.get(id); if (call) this.stop(call); this.probes.clear(); }
  close() { clearInterval(this.timer); for (const id of this.calls.keys()) this.stop(id); this.probes.clear(); }
}

export const talkManager = new TalkManager();
