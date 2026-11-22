import fs from 'fs/promises';
import path from 'path';
import { config } from '../config';
import { faceIdentity, FaceIdentity } from '../identities';
import { surveillanceConfig, SurveillanceZone, insideSurveillanceZone } from './surveillance';
import { encoderBudget } from '../system/performance';

export type Detection = { label: string; confidence: number; box: [number, number, number, number]; track_id?: string; track_number?: number; identity?: FaceIdentity };
export type DetectionFrame = { at: number; width: number; height: number; detections: Detection[] };
export type LiveDetections = { camera_id: number; state: string; synchronized: boolean; updated_at: number; server_time: number; frame_ttl_ms: number; frames: DetectionFrame[]; manual_pin_enabled?: boolean; zones?: SurveillanceZone[] };
export const detectionLabels = ['person', 'car', 'motorcycle', 'bicycle', 'truck', 'bus', 'cat', 'dog'];
const labels = new Set(detectionLabels);
type OverlaySettings = { ai_overlay_enabled?: boolean; ai_overlay_labels?: string[] };

export function isOverlaySettingsValid(enabled: unknown, selected: unknown): boolean {
  return (enabled === undefined || typeof enabled === 'boolean') && (selected === undefined ||
    (Array.isArray(selected) && selected.length <= labels.size && new Set(selected).size === selected.length && selected.every(label => typeof label === 'string' && labels.has(label))));
}

export function filterLiveOverlay(value: LiveDetections, settings: OverlaySettings): LiveDetections {
  if (settings.ai_overlay_enabled === false || settings.ai_overlay_labels?.length === 0) return { ...value, state: 'hidden', frames: [] };
  if (!settings.ai_overlay_labels) return value;
  const selected = new Set(settings.ai_overlay_labels);
  return { ...value, frames: value.frames.map(frame => ({ ...frame, detections: frame.detections.filter(detection => selected.has(detection.label)) })) };
}
const object = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};

export function sanitizeLiveDetections(raw: unknown, cameraId: number, fps: number, now = Date.now(), people = new Map<string, string>()): LiveDetections {
  const fallback: LiveDetections = { camera_id: cameraId, state: 'waiting', synchronized: false, updated_at: 0, server_time: now, frame_ttl_ms: Math.max(750, Math.min(2500, 1500 / Math.max(.1, fps))), frames: [] };
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
      if (box[2] > box[0] && box[3] > box[1]) {
        const detection: Detection = { label: d.label, confidence: d.confidence, box };
        if (Number.isInteger(d.track_number) && d.track_number > 0 && d.track_number <= 2147483647 && typeof d.track_id === 'string' && new RegExp(`^c${cameraId}-[a-f0-9]{12}-${d.track_number}$`).test(d.track_id)) {
          detection.track_id = d.track_id; detection.track_number = d.track_number;
        }
        const identity = d.label === 'person' ? faceIdentity(d.identity, people) : undefined;
        if (identity) detection.identity = identity;
        detections.push(detection);
      }
    }
    frames.push({ at, width, height, detections });
  }
  frames.sort((a, b) => a.at - b.at);
  return { ...fallback, state: ['ready', 'error', 'stopped'].includes(value.state) ? value.state : 'waiting', synchronized, updated_at: value.updated_at, frames };
}

export async function readLiveDetections(camera: { id: number; status: string; ai_enabled: boolean; enabled: boolean; ai_fps: number; ai_identity_enabled?: boolean; ai_surveillance?: unknown } & OverlaySettings, people = new Map<string, string>()): Promise<LiveDetections> {
  const rules = surveillanceConfig(camera.ai_surveillance);
  const settings = { manual_pin_enabled: rules.manual_pin_enabled, zones: rules.zones_enabled ? rules.zones : [] };
  const fps=Math.min(camera.ai_fps,encoderBudget().ai_max_fps);
  const empty = { ...sanitizeLiveDetections(null, camera.id, fps), ...settings };
  if (!camera.enabled || !camera.ai_enabled) return { ...empty, state: 'disabled' };
  if (camera.status !== 'online') return { ...empty, state: 'offline' };
  if (camera.ai_overlay_enabled === false || camera.ai_overlay_labels?.length === 0) return filterLiveOverlay(empty, camera);
  try {
    const file = path.join(config.storageRoot, '.detections', `${camera.id}.json`);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) return empty;
    const value = sanitizeLiveDetections(JSON.parse(await fs.readFile(file, 'utf8')), camera.id, fps, Date.now(), people);
    for (const frame of value.frames) for (const detection of frame.detections) {
      if (!camera.ai_identity_enabled) delete detection.identity;
      else if (detection.label === 'person' && !detection.identity) detection.identity = { state: 'pending' };
    }
    if (rules.zones_enabled) for (const frame of value.frames) frame.detections = frame.detections.filter(d => {
      const [x1,y1,x2,y2] = d.box;
      const point: [number,number] = [(x1+x2)/2/frame.width, (d.label === 'person' ? y2 : (y1+y2)/2)/frame.height];
      return rules.zones.some(zone => insideSurveillanceZone(point,zone.points));
    });
    return { ...filterLiveOverlay(value, camera), ...settings };
  } catch { return empty; }
}
