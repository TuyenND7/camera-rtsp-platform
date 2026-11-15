import fs from 'fs/promises';
import path from 'path';
import { config } from '../config';

export type Detection = { label: string; confidence: number; box: [number, number, number, number] };
export type DetectionFrame = { at: number; width: number; height: number; detections: Detection[] };
export type LiveDetections = { camera_id: number; state: string; synchronized: boolean; updated_at: number; frame_ttl_ms: number; frames: DetectionFrame[] };
const labels = new Set(['person', 'car', 'motorcycle', 'bicycle', 'truck', 'bus']);
const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};

export function sanitizeLiveDetections(raw: unknown, cameraId: number, fps: number, now = Date.now()): LiveDetections {
  const fallback: LiveDetections = { camera_id: cameraId, state: 'waiting', synchronized: false, updated_at: 0, frame_ttl_ms: Math.max(750, Math.min(2500, 1500 / Math.max(.1, fps))), frames: [] };
  const value = object(raw);
  if (value.version !== 1 || value.camera_id !== cameraId || !Number.isFinite(value.updated_at) || value.updated_at > now + 3000 || value.updated_at < now - 12000) return fallback;
  const synchronized = value.synchronized === true;
  const frames: DetectionFrame[] = [];
  if (synchronized && Array.isArray(value.frames)) for (const item of value.frames.slice(-300)) {
    const frame = object(item), { at, width, height } = frame;
    if (!Number.isFinite(at) || at < now - 30000 || at > now + 3000 || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || !Array.isArray(frame.detections)) continue;
    const detections: Detection[] = [];
    for (const raw of frame.detections.slice(0, 32)) {
      const d = object(raw);
      if (!labels.has(d.label) || !Number.isFinite(d.confidence) || d.confidence < 0 || d.confidence > 1 || !Array.isArray(d.box) || d.box.length !== 4 || !d.box.every(Number.isFinite)) continue;
      const [left, top, right, bottom] = d.box as number[];
      const box: Detection['box'] = [Math.max(0, Math.min(width, left)), Math.max(0, Math.min(height, top)), Math.max(0, Math.min(width, right)), Math.max(0, Math.min(height, bottom))];
      if (box[2] > box[0] && box[3] > box[1]) detections.push({ label: d.label, confidence: d.confidence, box });
    }
    frames.push({ at, width, height, detections });
  }
  frames.sort((a, b) => a.at - b.at);
  return { ...fallback, state: ['ready', 'error', 'stopped'].includes(value.state) ? value.state : 'waiting', synchronized, updated_at: value.updated_at, frames };
}

export async function readLiveDetections(camera: { id: number; status: string; ai_enabled: boolean; enabled: boolean; ai_fps: number }): Promise<LiveDetections> {
  const empty = sanitizeLiveDetections(null, camera.id, camera.ai_fps);
  if (!camera.enabled || !camera.ai_enabled) return { ...empty, state: 'disabled' };
  if (camera.status !== 'online') return { ...empty, state: 'offline' };
  try {
    const file = path.join(config.storageRoot, '.detections', `${camera.id}.json`);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) return empty;
    return sanitizeLiveDetections(JSON.parse(await fs.readFile(file, 'utf8')), camera.id, camera.ai_fps);
  } catch { return empty; }
}
