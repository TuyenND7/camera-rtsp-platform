import fs from 'fs/promises';
import path from 'path';
import { randomUUID, createHash } from 'crypto';
import { pool } from '../db';
import { config } from '../config';
import { evidenceLimits } from './limits';
import { clipRoot, jobDirectory, privateDirectory, removeJobFiles, safeStorageFile, snapshotSource } from './paths';
import { ClipKind, ClipRow, EvidenceError, publicClip, validCameraId, validTargetId, validUuid, validateWindow } from './types';
import { recordingPlan } from './plan';
import { renderClip, inspectMp4 } from './encoder';

const activeStates = ['preparing','queued','processing'];
const WORKER_LOCK = 41702012, QUOTA_LOCK = 41702013, SOURCE_LOCK = 41702014;
export interface ClipRequest { camera_id: number; start_at: string; end_at: string; title?: string; event_id?: string; notice_id?: string; idempotency_key?: string }
export async function clipRow(id: string): Promise<ClipRow | undefined> {
  if (!validUuid(id)) throw new EvidenceError('Clip không hợp lệ.');
  return (await pool.query<ClipRow>('SELECT * FROM evidence_clips WHERE id=$1',[id])).rows[0];
}
async function diskUsage() {
  await privateDirectory(clipRoot());
  let total = 0, count = 0; const byJob = new Map<string,number>();
  const walk = async (directory: string, job = '') => {
    for (const entry of await fs.readdir(directory,{ withFileTypes: true })) {
      if (++count > 100_000) throw new EvidenceError('Kho clip có quá nhiều file để kiểm tra hạn mức.',507);
      const file = path.join(directory,entry.name), stat = await fs.lstat(file);
      const id = job || (validUuid(entry.name) ? entry.name : 'unknown');
      if (stat.isSymbolicLink()) { total += stat.size; byJob.set(id,(byJob.get(id) ?? 0)+stat.size); }
      else if (stat.isDirectory()) await walk(file,id);
      else if (stat.isFile()) { total += stat.size; byJob.set(id,(byJob.get(id) ?? 0)+stat.size); }
    }
  };
  await walk(clipRoot());
  return { total, byJob };
}
export async function evidenceQuota(excludeIds: string[] = []) {
  const disk = await diskUsage(), { rows } = await pool.query<ClipRow>('SELECT id,reserved_bytes FROM evidence_clips WHERE status=ANY($1::text[])',[activeStates]);
  const reserved = rows.filter(row=>!excludeIds.includes(row.id)).reduce((sum,row) => sum + Math.max(0,Number(row.reserved_bytes)-(disk.byJob.get(row.id) ?? 0)),0);
  const stat = await fs.statfs(config.storageRoot), limits = evidenceLimits();
  return { used_bytes: disk.total, reserved_bytes: reserved, max_bytes: limits.maxBytes,
    free_bytes: Number(stat.bavail)*Number(stat.bsize), min_free_bytes: limits.minFreeBytes };
}
export async function targetRecording(type: unknown, id: unknown) {
  if (!['event','notice'].includes(String(type)) || !validTargetId(id)) throw new EvidenceError('Sự kiện không hợp lệ.');
  const table = type === 'event' ? 'detection_events' : 'surveillance_notifications';
  const { rows } = await pool.query(`SELECT e.id,e.camera_id,c.name AS camera_name,e.detected_at,e.label FROM ${table} e JOIN cameras c ON c.id=e.camera_id WHERE e.id=$1`,[id]);
  if (!rows[0]) throw new EvidenceError('Không tìm thấy sự kiện.',404);
  if (rows[0].label === 'system') throw new EvidenceError('Thông báo máy chủ không có video sự kiện.',409);
  return rows[0] as { id: string; camera_id: number; camera_name: string; detected_at: Date; label: string };
}
/** Retention checks its lease under the same camera lock as accepted exports. */
export async function withEvidenceRetentionGuard(cameraId: number, day: string, remove: () => Promise<void>): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock($1,$2)',[SOURCE_LOCK,cameraId]);
    const held = await client.query(`SELECT 1 FROM evidence_clips e,jsonb_array_elements(e.source_plan->'parts') p
      WHERE e.status='preparing' AND (p->>'file' LIKE $1 OR p->>'file' LIKE $2) LIMIT 1`,[`rec/${cameraId}/${day}/%`,`playback/${cameraId}/${day}/%`]);
    if (held.rowCount) { await client.query('COMMIT'); return false; }
    await remove(); await client.query('COMMIT'); return true;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export class EvidenceJobs {
  private timer?: NodeJS.Timeout;
  private working?: Promise<void>;
  private active?: { id: string; abort: AbortController };
  private stopping = false;
  private staging = new Map<string,AbortController>();
  private preparingTask?: Promise<void>;
  private preparing = false;
  private requests = new Map<number,{ at: number; protected: number; preview: number }>();

  async start(): Promise<void> { this.stopping = false; await this.recover(); this.schedule(); }
  private schedule() {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.working = this.tick().catch(() => console.warn('[evidence] export queue temporarily unavailable')).finally(() => { this.working = undefined; this.schedule(); });
    },1000);
    this.timer.unref();
  }
  private rate(user: number, kind: ClipKind) {
    const now = Date.now();
    if (this.requests.size > 1000) for (const [id,value] of this.requests) if (now-value.at > 60_000) this.requests.delete(id);
    let state = this.requests.get(user);
    if (!state || now-state.at > 60_000) { state = { at: now, protected: 0, preview: 0 }; this.requests.set(user,state); }
    if (++state[kind] > (kind === 'preview' ? 30 : 6)) throw new EvidenceError('Đã yêu cầu nhiều clip. Chờ một phút rồi thử lại.',429);
  }
  async create(request: ClipRequest, actor: number, kind: ClipKind = 'protected'): Promise<ClipRow> {
    const window = validateWindow(request.start_at,request.end_at,kind === 'preview');
    if (!validCameraId(request.camera_id) || (request.event_id !== undefined && !validTargetId(request.event_id)) || (request.notice_id !== undefined && !validTargetId(request.notice_id)) || (request.idempotency_key !== undefined && !validUuid(request.idempotency_key)) || (request.title !== undefined && (typeof request.title !== 'string' || request.title.trim().length > 100 || /[\u0000-\u001f]/.test(request.title)))) throw new EvidenceError('Thông tin clip không hợp lệ.');
    const hash = createHash('sha256').update(`${request.camera_id}:${window.start}:${window.end}`).digest('hex');
    const key = kind === 'preview' ? `preview:${hash}` : `protected:${actor}:${request.idempotency_key ?? randomUUID()}`;
    const existing = (await pool.query<ClipRow>('SELECT * FROM evidence_clips WHERE request_key=$1',[key])).rows[0];
    if (existing && (!existing.expires_at || new Date(existing.expires_at).getTime() > Date.now() || ['preparing','processing'].includes(existing.status)) && !(kind==='preview' && ['error','cancelled'].includes(existing.status))) {
      if (kind==='protected' && (existing.camera_id!==request.camera_id || new Date(existing.start_at).getTime()!==window.start || new Date(existing.end_at).getTime()!==window.end)) throw new EvidenceError('Lượt yêu cầu clip này đã dùng cho khoảng khác. Mở một lượt mới.',409);
      return existing;
    }
    this.rate(actor,kind);
    if (this.preparing) throw new EvidenceError('Đang chuẩn bị một clip khác. Thử lại sau vài giây.',409);
    this.preparing = true;
    let row: ClipRow | undefined, handedOff = false;
    try {
      const camera = (await pool.query('SELECT id,name FROM cameras WHERE id=$1',[request.camera_id])).rows[0];
      if (!camera) throw new EvidenceError('Không tìm thấy camera.',404);
      for (const [type,id] of [['event',request.event_id],['notice',request.notice_id]] as const) if (id) {
        const target=await targetRecording(type,id),at=new Date(target.detected_at).getTime();
        if (target.camera_id !== request.camera_id) throw new EvidenceError('Sự kiện không thuộc camera này.');
        if(at<window.start||at>=window.end)throw new EvidenceError('Sự kiện không nằm trong khoảng clip đã chọn.');
      }
      const plan = await recordingPlan(request.camera_id,window.start,window.end);
      const reservation = plan.sourceBytes + Math.ceil(plan.duration*1024*1024 + 32*1024*1024), id = randomUUID();
      const client = await pool.connect();
      try {
        await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock($1)',[QUOTA_LOCK]);
        await client.query('SELECT pg_advisory_xact_lock($1,$2)',[SOURCE_LOCK,request.camera_id]);
        if (existing) {
          await removeJobFiles(existing.id); await client.query('DELETE FROM evidence_clips WHERE id=$1 AND kind=\'preview\'',[existing.id]);
        }
        const count = Number((await client.query('SELECT count(*) AS count FROM evidence_clips WHERE status=ANY($1::text[])',[activeStates])).rows[0].count);
        if (count >= 64) throw new EvidenceError('Hàng đợi clip đã đầy. Chờ các clip hiện tại hoàn tất.',429);
        const quota = await evidenceQuota(existing ? [existing.id] : []);
        if (quota.used_bytes+quota.reserved_bytes+reservation > quota.max_bytes || quota.free_bytes-quota.reserved_bytes-reservation < quota.min_free_bytes) throw new EvidenceError('Không đủ hạn mức hoặc dung lượng trống để giữ clip này. Không tự xóa clip đã bảo vệ.',507);
        row = (await client.query<ClipRow>(`INSERT INTO evidence_clips(id,kind,camera_id,camera_name,title,start_at,end_at,status,reserved_bytes,gaps,source_plan,event_id,notice_id,request_key,created_by,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,'preparing',$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15) RETURNING *`,
          [id,kind,camera.id,camera.name,request.title?.trim() ?? '',new Date(window.start),new Date(window.end),reservation,JSON.stringify(plan.gaps),JSON.stringify(plan),request.event_id ?? null,request.notice_id ?? null,key,actor,kind === 'preview' ? new Date(Date.now()+5*60_000) : null])).rows[0];
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      handedOff = true;
      this.preparingTask = this.stage(row!).catch(() => console.warn('[evidence] source snapshot interrupted')).finally(() => { this.preparing = false; this.preparingTask=undefined; });
      return row!;
    } finally { if (!handedOff) this.preparing = false; }
  }
  private async stage(row: ClipRow): Promise<void> {
    const abort = new AbortController(); this.staging.set(row.id,abort);
    try {
      const directory = jobDirectory(row.id); await privateDirectory(directory);
      for (const part of row.source_plan.parts) {
        if (!/^source-\d{3}\.ts$/.test(part.local)) throw new EvidenceError('Kế hoạch clip không hợp lệ.',409);
        let copied=false;
        try { const file=await safeStorageFile(`protected-clips/${row.id}/${part.local}`);copied=(await fs.stat(file)).size===part.size; }
        catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
        if(!copied){await fs.rm(path.join(directory,part.local),{force:true});await snapshotSource(part.file,path.join(directory,part.local),abort.signal);}
      }
      if(abort.signal.aborted)throw new EvidenceError('Đã hủy tạo clip.',409);
      if(!this.stopping){
        const result=await pool.query(`UPDATE evidence_clips SET status='queued',progress=20,updated_at=now() WHERE id=$1 AND status='preparing'`,[row.id]);
        if(!result.rowCount){await removeJobFiles(row.id);await pool.query(`UPDATE evidence_clips SET reserved_bytes=0 WHERE id=$1 AND status='cancelled'`,[row.id]);}
      }
    } catch (error) {
      if(this.stopping)return;
      await removeJobFiles(row.id).catch(() => undefined);
      await pool.query(`UPDATE evidence_clips SET status=$2,reserved_bytes=0,error=$3,updated_at=now() WHERE id=$1`,
        [row.id,abort.signal.aborted ? 'cancelled' : 'error',abort.signal.aborted ? 'Đã hủy tạo clip.' : error instanceof EvidenceError ? error.message : 'Bản ghi đã bị xóa hoặc không sao chép được. Chưa tạo clip bảo vệ.']);
    } finally { this.staging.delete(row.id); }
  }
  async preview(type: unknown, id: unknown, actor: number): Promise<ClipRow> {
    const event = await targetRecording(type,id), at = new Date(event.detected_at).getTime();
    return this.create({ camera_id: event.camera_id, start_at: new Date(at-4000).toISOString(), end_at: new Date(at+4000).toISOString(),
      ...(type === 'event' ? { event_id: String(id) } : { notice_id: String(id) }) },actor,'preview');
  }
  async cancel(id: string): Promise<void> {
    const row = await clipRow(id);
    if (!row) throw new EvidenceError('Không tìm thấy clip.',404);
    if (!activeStates.includes(row.status)) return;
    await pool.query(`UPDATE evidence_clips SET status='cancelled',error='Đã hủy tạo clip.',updated_at=now() WHERE id=$1 AND status=ANY($2::text[])`,[id,activeStates]);
    this.staging.get(id)?.abort();
    if (this.active?.id === id) this.active.abort.abort();
    else if (!this.staging.has(id)) { await removeJobFiles(id); await pool.query('UPDATE evidence_clips SET reserved_bytes=0 WHERE id=$1',[id]); }
  }
  async delete(id: string): Promise<void> {
    const row = await clipRow(id); if (!row) throw new EvidenceError('Không tìm thấy clip.',404);
    if (activeStates.includes(row.status)) throw new EvidenceError('Hủy tác vụ trước khi xóa clip.',409);
    await removeJobFiles(id); await pool.query('DELETE FROM evidence_clips WHERE id=$1',[id]);
  }
  private async recover(): Promise<void> {
    const client = await pool.connect(); let locked = false;
    try {
      locked = (await client.query('SELECT pg_try_advisory_lock($1) AS locked',[WORKER_LOCK])).rows[0].locked;
      if (!locked) return;
      const { rows } = await client.query<ClipRow>(`SELECT * FROM evidence_clips WHERE status=ANY($1::text[]) OR (status IN ('error','cancelled') AND reserved_bytes>0)`,[activeStates]);
      for (const row of rows) {
        if(['error','cancelled'].includes(row.status)){await removeJobFiles(row.id);await client.query('UPDATE evidence_clips SET reserved_bytes=0 WHERE id=$1',[row.id]);continue;}
        try{
          const file=await safeStorageFile(`protected-clips/${row.id}/clip.mp4`),size=(await fs.stat(file)).size,metadata=await inspectMp4(file);
          if(metadata.duration>=row.source_plan.duration-1&&metadata.duration<=row.source_plan.duration+1.5){
            await client.query(`UPDATE evidence_clips SET status='ready',progress=100,size_bytes=$2,reserved_bytes=0,duration_seconds=$3,error=NULL,updated_at=now() WHERE id=$1`,[row.id,size,metadata.duration]);
            for(const part of row.source_plan.parts)if(/^source-\d{3}\.ts$/.test(part.local))await fs.rm(path.join(jobDirectory(row.id),part.local),{force:true});
            await fs.rm(path.join(jobDirectory(row.id),'input.m3u8'),{force:true});continue;
          }
        }catch{/* Interrupted outputs are rebuilt from the retained snapshots. */}
        if(row.status==='preparing'){
          // The persisted source-day lease protects originals until this copy finishes.
          await this.stage(row);continue;
        }
        let complete = row.source_plan?.parts?.length > 0;
        if (complete) for (const part of row.source_plan.parts) {
          if (!/^source-\d{3}\.ts$/.test(part.local)) { complete = false; break; }
          try { const file = await safeStorageFile(`protected-clips/${row.id}/${part.local}`); if ((await fs.stat(file)).size !== part.size) complete = false; }
          catch { complete = false; }
        }
        await fs.rm(path.join(jobDirectory(row.id),'output.part.mp4'),{ force: true }).catch(() => undefined);
        if (complete) await client.query(`UPDATE evidence_clips SET status='queued',progress=20,updated_at=now() WHERE id=$1`,[row.id]);
        else { await removeJobFiles(row.id).catch(() => undefined); await client.query(`UPDATE evidence_clips SET status='error',reserved_bytes=0,error='Chuẩn bị clip bị gián đoạn; nguồn chưa được giữ đầy đủ.',updated_at=now() WHERE id=$1`,[row.id]); }
      }
    } finally { if (locked) await client.query('SELECT pg_advisory_unlock($1)',[WORKER_LOCK]); client.release(); }
  }
  private async tick(): Promise<void> {
    const client = await pool.connect(); let locked = false;
    try {
      locked = (await client.query('SELECT pg_try_advisory_lock($1) AS locked',[WORKER_LOCK])).rows[0].locked;
      if (!locked || this.stopping) return;
      // Only expiring preview jobs are cleaned automatically; protected clips never are.
      const expired = (await client.query<ClipRow>(`SELECT * FROM evidence_clips WHERE kind='preview' AND expires_at<now() AND status NOT IN ('preparing','processing') LIMIT 32`)).rows;
      for (const row of expired) { await removeJobFiles(row.id); await client.query('DELETE FROM evidence_clips WHERE id=$1',[row.id]); }
      const row = (await client.query<ClipRow>(`UPDATE evidence_clips SET status='processing',updated_at=now() WHERE id=(SELECT id FROM evidence_clips WHERE status='queued' ORDER BY CASE kind WHEN 'protected' THEN 0 ELSE 1 END,created_at LIMIT 1) AND status='queued' RETURNING *`)).rows[0];
      if (!row) return;
      const abort = new AbortController(); this.active = { id: row.id, abort }; let lastUpdate = 0;
      try {
        const result = await renderClip(row.source_plan,jobDirectory(row.id),row.kind === 'preview',evidenceLimits(),abort.signal,progress => {
          if (Date.now()-lastUpdate < 1500) return; lastUpdate = Date.now();
          void pool.query(`UPDATE evidence_clips SET progress=$2,updated_at=now() WHERE id=$1 AND status='processing'`,[row.id,Math.floor(progress)]).catch(() => undefined);
        });
        for (const part of row.source_plan.parts) await fs.rm(path.join(jobDirectory(row.id),part.local),{ force: true });
        await fs.rm(path.join(jobDirectory(row.id),'input.m3u8'),{ force: true });
        const updated = await client.query(`UPDATE evidence_clips SET status='ready',progress=100,size_bytes=$2,reserved_bytes=0,duration_seconds=$3,error=NULL,expires_at=CASE WHEN kind='preview' THEN now()+interval '5 minutes' ELSE expires_at END,updated_at=now() WHERE id=$1 AND status='processing'`,[row.id,result.size,result.duration]);
        if (!updated.rowCount) { await removeJobFiles(row.id); await client.query('UPDATE evidence_clips SET reserved_bytes=0 WHERE id=$1',[row.id]); }
      } catch (error) {
        if (this.stopping) await client.query(`UPDATE evidence_clips SET status='queued',progress=20,updated_at=now() WHERE id=$1 AND status='processing'`,[row.id]);
        else {
          await removeJobFiles(row.id).catch(() => undefined);
          await client.query(`UPDATE evidence_clips SET status=CASE WHEN status='cancelled' THEN status ELSE 'error' END,reserved_bytes=0,error=CASE WHEN status='cancelled' THEN error ELSE $2 END,updated_at=now() WHERE id=$1`,[row.id,error instanceof EvidenceError ? error.message : 'Không tạo được clip từ bản ghi local.']);
        }
      } finally { this.active = undefined; }
    } finally { if (locked) await client.query('SELECT pg_advisory_unlock($1)',[WORKER_LOCK]); client.release(); }
  }
  async close(): Promise<void> {
    this.stopping = true; if (this.timer) clearTimeout(this.timer);
    this.active?.abort.abort(); for (const abort of this.staging.values()) abort.abort();
    await Promise.all([this.working,this.preparingTask]);
  }
}
export const evidenceJobs = new EvidenceJobs();
export async function startEvidenceJobs(): Promise<EvidenceJobs> { await evidenceJobs.start(); return evidenceJobs; }
export { setEvidenceLimits } from './limits';
export { publicClip };
