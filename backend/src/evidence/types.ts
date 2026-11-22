export type ClipStatus = 'preparing' | 'queued' | 'processing' | 'ready' | 'error' | 'cancelled';
export type ClipKind = 'protected' | 'preview';
export interface ClipGap { start_at: string; end_at: string; seconds: number }
export interface ClipPart { file: string; duration: number; start: number; size: number; local: string }
export interface ClipPlan {
  source: 'rec' | 'playback'; parts: ClipPart[]; gaps: ClipGap[];
  start: number; end: number; seek: number; duration: number; sourceBytes: number;
}
export interface ClipRow {
  id: string; kind: ClipKind; camera_id: number | null; camera_name: string; title: string;
  start_at: string | Date; end_at: string | Date; status: ClipStatus; progress: number;
  duration_seconds: number | null; size_bytes: number | string; reserved_bytes: number | string;
  gaps: ClipGap[]; source_plan: ClipPlan; error: string | null;
  event_id: string | null; notice_id: string | null; created_by: number | null;
  created_at: string | Date; updated_at: string | Date; expires_at: string | Date | null;
}
export class EvidenceError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
export const validUuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export const validTargetId = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
export const validCameraId = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0 && Number(value) <= 2147483647;
export function validateWindow(start: unknown, end: unknown, preview = false): { start: number; end: number } {
  const iso = (value: unknown) => {
    const match=typeof value==='string'?/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value):null;
    if(!match)return NaN;
    const [,y,month,day,hour,minute,second]=match.map(Number),calendar=new Date(Date.UTC(y,month-1,day,hour,minute,second));
    if(calendar.getUTCFullYear()!==y||calendar.getUTCMonth()!==month-1||calendar.getUTCDate()!==day||calendar.getUTCHours()!==hour||calendar.getUTCMinutes()!==minute||calendar.getUTCSeconds()!==second)return NaN;
    return Date.parse(value as string);
  };
  const a = iso(start), b = iso(end), max = preview ? 10_000 : 1800_000;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b - a < (preview ? 5000 : 500) || b - a > max || a < Date.UTC(2000, 0, 1) || b > Date.now() + 30_000) {
    throw new EvidenceError(preview ? 'Chọn bản xem trước từ 5 đến 10 giây.' : 'Chọn thời gian bắt đầu/kết thúc, tối đa 30 phút.');
  }
  return { start: a, end: b };
}
export function publicClip(row: ClipRow) {
  return { id: row.id, kind: row.kind, camera_id: row.camera_id, camera_name: row.camera_name, title: row.title,
    start_at: row.start_at, end_at: row.end_at, status: row.status, progress: row.progress,
    duration_seconds: row.duration_seconds, size_bytes: Number(row.size_bytes), gaps: row.gaps,
    error: row.error, event_id: row.event_id, notice_id: row.notice_id, created_at: row.created_at,
    expires_at: row.expires_at, download_url: row.status === 'ready' ? `/api/evidence/clips/${row.id}/download` : null };
}
