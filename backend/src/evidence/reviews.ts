import { randomUUID } from 'crypto';
import { pool } from '../db';
import { identityMetadata, identityPeople, faceIdentity } from '../identities';
import { EvidenceError, validCameraId, validTargetId } from './types';

export type ReviewType = 'event' | 'notice';
export const reviewStatuses = ['unreviewed','reviewed','important','false_positive'];
export function reviewType(value: unknown): ReviewType {
  if (value !== 'event' && value !== 'notice') throw new EvidenceError('Loại đánh giá không hợp lệ.');
  return value;
}
export function reviewBody(value: unknown): { status: string; note: string } {
  const body = value as Record<string,unknown>;
  if (!body || typeof body !== 'object' || Object.keys(body).some(key => !['status','note'].includes(key)) || !reviewStatuses.includes(String(body.status)) || typeof body.note !== 'string' || body.note.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(body.note)) throw new EvidenceError('Chọn đánh giá và ghi chú tối đa 500 ký tự.');
  return { status: String(body.status), note: body.note.trim() };
}
export async function reviews(type: ReviewType, ids: string[]) {
  if (ids.length < 1 || ids.length > 100 || ids.some(id => !validTargetId(id))) throw new EvidenceError('Chọn tối đa 100 sự kiện.');
  const column = type === 'event' ? 'event_id' : 'notice_id';
  const { rows } = await pool.query(`SELECT r.${column}::text AS target_id,r.status,r.note,r.updated_at,u.username AS updated_by
    FROM evidence_reviews r LEFT JOIN users u ON u.id=r.updated_by WHERE r.${column}=ANY($1::bigint[])`,[ids]);
  return rows.map(row => ({ ...row,target_type: type }));
}
export async function saveReview(type: ReviewType, id: string, body: { status: string; note: string }, actor: number) {
  if (!validTargetId(id)) throw new EvidenceError('Sự kiện không hợp lệ.');
  const table = type === 'event' ? 'detection_events' : 'surveillance_notifications', column = type === 'event' ? 'event_id' : 'notice_id';
  const result = await pool.query(`INSERT INTO evidence_reviews(id,${column},status,note,updated_by)
    SELECT $1,e.id,$3,$4,$5 FROM ${table} e WHERE e.id=$2
    ON CONFLICT(${column}) DO UPDATE SET status=EXCLUDED.status,note=EXCLUDED.note,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING id`,
    [randomUUID(),id,body.status,body.note,actor]);
  if (!result.rowCount) throw new EvidenceError('Không tìm thấy sự kiện.',404);
  return (await reviews(type,[id]))[0];
}
/** Camera/time buckets collect activity; each object keeps its independent track ID. */
export async function activityGroups(filters: { camera_id?: number; from: string; to: string; window_seconds: number; limit: number }) {
  if ((filters.camera_id !== undefined && !validCameraId(filters.camera_id)) || !Number.isFinite(Date.parse(filters.from)) || !Number.isFinite(Date.parse(filters.to)) || Date.parse(filters.to)-Date.parse(filters.from) > 7*86400_000 || Date.parse(filters.to)<=Date.parse(filters.from) || ![30,60,120,300].includes(filters.window_seconds) || !Number.isInteger(filters.limit) || filters.limit < 1 || filters.limit > 100) throw new EvidenceError('Bộ lọc hoạt động không hợp lệ.');
  const { rows } = await pool.query(`SELECT * FROM (
    SELECT 'event'::text AS target_type,e.id::text AS target_id,e.camera_id,c.name AS camera_name,e.detected_at,e.label,
      e.metadata->>'track_id' AS track_id,e.metadata->>'track_number' AS track_number,e.metadata->'identity' AS identity,e.snapshot_path,NULL::text AS kind
      FROM detection_events e JOIN cameras c ON c.id=e.camera_id WHERE e.detected_at >= $1 AND e.detected_at <= $2 AND ($3::int IS NULL OR e.camera_id=$3)
    UNION ALL
    SELECT 'notice',n.id::text,n.camera_id,c.name,n.detected_at,n.label,n.track_id,n.track_number::text,n.identity,n.snapshot_path,n.kind
      FROM surveillance_notifications n JOIN cameras c ON c.id=n.camera_id WHERE n.label<>'system' AND n.detected_at >= $1 AND n.detected_at <= $2 AND ($3::int IS NULL OR n.camera_id=$3)
    ) activity ORDER BY detected_at DESC LIMIT 500`,[filters.from,filters.to,filters.camera_id ?? null]);
  const people = await identityPeople();
  const groups = new Map<string,any>();
  for (const row of rows) {
    const at = new Date(row.detected_at).getTime(), key = `${row.camera_id}:${Math.floor(at/(filters.window_seconds*1000))}`;
    const item = { target_type: row.target_type, target_id: row.target_id, detected_at: row.detected_at,label: row.label,kind: row.kind,
      track_id: row.track_id,track_number: Number(row.track_number) || null,identity: row.label === 'person' ? faceIdentity(row.identity,people) : undefined,
      thumbnail_url: row.snapshot_path ? row.target_type === 'event' ? `/api/events/${row.target_id}/thumbnail` : `/api/surveillance/notifications/${row.target_id}/thumbnail` : null };
    let group = groups.get(key);
    if (!group) { group = { id: key,camera_id: row.camera_id,camera_name: row.camera_name,from: row.detected_at,to: row.detected_at,items: [],objects: [] }; groups.set(key,group); }
    group.from = row.detected_at; group.items.push(item);
    if (!group.objects.some((object: any) => row.track_id ? object.track_id === row.track_id : object.target_id === row.target_id && object.target_type === row.target_type)) group.objects.push(item);
  }
  return { items: [...groups.values()].slice(0,filters.limit),window_seconds: filters.window_seconds,truncated: rows.length === 500 || groups.size > filters.limit };
}
