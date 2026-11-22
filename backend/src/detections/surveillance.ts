import { faceIdentity } from '../identities';

export type Point = [number, number];
export type SurveillanceZone = { id: string; name: string; points: Point[] };
export interface SurveillanceConfig {
  zones_enabled: boolean; zones: SurveillanceZone[];
  intrusion_enabled: boolean; loitering_enabled: boolean; pacing_enabled: boolean; unfamiliar_enabled: boolean;
  manual_pin_enabled: boolean; auto_pin_enabled: boolean; popup_enabled: boolean;
  intrusion_seconds: number; loitering_seconds: number; pacing_reversals: number; pacing_window_seconds: number;
}
export const surveillanceDefaults: SurveillanceConfig = {
  zones_enabled: false, zones: [], intrusion_enabled: false, loitering_enabled: false, pacing_enabled: false,
  unfamiliar_enabled: false, manual_pin_enabled: true, auto_pin_enabled: false, popup_enabled: true,
  intrusion_seconds: 2, loitering_seconds: 30, pacing_reversals: 3, pacing_window_seconds: 60,
};
export function surveillanceConfig(value: unknown): SurveillanceConfig {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return { ...surveillanceDefaults, ...input } as SurveillanceConfig;
}

export function insideSurveillanceZone(point: Point, polygon: Point[]): boolean {
  let inside = false;
  const [x,y] = point;
  for (let i = 0; i < polygon.length; i++) {
    const [ax,ay] = polygon[i], [bx,by] = polygon[(i+1)%polygon.length];
    if (Math.abs((bx-ax)*(y-ay)-(by-ay)*(x-ax)) < 1e-9 && x >= Math.min(ax,bx)-1e-9 && x <= Math.max(ax,bx)+1e-9 && y >= Math.min(ay,by)-1e-9 && y <= Math.max(ay,by)+1e-9) return true;
    if ((ay>y) !== (by>y) && x < (bx-ax)*(y-ay)/(by-ay)+ax) inside = !inside;
  }
  return inside;
}

function validZone(value: unknown): value is SurveillanceZone {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const z = value as SurveillanceZone;
  if (typeof z.id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(z.id) || typeof z.name !== 'string' || z.name.trim().length < 1 || z.name.length > 40 || /[\x00-\x1f]/.test(z.name)) return false;
  if (!Array.isArray(z.points) || z.points.length < 3 || z.points.length > 8 || !z.points.every(p => Array.isArray(p) && p.length === 2 && p.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1))) return false;
  const p = z.points, cross = (a: Point, b: Point, c: Point) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  let area = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i+1)%p.length]; area += a[0]*b[1]-b[0]*a[1];
    if (Math.hypot(a[0]-b[0], a[1]-b[1]) < .02) return false;
    for (let j = i+2; j < p.length; j++) {
      if (i === 0 && j === p.length-1) continue;
      const c = p[j], d = p[(j+1)%p.length];
      if (cross(a,b,c)*cross(a,b,d) <= 0 && cross(c,d,a)*cross(c,d,b) <= 0) return false;
    }
  }
  return Math.abs(area)/2 >= .0025 - 1e-9;
}

export function validSurveillanceConfig(value: unknown): value is SurveillanceConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as SurveillanceConfig;
  if (Object.keys(v).some(key => !Object.prototype.hasOwnProperty.call(surveillanceDefaults,key)) || Object.keys(surveillanceDefaults).some(key => !Object.prototype.hasOwnProperty.call(v,key))) return false;
  for (const key of ['zones_enabled','intrusion_enabled','loitering_enabled','pacing_enabled','unfamiliar_enabled','manual_pin_enabled','auto_pin_enabled','popup_enabled'] as const) if (typeof v[key] !== 'boolean') return false;
  return Array.isArray(v.zones) && v.zones.length <= 3 && v.zones.every(validZone) && new Set(v.zones.map(z => z.id)).size === v.zones.length &&
    (!v.zones_enabled || v.zones.length > 0) && [2,3,5,10].includes(v.intrusion_seconds) && [15,30,60,120,300].includes(v.loitering_seconds) &&
    [3,4,5].includes(v.pacing_reversals) && [30,60,120].includes(v.pacing_window_seconds);
}

export function publicNotice(row: any, people: Map<string, string>) {
  const metrics: Record<string,number> = {};
  for (const key of ['visible_seconds','reversals','window_seconds']) {
    const value = row.metrics?.[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86400) metrics[key] = value;
  }
  return { id: String(row.id), camera_id: row.camera_id, camera_name: row.camera_name, kind: row.kind,
    zone_name: row.zone_name, track_id: row.track_id, track_number: row.track_number, label: row.label,
    detected_at: row.detected_at, metrics, identity: faceIdentity(row.identity, people),
    snapshot_url: row.snapshot_path ? `/${row.snapshot_path}` : null,
    thumbnail_url: row.snapshot_path ? `/api/surveillance/notifications/${row.id}/thumbnail` : null,
    event_id: row.event_id === null || row.event_id === undefined ? null : String(row.event_id), read: !!row.read,
    popup_enabled: surveillanceConfig(row.ai_surveillance).popup_enabled };
}

export function publicPin(row: any, people: Map<string, string>, now = Date.now()) {
  return { id: row.id, camera_id: row.camera_id, camera_name: row.camera_name, track_id: row.track_id,
    track_number: row.track_number, label: row.label, automatic: row.automatic, created_at: row.created_at,
    last_seen_at: row.last_seen_at, identity: faceIdentity(row.identity, people),
    state: row.status === 'online' && row.enabled && row.ai_enabled && now - new Date(row.last_seen_at).getTime() < 20000 ? 'tracking' : 'lost',
    snapshot_url: row.snapshot_path ? `/${row.snapshot_path}` : null, event_id: row.event_id ? String(row.event_id) : null };
}
