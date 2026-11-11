import net from 'net';
import { Cam } from 'onvif/promises';
import { pool } from './db';
import { invalidatePtz } from './ptz';

/**
 * Camera Wi-Fi dùng DHCP hay bị router đổi IP (vd .104 -> .102 -> .101). Khi
 * RTSP không kết nối được, quét subnet /24 của IP cũ, hỏi ONVIF từng máy mở cổng
 * RTSP và so serial với serial đã lưu, rồi cập nhật IP trong cấu hình camera.
 */

const PROBE_TIMEOUT_MS = 1200;
const PROBE_CONCURRENCY = 64;
const ONVIF_TIMEOUT_MS = 5000;
/** Không quét lại cùng một camera quá thường xuyên. */
const MIN_INTERVAL_MS = 5 * 60_000;

interface CameraNetRow {
  id: number;
  rtsp_url: string;
  ai_rtsp_url: string | null;
  onvif_url: string | null;
  device_serial: string | null;
}

export interface RediscoveryResult {
  from: string;
  to: string;
}

const lastScan = new Map<number, number>();
const running = new Map<number, Promise<RediscoveryResult | null>>();

export function canPortConnect(host: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Lưu serial lần đầu camera online, để sau này nhận ra camera khi đổi IP. */
export async function rememberSerial(cameraId: number): Promise<void> {
  const cam = await loadCamera(cameraId);
  if (!cam || cam.device_serial) return;
  const rtsp = new URL(cam.rtsp_url);
  const serial = await readSerial(rtsp.hostname, onvifPort(cam), credentials(rtsp));
  if (!serial) return;
  await pool.query('UPDATE cameras SET device_serial = $1 WHERE id = $2 AND device_serial IS NULL', [serial, cameraId]);
  console.log(`[discovery] camera ${cameraId} serial ${serial}`);
}

/**
 * Tìm IP mới của camera. Trả null nếu IP hiện tại vẫn kết nối được, chưa biết
 * serial, vừa quét gần đây (trừ khi force), hoặc không tìm thấy.
 */
export function rediscoverCamera(cameraId: number, force = false): Promise<RediscoveryResult | null> {
  const pending = running.get(cameraId);
  if (pending) return pending;
  if (!force && Date.now() - (lastScan.get(cameraId) ?? 0) < MIN_INTERVAL_MS) return Promise.resolve(null);
  lastScan.set(cameraId, Date.now());
  const task = scan(cameraId).finally(() => running.delete(cameraId));
  running.set(cameraId, task);
  return task;
}

async function scan(cameraId: number): Promise<RediscoveryResult | null> {
  const cam = await loadCamera(cameraId);
  if (!cam?.device_serial) return null;
  const rtsp = new URL(cam.rtsp_url);
  const oldHost = rtsp.hostname;
  const rtspPort = Number(rtsp.port || 554);
  if (await canPortConnect(oldHost, rtspPort)) return null;

  const match = /^(\d+\.\d+\.\d+)\.(\d+)$/.exec(oldHost);
  if (!match) return null; // hostname/DNS: không quét được
  const prefix = match[1];
  const candidates = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`).filter((host) => host !== oldHost);

  const open: string[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, async () => {
    while (next < candidates.length) {
      const host = candidates[next++];
      if (await canPortConnect(host, rtspPort)) open.push(host);
    }
  }));
  console.log(`[discovery] camera ${cameraId}: ${oldHost} unreachable; RTSP open on ${open.join(', ') || 'none'}`);

  const creds = credentials(rtsp);
  for (const host of open) {
    const serial = await readSerial(host, onvifPort(cam), creds);
    if (serial !== cam.device_serial) continue;
    await moveCamera(cam, oldHost, host);
    console.log(`[discovery] camera ${cameraId} moved ${oldHost} -> ${host} (serial ${serial})`);
    return { from: oldHost, to: host };
  }
  return null;
}

async function moveCamera(cam: CameraNetRow, oldHost: string, newHost: string): Promise<void> {
  const swap = (value: string | null) => {
    if (!value) return value;
    try {
      const url = new URL(value);
      if (url.hostname !== oldHost) return value;
      url.hostname = newHost;
      return url.toString();
    } catch {
      return value;
    }
  };
  await pool.query(
    'UPDATE cameras SET rtsp_url = $1, ai_rtsp_url = $2, onvif_url = $3, updated_at = now() WHERE id = $4',
    [swap(cam.rtsp_url), swap(cam.ai_rtsp_url), swap(cam.onvif_url), cam.id]
  );
  invalidatePtz(cam.id);
}

async function readSerial(host: string, port: number, creds: { username: string; password: string }): Promise<string | null> {
  try {
    const cam = new Cam({
      hostname: host,
      port,
      username: creds.username,
      password: creds.password,
      timeout: ONVIF_TIMEOUT_MS,
      preserveAddress: true,
    });
    await cam.connect();
    const info = (await cam.getDeviceInformation()) as { serialNumber?: unknown };
    return typeof info?.serialNumber === 'string' && info.serialNumber ? info.serialNumber : null;
  } catch {
    return null;
  }
}

async function loadCamera(cameraId: number): Promise<CameraNetRow | null> {
  const { rows } = await pool.query<CameraNetRow>(
    'SELECT id, rtsp_url, ai_rtsp_url, onvif_url, device_serial FROM cameras WHERE id = $1',
    [cameraId]
  );
  return rows[0] ?? null;
}

function credentials(rtsp: URL) {
  return { username: decodeURIComponent(rtsp.username), password: decodeURIComponent(rtsp.password) };
}

function onvifPort(cam: CameraNetRow): number {
  if (!cam.onvif_url) return 80;
  try {
    const url = new URL(cam.onvif_url);
    return Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  } catch {
    return 80;
  }
}
