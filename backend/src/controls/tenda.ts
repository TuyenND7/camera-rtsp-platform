import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { config } from '../config';
import { tendaGateway } from '../talk/tenda';
import type { TalkCamera } from '../talk/manager';
import { deviceSettingsSnapshot, DeviceSettingsChange, DeviceSettingsSnapshot } from './settings';

export interface DeviceControls {
  camera_id: number;
  available: boolean;
  reason?: string;
  alarm_supported: boolean;
  alarm_active: boolean | null;
  alarm_command_active?: boolean;
  alarm_until_stopped?: boolean;
  light_supported: boolean;
  light_enabled: boolean | null;
  talking?: boolean;
  observed_at?: number;
  alarm_reported_at?: number | null;
  light_reported_at?: number | null;
  ends_at?: number | null;
  confirmed?: boolean;
  device_settings?: DeviceSettingsSnapshot;
}
export class ControlError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const guid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const fingerprint = (camera: TalkCamera) => createHash('sha256').update(camera.rtsp_url).digest('hex');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const errors: Record<string, string> = {
  sdk_control_unsupported: 'Camera chưa cung cấp chức năng này.',
  sdk_control_camera_talking: 'Camera đang đàm thoại. Dừng mic trước khi bật còi.',
  sdk_control_alarm_busy: 'Còi đang hoạt động hoặc đang dừng. Hãy chờ camera xác nhận.',
  sdk_control_stop_unconfirmed: 'Chưa xác nhận được còi đã tắt. Nhấn Dừng còi để thử lại.',
  sdk_control_cancelled: 'Đã hủy lệnh điều khiển.',
  sdk_settings_invalid: 'Cài đặt camera không hợp lệ.',
  sdk_settings_changed: 'Camera đã thay đổi cài đặt. Đọc lại trước khi áp dụng.',
  sdk_settings_no_card: 'Camera chưa có thẻ nhớ sẵn sàng để ghi hình.',
  sdk_settings_busy: 'Dừng đàm thoại hoặc còi trước khi cài đặt camera.',
};
function read(file: string): any {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('Invalid control result');
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
const bool = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
const time = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
export function controlState(cameraId: number, value: any): DeviceControls {
  if (!value || typeof value.alarm_supported !== 'boolean' || typeof value.light_supported !== 'boolean' || time(value.observed_at) === null) throw new ControlError(502, 'Camera chưa trả về trạng thái điều khiển hợp lệ.');
  const settings = deviceSettingsSnapshot(value.device_settings);
  return { camera_id: cameraId, available: true, alarm_supported: value.alarm_supported, alarm_active: bool(value.alarm_active), light_supported: value.light_supported, light_enabled: bool(value.light_enabled), talking: value.talking === true, observed_at: value.observed_at, alarm_reported_at: time(value.alarm_reported_at), light_reported_at: time(value.light_reported_at), ...(settings ? { device_settings: settings } : {}) };
}
export const unavailableControls = (id: number, reason: string): DeviceControls => ({ camera_id: id, available: false, reason, alarm_supported: false, alarm_active: null, light_supported: false, light_enabled: null });

export class TendaControls {
  private reads = new Map<number, Promise<DeviceControls>>();
  private cache = new Map<string, { expires: number; state: DeviceControls }>();
  private busy = new Map<number, { alarm: boolean }>();
  private requests = new Map<string, number>();
  private closed = false;
  constructor(private base = path.join(config.storageRoot, '.tenda-talk')) {}
  private root() { return path.join(this.base, 'controls'); }
  private gateway(camera: TalkCamera) {
    const gateway = tendaGateway(camera, this.base) as (ReturnType<typeof tendaGateway> & { control_version?: number; settings_version?: number });
    if (!gateway || gateway.authenticated !== true || Math.abs(Date.now() - gateway.updated_at) >= 3000 || gateway.control_version !== 1) throw new ControlError(503, 'Kênh điều khiển Tenda trên máy chủ chưa sẵn sàng.');
    return gateway;
  }
  private lease(camera: TalkCamera) {
    try {
      const lease = read(path.join(this.root(), `alarm-${camera.id}.json`));
      return lease.camera_id === camera.id && lease.url_hash === fingerprint(camera) && guid.test(lease.request) ? lease : undefined;
    } catch { return undefined; }
  }
  alarmActive(camera: TalkCamera) { return this.busy.get(camera.id)?.alarm === true || !!this.lease(camera); }
  private withLease(camera: TalkCamera, state: DeviceControls): DeviceControls {
    const lease = this.lease(camera);
    return { ...state, ends_at: time(lease?.ends_at), alarm_command_active: !!lease, alarm_until_stopped: !!lease && lease.duration_seconds === 0 };
  }
  unavailable(camera: TalkCamera, reason: string) { return this.withLease(camera, unavailableControls(camera.id, reason)); }
  private settingsGateway(camera: TalkCamera) {
    if (this.gateway(camera).settings_version !== 1) throw new ControlError(503, 'Adapter trên máy chủ chưa hỗ trợ cài đặt TDSEE.');
  }
  async getSettings(camera: TalkCamera): Promise<DeviceSettingsSnapshot> {
    this.settingsGateway(camera);
    const state = await this.get(camera);
    if (!state.device_settings) throw new ControlError(502, 'Camera chưa trả về cài đặt hợp lệ.');
    return state.device_settings;
  }
  async setSettings(camera: TalkCamera, change: DeviceSettingsChange): Promise<DeviceSettingsSnapshot & { confirmed: boolean }> {
    this.settingsGateway(camera);
    if (this.busy.has(camera.id) || this.alarmActive(camera)) throw new ControlError(409, 'Camera đang bận điều khiển. Chờ hoàn tất rồi thử lại.');
    this.busy.set(camera.id, { alarm: false }); this.cache.clear();
    try {
      const state = await this.request(camera, 'settings', false, 10, change);
      if (!state.device_settings) throw new ControlError(502, 'Chưa xác nhận được cài đặt camera. Hãy đọc lại trạng thái.');
      return { ...state.device_settings, confirmed: state.confirmed === true };
    } finally { this.busy.delete(camera.id); this.cache.clear(); }
  }
  async get(camera: TalkCamera): Promise<DeviceControls> {
    const generation = this.gateway(camera).instance;
    const key = `${camera.id}:${fingerprint(camera)}:${generation}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return this.withLease(camera, cached.state);
    const existing = this.reads.get(camera.id);
    if (existing) return existing;
    const pending = this.request(camera, 'get').then(state => {
      if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { expires: Date.now() + 2000, state }); return state;
    }).finally(() => this.reads.delete(camera.id));
    this.reads.set(camera.id, pending); return pending;
  }
  async set(camera: TalkCamera, action: 'alarm' | 'light', enabled: boolean, seconds = 10): Promise<DeviceControls> {
    if (this.busy.has(camera.id)) throw new ControlError(409, 'Camera đang xử lý một lệnh. Hãy chờ trong giây lát.');
    if (action === 'alarm' && enabled && this.lease(camera)) throw new ControlError(409, errors.sdk_control_alarm_busy);
    this.busy.set(camera.id, { alarm: action === 'alarm' && enabled }); this.cache.clear();
    try {
      if (action === 'alarm' && !enabled) {
        const lease = this.lease(camera);
        if (lease) {
          const directory = path.join(this.root(), lease.request);
          this.stop(directory);
          try {
            const state = await this.wait(camera.id, directory, 'finished.json', Date.now() + 12000);
            const deadline = Date.now() + 1000;
            while (this.lease(camera)?.request === lease.request && Date.now() < deadline) await delay(40);
            if (this.lease(camera)?.request === lease.request) throw new ControlError(502, errors.sdk_control_stop_unconfirmed);
            return this.withLease(camera, state);
          }
          catch { /* An orphaned worker needs a fresh authenticated stop below. */ }
        }
      }
      return await this.request(camera, action, enabled, seconds);
    } finally { this.busy.delete(camera.id); this.cache.clear(); }
  }
  private async request(camera: TalkCamera, action: 'get' | 'light' | 'alarm' | 'settings', enabled = false, seconds = 10, settings?: DeviceSettingsChange): Promise<DeviceControls> {
    if (this.closed || this.requests.size >= 8) throw new ControlError(503, 'Máy chủ đang bận xử lý điều khiển camera.');
    const gateway = this.gateway(camera);
    const directory = path.join(this.root(), randomUUID());
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); this.requests.set(directory, camera.id);
    try {
      fs.writeFileSync(path.join(directory, 'request.tmp'), JSON.stringify({ version: 1, camera_id: camera.id, url_hash: fingerprint(camera), agent_instance: gateway.instance, created_at: Date.now(), action, enabled, duration_seconds: seconds, ...(settings ?? {}) }), { mode: 0o600, flag: 'wx' });
      fs.renameSync(path.join(directory, 'request.tmp'), path.join(directory, 'request.json'));
      const state = await this.wait(camera.id, directory, 'result.json', Date.now() + 25000);
      if (this.gateway(camera).instance !== gateway.instance) throw new ControlError(503, 'Kênh điều khiển vừa khởi động lại. Hãy thử lại.');
      return this.withLease(camera, state);
    } catch (error) {
      this.stop(directory);
      throw error instanceof ControlError ? error : new ControlError(503, 'Chưa gửi được lệnh điều khiển tới camera.');
    } finally {
      this.requests.delete(directory);
      const cleanup = setTimeout(() => {
        // Active alarms remain for the native watchdog and recovery, including manual mode.
        if (action === 'alarm' && enabled && !fs.existsSync(path.join(directory, 'finished.json'))) return;
        try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
      }, action === 'alarm' && enabled ? (seconds + 15) * 1000 : 5000); cleanup.unref();
    }
  }
  private async wait(cameraId: number, directory: string, name: string, deadline: number): Promise<DeviceControls> {
    while (Date.now() < deadline && !this.closed) {
      let response;
      try { response = read(path.join(directory, name)); } catch {}
      if (response) {
        if (response.ok !== true) throw new ControlError([400, 403, 409, 422, 502, 503].includes(response.status) ? response.status : 502, errors[response.error] ?? 'Camera chưa thực hiện được lệnh điều khiển.');
        return { ...controlState(cameraId, response.state), ...(typeof response.confirmed === 'boolean' ? { confirmed: response.confirmed } : {}), ends_at: time(response.ends_at) };
      }
      await delay(80);
    }
    throw new ControlError(504, 'Camera chưa phản hồi. Hãy kiểm tra kết nối rồi thử lại.');
  }
  private stop(directory: string) { try { fs.writeFileSync(path.join(directory, 'stop'), '', { mode: 0o600 }); } catch {} }
  cancelCamera(id: number) {
    for (const [directory, cameraId] of this.requests) if (cameraId === id) this.stop(directory);
    try { const lease = read(path.join(this.root(), `alarm-${id}.json`)); if (guid.test(lease.request)) this.stop(path.join(this.root(), lease.request)); } catch {}
    this.cache.clear();
  }
  close() {
    this.closed = true;
    for (const directory of this.requests.keys()) this.stop(directory);
    try { for (const name of fs.readdirSync(this.root())) if (/^alarm-\d+\.json$/.test(name)) this.cancelCamera(Number(name.slice(6, -5))); } catch {}
    this.cache.clear();
  }
}
export const deviceControls = new TendaControls();
