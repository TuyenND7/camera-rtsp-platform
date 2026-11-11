import { Cam } from 'onvif/promises';
import { pool } from './db';

/**
 * Điều khiển PTZ qua ONVIF. Dùng lại tài khoản trong RTSP URL của camera (không
 * lưu thêm credential). Địa chỉ ONVIF lấy từ cột onvif_url, hoặc mặc định
 * http://<host RTSP>/onvif/device_service khi để trống.
 */

export interface PtzPreset {
  token: string;
  name: string;
}

export interface PtzInfo {
  supported: boolean;
  reason?: string;
  position?: { x: number; y: number; zoom: number } | null;
  moving?: boolean;
  presets?: PtzPreset[];
}

/** Typings của onvif/promises thiếu tham số cho các lệnh PTZ (thư viện JS vẫn nhận options). */
interface OnvifPtz {
  getStatus(options: object): Promise<unknown>;
  getPresets(options: object): Promise<unknown>;
  continuousMove(options: object): Promise<unknown>;
  stop(options: object): Promise<unknown>;
  gotoPreset(options: object): Promise<unknown>;
  setPreset(options: object): Promise<unknown>;
  removePreset(options: object): Promise<unknown>;
  gotoHomePosition(options: object): Promise<unknown>;
}

interface Session {
  ptz: OnvifPtz;
  profileToken: string;
  /** Khóa để cấu hình đổi (URL/mật khẩu) thì kết nối lại. */
  fingerprint: string;
}

/** Camera tự dừng nếu không nhận lệnh tiếp (mất mạng, đóng tab). Web gửi lại mỗi 1s khi đang giữ nút. */
const MOVE_TIMEOUT_MS = 2000;
const CONNECT_TIMEOUT_MS = 8000;

const sessions = new Map<number, Promise<Session>>();

export class PtzError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
  }
}

/** Xoá kết nối cache khi camera bị sửa/xoá. */
export function invalidatePtz(cameraId: number): void {
  sessions.delete(cameraId);
}

export async function ptzInfo(cameraId: number): Promise<PtzInfo> {
  let session: Session;
  try {
    session = await getSession(cameraId);
  } catch (err) {
    return { supported: false, reason: (err as Error).message };
  }
  return withRetry(cameraId, session, async (s) => {
    const [status, presets, names] = await Promise.all([
      s.ptz.getStatus({ profileToken: s.profileToken }).catch(() => null),
      s.ptz.getPresets({ profileToken: s.profileToken }).catch(() => ({})),
      presetNames(cameraId),
    ]);
    const statusObj = asObject(status);
    const pos = asObject(statusObj.position);
    const moveStatus = asObject(statusObj.moveStatus);
    return {
      supported: true,
      position: status ? { x: num(pos.x), y: num(pos.y), zoom: num(pos.zoom) } : null,
      moving: moveStatus.panTilt === 'MOVING' || moveStatus.zoom === 'MOVING',
      presets: parsePresets(presets, names),
    };
  });
}

async function presetNames(cameraId: number): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ token: string; name: string }>(
    'SELECT token, name FROM ptz_presets WHERE camera_id = $1',
    [cameraId]
  );
  return new Map(rows.map((row) => [row.token, row.name]));
}

/**
 * onvif trả { [key]: token } hoặc { [key]: { $: { token }, name } } tùy camera/phiên bản.
 * Tên lấy từ DB nếu có (camera nhiều khi chỉ lưu số).
 */
function parsePresets(raw: unknown, names: Map<string, string>): PtzPreset[] {
  return Object.entries(asObject(raw))
    .map(([key, value]) => {
      let token = String(value);
      let cameraName = key;
      if (value && typeof value === 'object') {
        const entry = asObject(value);
        token = String(asObject(entry.$).token ?? key);
        cameraName = String(entry.name ?? key);
      }
      return { token, name: names.get(token) ?? `Preset ${cameraName}` };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'vi', { numeric: true }));
}

/** Quay/zoom liên tục với vận tốc -1..1. Gửi 0,0,0 tương đương dừng. */
export async function ptzMove(cameraId: number, velocity: { x: number; y: number; zoom: number }): Promise<void> {
  const session = await getSession(cameraId);
  await withRetry(cameraId, session, (s) => s.ptz.continuousMove({
    profileToken: s.profileToken,
    x: velocity.x,
    y: velocity.y,
    zoom: velocity.zoom,
    timeout: MOVE_TIMEOUT_MS,
  }));
}

export async function ptzStop(cameraId: number): Promise<void> {
  const session = await getSession(cameraId);
  await withRetry(cameraId, session, (s) => s.ptz.stop({ profileToken: s.profileToken, panTilt: true, zoom: true }));
}

export async function ptzGotoPreset(cameraId: number, token: string): Promise<void> {
  const session = await getSession(cameraId);
  await withRetry(cameraId, session, (s) => s.ptz.gotoPreset({ profileToken: s.profileToken, preset: xml(token) }));
}

/**
 * Lưu vị trí hiện tại thành preset. Camera Tenda chỉ nhận ổn định khi truyền
 * PresetToken cụ thể và tên ASCII, nên chọn số trống nhỏ nhất; tên hiển thị lưu DB.
 */
export async function ptzSetPreset(cameraId: number, name: string): Promise<string> {
  const session = await getSession(cameraId);
  return withRetry(cameraId, session, async (s) => {
    const existing = parsePresets(await s.ptz.getPresets({ profileToken: s.profileToken }), new Map());
    const used = new Set(existing.map((preset) => preset.token));
    let slot = 1;
    while (used.has(String(slot))) slot++;
    const response = await s.ptz.setPreset({
      profileToken: s.profileToken,
      presetToken: String(slot),
      presetName: `Preset${slot}`,
    });
    const token = /"presetToken":\["?([^"\]]+)"?\]/.exec(JSON.stringify(response))?.[1] ?? String(slot);
    await pool.query(
      `INSERT INTO ptz_presets (camera_id, token, name) VALUES ($1, $2, $3)
       ON CONFLICT (camera_id, token) DO UPDATE SET name = EXCLUDED.name, created_at = now()`,
      [cameraId, token, name]
    );
    return token;
  });
}

export async function ptzRemovePreset(cameraId: number, token: string): Promise<void> {
  const session = await getSession(cameraId);
  await withRetry(cameraId, session, (s) => s.ptz.removePreset({ profileToken: s.profileToken, presetToken: xml(token) }));
  await pool.query('DELETE FROM ptz_presets WHERE camera_id = $1 AND token = $2', [cameraId, token]);
}

export async function ptzHome(cameraId: number): Promise<void> {
  const session = await getSession(cameraId);
  await withRetry(cameraId, session, (s) => s.ptz.gotoHomePosition({ profileToken: s.profileToken }));
}

// ---- Kết nối ----

async function getSession(cameraId: number): Promise<Session> {
  const target = await loadTarget(cameraId);
  const cached = sessions.get(cameraId);
  if (cached) {
    const session = await cached.catch(() => null);
    if (session && session.fingerprint === target.fingerprint) return session;
    sessions.delete(cameraId);
  }
  const pending = connect(target);
  sessions.set(cameraId, pending);
  try {
    return await pending;
  } catch (err) {
    sessions.delete(cameraId);
    throw err;
  }
}

/** Kết nối cache có thể hỏng (camera khởi động lại): thử kết nối lại một lần. */
async function withRetry<T>(cameraId: number, session: Session, fn: (s: Session) => Promise<T>): Promise<T> {
  try {
    return await fn(session);
  } catch (first) {
    invalidatePtz(cameraId);
    try {
      return await fn(await getSession(cameraId));
    } catch (err) {
      throw new PtzError(`Camera không nhận lệnh PTZ: ${safeMessage(err ?? first, session)}`, 502);
    }
  }
}

interface Target {
  hostname: string;
  port: number;
  path: string;
  useSecure: boolean;
  username: string;
  password: string;
  fingerprint: string;
}

async function loadTarget(cameraId: number): Promise<Target> {
  const { rows } = await pool.query<{ rtsp_url: string; onvif_url: string | null }>(
    'SELECT rtsp_url, onvif_url FROM cameras WHERE id = $1',
    [cameraId]
  );
  const row = rows[0];
  if (!row) throw new PtzError('Không tìm thấy camera', 404);

  let rtsp: URL;
  try {
    rtsp = new URL(row.rtsp_url);
  } catch {
    throw new PtzError('RTSP URL của camera không hợp lệ');
  }
  const username = decodeURIComponent(rtsp.username);
  const password = decodeURIComponent(rtsp.password);
  if (!username) throw new PtzError('RTSP URL không có tài khoản — PTZ cần tài khoản ONVIF giống RTSP');

  const onvif = new URL(row.onvif_url || `http://${rtsp.hostname}/onvif/device_service`);
  if (!['http:', 'https:'].includes(onvif.protocol)) throw new PtzError('ONVIF URL phải là http(s)');
  const useSecure = onvif.protocol === 'https:';
  const port = Number(onvif.port || (useSecure ? 443 : 80));
  const path = `${onvif.pathname || '/onvif/device_service'}${onvif.search}`;
  return {
    hostname: onvif.hostname,
    port,
    path,
    useSecure,
    username,
    password,
    fingerprint: `${onvif.href}|${username}|${password}`,
  };
}

async function connect(target: Target): Promise<Session> {
  const cam = new Cam({
    hostname: target.hostname,
    port: target.port,
    path: target.path,
    useSecure: target.useSecure,
    secureOpts: { rejectUnauthorized: false },
    username: target.username,
    password: target.password,
    timeout: CONNECT_TIMEOUT_MS,
    preserveAddress: true,
  });
  try {
    await cam.connect();
  } catch (err) {
    throw new PtzError(`Không kết nối được ONVIF (${target.hostname}:${target.port}): ${hide(err, target.password)}`);
  }
  const uri = asObject((cam as unknown as { uri?: unknown }).uri);
  if (!uri.ptz) throw new PtzError('Camera không có dịch vụ PTZ ONVIF');

  const profiles = Array.isArray((cam as unknown as { profiles?: unknown }).profiles)
    ? ((cam as unknown as { profiles: unknown[] }).profiles)
    : [];
  const ptzProfile = profiles.map(asObject).find((profile) => profile.PTZConfiguration);
  const token = asObject(ptzProfile?.$).token;
  if (typeof token !== 'string') throw new PtzError('Không có ONVIF profile nào hỗ trợ PTZ');
  return { ptz: cam as unknown as OnvifPtz, profileToken: token, fingerprint: target.fingerprint };
}

// ---- Tiện ích ----

function xml(value: string): string {
  return value.replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch] as string));
}

function hide(err: unknown, password: string): string {
  const message = err instanceof Error ? err.message : String(err);
  return (password ? message.split(password).join('***') : message).slice(0, 300);
}

function safeMessage(err: unknown, session: Session): string {
  const password = session.fingerprint.split('|').pop() ?? '';
  return hide(err, password);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
