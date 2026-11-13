import { createHash } from 'crypto';
import { Cam } from 'onvif/promises';
import { pool } from './db';

type ObjectValue = Record<string, any>;
type Range = { min: number; max: number };
export type VideoProfile = {
  token: string; name: string; codec: string;
  width: number | null; height: number | null; fps: number | null; bitrate: number | null;
  resolutions: Array<{ width: number; height: number }>;
  fps_range: Range | null; bitrate_range: Range | null; editable: boolean; revision: string;
};
export type CameraVideoSettings = { supported: boolean; reason?: string; profiles: VideoProfile[] };
export type VideoChange = { profile_token: string; revision: string; width: number; height: number; fps?: number; bitrate?: number };
export class VideoSettingsError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
interface MediaClient {
  getProfiles(): Promise<unknown>;
  getVideoEncoderConfiguration(token: string): Promise<unknown>;
  getVideoEncoderConfigurationOptions(options: object): Promise<unknown>;
  setVideoEncoderConfiguration(options: object): Promise<unknown>;
}
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const list = (value: unknown): unknown[] => value == null ? [] : Array.isArray(value) ? value : [value];
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
function range(value: unknown): Range | null {
  const v = object(value), min = number(v.min), max = number(v.max);
  return min !== null && max !== null && min > 0 && max >= min ? { min, max } : null;
}
const xml = (value: string) => value.replace(/[<>&'"]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch]!));
// onvif 0.8.x interpolates these strings into SOAP; keep camera-provided names/tokens escaped too.
function escaped(value: any): any {
  if (typeof value === 'string') return xml(value);
  if (Array.isArray(value)) return value.map(escaped);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, escaped(item)]));
  return value;
}
function revision(configuration: object, fingerprint: string) {
  return createHash('sha256').update(fingerprint).update(JSON.stringify(configuration)).digest('hex');
}
export function videoProfile(token: string, name: string, raw: unknown, options: unknown, fingerprint: string): VideoProfile {
  const config = object(raw), all = object(options), codec = String(config.encoding ?? '');
  const limits = object(all[codec]), extension = object(object(all.extension)[codec]);
  const resolutions = list(limits.resolutionsAvailable ?? extension.resolutionsAvailable).map(object)
    .filter(v => Number.isInteger(v.width) && Number.isInteger(v.height) && v.width > 0 && v.height > 0 && v.width <= 16384 && v.height <= 16384)
    .map(v => ({ width: v.width as number, height: v.height as number }));
  return { token, name, codec, width: number(config.resolution?.width), height: number(config.resolution?.height),
    fps: number(config.rateControl?.frameRateLimit), bitrate: number(config.rateControl?.bitrateLimit),
    resolutions, fps_range: range(limits.frameRateRange ?? extension.frameRateRange), bitrate_range: range(extension.bitrateRange ?? limits.bitrateRange),
    editable: ['H264', 'JPEG', 'MPEG4'].includes(codec) && resolutions.length > 0,
    revision: revision(config, fingerprint) };
}
export function validateVideoChange(body: unknown): VideoChange {
  const v = object(body);
  if (Object.keys(v).some(key => !['profile_token', 'revision', 'width', 'height', 'fps', 'bitrate'].includes(key)) ||
    typeof v.profile_token !== 'string' || !v.profile_token || v.profile_token.length > 256 ||
    typeof v.revision !== 'string' || !/^[a-f0-9]{64}$/.test(v.revision) ||
    !Number.isInteger(v.width) || !Number.isInteger(v.height) || v.width < 1 || v.height < 1 || v.width > 16384 || v.height > 16384 ||
    ['fps', 'bitrate'].some(key => v[key] !== undefined && (!Number.isInteger(v[key]) || v[key] < 1 || v[key] > 100000))) {
    throw new VideoSettingsError(400, 'Cấu hình video không hợp lệ.');
  }
  return v as VideoChange;
}
export function encoderChange(config: ObjectValue, profile: VideoProfile, change: VideoChange): ObjectValue {
  if (profile.revision !== change.revision) throw new VideoSettingsError(409, 'Cấu hình camera đã thay đổi. Đọc lại trước khi áp dụng.');
  if (!profile.editable) throw new VideoSettingsError(422, 'Camera chưa cung cấp cài đặt cho định dạng video này.');
  if (!profile.resolutions.some(r => r.width === change.width && r.height === change.height)) throw new VideoSettingsError(400, 'Camera không hỗ trợ độ phân giải đã chọn.');
  for (const key of ['fps', 'bitrate'] as const) {
    if (change[key] === undefined || change[key] === profile[key]) continue;
    const limits = profile[key === 'fps' ? 'fps_range' : 'bitrate_range'];
    if (!limits || change[key]! < limits.min || change[key]! > limits.max) throw new VideoSettingsError(400, `${key === 'fps' ? 'FPS' : 'Bitrate'} nằm ngoài giới hạn camera hỗ trợ.`);
  }
  const next: ObjectValue = { ...config, resolution: { width: change.width, height: change.height } };
  if (change.fps !== undefined || change.bitrate !== undefined) next.rateControl = { ...config.rateControl,
    ...(change.fps !== undefined ? { frameRateLimit: change.fps } : {}), ...(change.bitrate !== undefined ? { bitrateLimit: change.bitrate } : {}) };
  // Library setter expects `profile`, while its getter returns `H264Profile`.
  if (config.H264) next.H264 = { ...config.H264, profile: config.H264.profile ?? config.H264.H264Profile };
  if (config.MPEG4) next.MPEG4 = { ...config.MPEG4, profile: config.MPEG4.profile ?? config.MPEG4.MPEG4Profile };
  return next;
}
async function target(id: number) {
  const row = (await pool.query<{ rtsp_url: string; onvif_url: string | null; status: string; enabled: boolean }>('SELECT rtsp_url, onvif_url, status, enabled FROM cameras WHERE id = $1', [id])).rows[0];
  if (!row) throw new VideoSettingsError(404, 'Không tìm thấy camera.');
  if (!row.enabled || row.status !== 'online') throw new VideoSettingsError(409, 'Camera chưa trực tuyến.');
  return row;
}
async function connect(row: Awaited<ReturnType<typeof target>>) {
  const rtsp = new URL(row.rtsp_url), endpoint = new URL(row.onvif_url || `http://${rtsp.hostname}/onvif/device_service`);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new VideoSettingsError(422, 'Địa chỉ ONVIF không hợp lệ.');
  const camera = new Cam({ hostname: endpoint.hostname, port: Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80)),
    path: endpoint.pathname + endpoint.search, useSecure: endpoint.protocol === 'https:', secureOpts: { rejectUnauthorized: false },
    username: decodeURIComponent(rtsp.username), password: decodeURIComponent(rtsp.password), timeout: 6000, preserveAddress: true });
  await camera.connect();
  return camera as unknown as MediaClient;
}
async function readProfiles(client: MediaClient, row: Awaited<ReturnType<typeof target>>) {
  const fingerprint = row.rtsp_url + '|' + row.onvif_url, profiles = await client.getProfiles();
  const entries = [];
  for (const raw of list(profiles).slice(0, 16)) {
    const p = object(raw), token = object(p.$).token, encoderToken = object(object(p.videoEncoderConfiguration).$).token;
    if (typeof token !== 'string' || typeof encoderToken !== 'string') continue;
    const config = object(await client.getVideoEncoderConfiguration(xml(encoderToken)));
    const options = await client.getVideoEncoderConfigurationOptions({ configurationToken: xml(encoderToken), profileToken: xml(token) }).catch(() => null);
    entries.push({ config, profile: videoProfile(token, String(p.name ?? token), config, options, fingerprint) });
  }
  return entries;
}
const writes = new Set<number>();
export const cameraVideo = {
  async get(id: number): Promise<CameraVideoSettings> {
    const row = await target(id);
    try {
      const entries = await readProfiles(await connect(row), row);
      return { supported: entries.length > 0, ...(entries.length ? {} : { reason: 'Camera không cung cấp cấu hình video qua ONVIF.' }), profiles: entries.map(v => v.profile) };
    } catch { return { supported: false, reason: 'Chưa đọc được cấu hình ONVIF. Kiểm tra địa chỉ và tài khoản trong tab Kết nối.', profiles: [] }; }
  },
  async set(id: number, change: VideoChange): Promise<CameraVideoSettings & { confirmed: boolean }> {
    if (writes.has(id)) throw new VideoSettingsError(409, 'Camera đang áp dụng cài đặt. Hãy chờ hoàn tất.');
    writes.add(id);
    try {
      const row = await target(id), client = await connect(row), entries = await readProfiles(client, row);
      const entry = entries.find(v => v.profile.token === change.profile_token);
      if (!entry) throw new VideoSettingsError(400, 'Luồng video không thuộc camera này.');
      const next = encoderChange(entry.config, entry.profile, change);
      const current = await target(id);
      if (current.rtsp_url !== row.rtsp_url || current.onvif_url !== row.onvif_url) throw new VideoSettingsError(409, 'Kết nối camera đã thay đổi. Mở lại cài đặt.');
      await client.setVideoEncoderConfiguration(escaped(next));
      const profiles = (await readProfiles(client, row)).map(v => v.profile), actual = profiles.find(p => p.token === change.profile_token);
      const confirmed = !!actual && actual.width === change.width && actual.height === change.height &&
        (change.fps === undefined || actual.fps === change.fps) && (change.bitrate === undefined || actual.bitrate === change.bitrate);
      return { supported: true, profiles, confirmed };
    } catch (error) {
      if (error instanceof VideoSettingsError) throw error;
      throw new VideoSettingsError(502, 'Chưa xác nhận được cài đặt trên camera. Đọc lại trạng thái trước khi thử lại.');
    } finally { writes.delete(id); }
  },
};
