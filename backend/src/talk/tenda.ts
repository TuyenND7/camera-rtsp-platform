import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { config } from '../config';
import { TalkError, TalkTrack } from './rtsp';

type Camera = { id: number; rtsp_url: string };
type Gateway = { version: number; instance: string; updated_at: number; authenticated: boolean; bindings: { id: number; url_hash: string; model: string }[] };
const root = () => path.join(config.storageRoot, '.tenda-talk');
const hash = (camera: Camera) => createHash('sha256').update(camera.rtsp_url).digest('hex');
const track: TalkTrack = { control: 'tenda-sdk', codec: 'PCMA', payload: 8 };
const guid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const manifests = new Map<string, Gateway>();

function json(file: string): any {
  if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 16384) throw new Error('Invalid SDK status');
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

export function tendaGateway(camera: Camera, directory = root()): Gateway | undefined {
  let value: Gateway;
  try {
    value = json(path.join(directory, 'status.json'));
    if (value.version !== 1 || !guid.test(value.instance) || !Number.isFinite(value.updated_at) || !Array.isArray(value.bindings) || value.bindings.length > 16) { manifests.delete(directory); return; }
    if (manifests.size >= 64 && !manifests.has(directory)) manifests.delete(manifests.keys().next().value!);
    manifests.set(directory, value);
  } catch (error) {
    const previous = manifests.get(directory);
    // Docker's Windows bind mount can briefly hide an atomically replaced file.
    // A prior verified record keeps its original 3 s expiry, never a new TTL.
    if (!['ENOENT', 'EACCES', 'EPERM', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || !previous || Math.abs(Date.now() - previous.updated_at) >= 3000) { manifests.delete(directory); return; }
    value = previous;
  }
  if (!value.bindings.some(b => b?.id === camera.id && b.url_hash === hash(camera) && ['CT3V1.0', 'RH7V2.0'].includes(b.model))) return;
  return value;
}

// Include the gateway generation in capability caching: installing/restarting the
// SDK must invalidate a previous negative RTSP probe immediately.
export function tendaCacheKey(camera: Camera, directory = root()) {
  const gateway = tendaGateway(camera, directory);
  return gateway ? `${gateway.instance}:${gateway.authenticated === true}:${Math.abs(Date.now() - gateway.updated_at) < 3000}` : '';
}

/** Private shared-directory IPC with the Windows SDK agent; no listening port.
 * PCM is temporary and is never placed under the web-served live/rec folders. */
export class TendaTalk {
  private directory?: string;
  private fd?: number;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private ready = false;
  private instance = '';
  onClose?: () => void;

  constructor(private camera: Camera, private base = root()) {}

  private gateway() {
    const value = tendaGateway(this.camera, this.base);
    if (!value || value.authenticated !== true || Math.abs(Date.now() - value.updated_at) >= 3000 || (this.instance && value.instance !== this.instance)) {
      throw new TalkError(503, 'Kênh SDK Tenda trên Windows chưa sẵn sàng.');
    }
    return value;
  }

  async describe(): Promise<TalkTrack> { this.gateway(); return track; }

  async open(): Promise<TalkTrack> {
    if (this.closed || this.directory) throw new TalkError(409, 'Kênh SDK đã đóng hoặc đang mở.');
    const gateway = this.gateway(); this.instance = gateway.instance;
    const directory = path.join(this.base, randomUUID()); this.directory = directory;
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
      this.fd = fs.openSync(path.join(directory, 'audio.pcm'), 'ax', 0o600);
      const heartbeat = () => {
        if (this.closed) return;
        try {
          this.gateway();
          fs.writeFileSync(path.join(directory, 'heartbeat'), String(Date.now()), { mode: 0o600 });
          const state = this.state();
          if (state?.state === 'error' || state?.state === 'closed') this.fail();
        } catch { this.fail(); }
      };
      heartbeat();
      if (this.closed) throw new TalkError(503, 'Kênh SDK Tenda vừa ngắt kết nối.');
      fs.writeFileSync(path.join(directory, 'start.tmp'), JSON.stringify({ version: 1, camera_id: this.camera.id, url_hash: hash(this.camera), agent_instance: gateway.instance, created_at: Date.now() }), { mode: 0o600 });
      fs.renameSync(path.join(directory, 'start.tmp'), path.join(directory, 'start.json'));
      this.timer = setInterval(heartbeat, 250); this.timer.unref();
      const deadline = Date.now() + 9000;
      while (Date.now() < deadline && !this.closed) {
        const state = this.state();
        if (state?.state === 'error') throw new TalkError(502, 'SDK Tenda không mở được kênh nhận tiếng của camera.');
        if (state?.state === 'ready') { this.ready = true; return track; }
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      throw new TalkError(502, 'Camera chưa xác nhận sẵn sàng nhận giọng nói qua SDK Tenda.');
    } catch (error) { this.close(); throw error instanceof TalkError ? error : new TalkError(503, 'Không tạo được phiên đàm thoại SDK Tenda.'); }
  }

  private state(): { state: string; code?: number } | undefined {
    try { return this.directory ? json(path.join(this.directory, 'state.json')) : undefined; } catch { return; }
  }

  send(pcm: Buffer) {
    if (this.closed || !this.ready || this.fd === undefined || pcm.length !== 320) throw new TalkError(409, 'Kênh SDK Tenda chưa sẵn sàng hoặc đã đóng.');
    try { fs.writeSync(this.fd, pcm); } catch { this.fail(); throw new TalkError(503, 'Kênh SDK Tenda đã ngắt kết nối.'); }
  }

  private fail() {
    if (this.closed) return;
    const state = this.state(); console.warn('tenda_talk_closed', { camera_id: this.camera.id, state: state?.state, code: state?.code });
    this.close(); this.onClose?.();
  }

  close() {
    if (this.closed) return;
    this.closed = true; this.ready = false; if (this.timer) clearInterval(this.timer);
    if (this.fd !== undefined) { try { fs.closeSync(this.fd); } catch {} this.fd = undefined; }
    if (this.directory) {
      const directory = this.directory;
      try { fs.writeFileSync(path.join(directory, 'stop'), '', { mode: 0o600 }); } catch {}
      const cleanup = setTimeout(() => { try { fs.rmSync(directory, { recursive: true, force: true }); } catch {} }, 5000); cleanup.unref();
    }
  }
}
