import fs from 'fs/promises';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { config } from '../config';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
type CameraIdentity = { id: number; rtsp_url: string; device_serial: string | null };
const pending = new Map<number, Promise<boolean>>();
export function targetHash(url: string) { const target = new URL(url); target.hostname = 'camera.invalid'; return hash(target.toString()); }
export function matchesBindingIdentity(camera: CameraIdentity, binding: any) {
  try { return !!camera.device_serial && binding?.id === camera.id && digest(binding.serial_hash) && digest(binding.target_hash) && binding.serial_hash === hash(camera.device_serial) && binding.target_hash === targetHash(camera.rtsp_url); }
  catch { return false; }
}

/** Only an unchanged RTSP target and a live ONVIF serial check may update an
 * address. Manual replacement, changed credentials/path and unknown devices
 * retain the strict URL binding. IoT IDs and cloud credentials never change. */
export function synchronizeBindingAddress(camera: CameraIdentity, verifySerial: () => Promise<boolean>, root = path.join(config.storageRoot, '.tenda-talk')): Promise<boolean> {
  const previous = pending.get(camera.id); if (previous) return previous;
  const job = (async () => {
    const file = path.join(root, 'status.json'), st = await fs.lstat(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 16384) return false;
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
    if (manifest.version !== 1 || manifest.authenticated !== true || !Number.isFinite(manifest.updated_at) || Math.abs(Date.now() - manifest.updated_at) > 3000 || !Array.isArray(manifest.bindings) || manifest.bindings.length > 16) return false;
    const binding = manifest.bindings.find((binding: any) => binding.id === camera.id);
    const current = hash(camera.rtsp_url);
    if (binding?.url_hash === current || !matchesBindingIdentity(camera, binding) || !digest(binding.original_url_hash)) return false;
    if (!await verifySerial()) return false;
    const value = { version: 1, original_url_hash: binding.original_url_hash, url_hash: current, serial_hash: binding.serial_hash, target_hash: binding.target_hash };
    const directory = path.join(root, 'bindings'); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(directory)).isSymbolicLink()) return false;
    const temporary = path.join(directory, `${camera.id}-${randomUUID()}.tmp`);
    try { await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await fs.rename(temporary, path.join(directory, `${camera.id}.json`)); }
    finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
    return true;
  })().catch(() => false).finally(() => pending.delete(camera.id));
  pending.set(camera.id, job); return job;
}
