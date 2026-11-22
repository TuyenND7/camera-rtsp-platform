import { Router } from 'express';
import fs from 'fs';
import { pool } from '../db';
import { AuthedRequest, requireAdmin, requireAuth } from '../middleware/auth';
import { EvidenceError, publicClip, validUuid, validCameraId } from '../evidence/types';
import { clipRow, evidenceJobs, evidenceQuota, ClipRequest } from '../evidence/jobs';
import { safeStorageFile } from '../evidence/paths';
import { activityGroups, reviews, reviewType, reviewBody, saveReview } from '../evidence/reviews';

const router = Router(); router.use(requireAuth);
function fail(res: any,error: unknown) { res.status(error instanceof EvidenceError ? error.status : 503).json({ error: error instanceof EvidenceError ? error.message : 'Kho clip hoặc đánh giá chưa sẵn sàng. Thử lại sau.' }); }
router.get('/clips',async (req,res) => {
  try {
    if(req.query.before!==undefined&&!validUuid(req.query.before))throw new EvidenceError('Mốc phân trang clip không hợp lệ.');
    const { rows } = await pool.query(`SELECT * FROM evidence_clips WHERE kind='protected'
      AND ($1::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM evidence_clips WHERE id=$1))
      ORDER BY created_at DESC,id DESC LIMIT 51`,[req.query.before ?? null]);
    res.json({ items: rows.slice(0,50).map(publicClip),next_before: rows.length>50?rows[49].id:null,quota: await evidenceQuota() });
  } catch (error) { fail(res,error); }
});
router.post('/clips',requireAdmin,async (req: AuthedRequest,res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Object.keys(body).some(key => !['camera_id','start_at','end_at','title','event_id','notice_id','idempotency_key'].includes(key))) throw new EvidenceError('Thông tin clip không hợp lệ.');
    res.status(202).json(publicClip(await evidenceJobs.create(body as ClipRequest,req.user!.sub)));
  } catch (error) { fail(res,error); }
});
router.post('/preview',async (req: AuthedRequest,res) => {
  try {
    const body = req.body;
    if (!body || Object.keys(body).some(key => !['target_type','target_id'].includes(key))) throw new EvidenceError('Sự kiện không hợp lệ.');
    res.status(202).json(publicClip(await evidenceJobs.preview(body.target_type,body.target_id,req.user!.sub)));
  } catch (error) { fail(res,error); }
});
router.get('/clips/:id',async (req,res) => {
  try {
    const row = await clipRow(req.params.id); if (!row) throw new EvidenceError('Không tìm thấy clip.',404);
    if (row.kind === 'preview' && !['preparing','processing'].includes(row.status) && row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) throw new EvidenceError('Bản xem trước đã hết hạn. Nhấn xem lại để tạo mới.',410);
    res.json(publicClip(row));
  } catch (error) { fail(res,error); }
});
router.post('/clips/:id/cancel',requireAdmin,async (req,res) => {
  try { await evidenceJobs.cancel(req.params.id); res.json({ ok: true }); } catch (error) { fail(res,error); }
});
router.delete('/clips/:id',requireAdmin,async (req,res) => {
  try { if (req.body?.confirm !== true) throw new EvidenceError('Xác nhận xóa clip trước khi thực hiện.'); await evidenceJobs.delete(req.params.id); res.json({ ok: true }); } catch (error) { fail(res,error); }
});

export function byteRange(value: string | undefined,size: number): { start: number; end: number } | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new EvidenceError('Khoảng tải clip không hợp lệ.',416);
  const suffix = !match[1], a = suffix ? Math.max(0,size-Number(match[2])) : Number(match[1]);
  const b = suffix || !match[2] ? size-1 : Math.min(size-1,Number(match[2]));
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || a >= size || b < a || (suffix && Number(match[2]) <= 0)) throw new EvidenceError('Khoảng tải clip không hợp lệ.',416);
  return { start: a,end: b };
}
router.get('/clips/:id/download',async (req,res) => {
  let handle: fs.promises.FileHandle | undefined;
  try {
    const row = await clipRow(req.params.id);
    if (!row || row.status !== 'ready') throw new EvidenceError('Clip chưa sẵn sàng tải.',404);
    if (row.kind === 'preview' && row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) throw new EvidenceError('Bản xem trước đã hết hạn.',410);
    const file = await safeStorageFile(`protected-clips/${row.id}/clip.mp4`);
    handle = await fs.promises.open(file,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size !== Number(row.size_bytes)) throw new EvidenceError('File clip không khớp dữ liệu đã giữ.',409);
    const etag = `"clip-${row.id}-${info.size}"`;
    let range: ReturnType<typeof byteRange>;
    try { range = byteRange(req.get('If-Range') && req.get('If-Range') !== etag ? undefined : req.get('Range'),info.size); }
    catch (error) { res.set('Content-Range',`bytes */${info.size}`); throw error; }
    const filename = `camera-${row.camera_id ?? 'clip'}-${new Date(row.start_at).toISOString().replace(/[-:]/g,'').slice(0,15)}.mp4`;
    res.status(range ? 206 : 200).set({ 'Accept-Ranges': 'bytes','Content-Type': 'video/mp4','X-Content-Type-Options': 'nosniff',
      'Content-Length': String(range ? range.end-range.start+1 : info.size),ETag: etag,
      'Content-Disposition': `${row.kind === 'preview' || req.query.inline === '1' ? 'inline' : 'attachment'}; filename="${filename}"`,
      ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${info.size}` } : {}) });
    if (req.method === 'HEAD') { await handle.close(); handle = undefined; res.end(); return; }
    const stream = handle.createReadStream({ start: range?.start ?? 0,end: range?.end ?? info.size-1,autoClose: true }); handle = undefined;
    stream.on('error',() => res.destroy()); res.on('close',() => stream.destroy()); stream.pipe(res);
  } catch (error) { await handle?.close().catch(() => undefined); if (!res.headersSent) fail(res,error); else res.destroy(); }
});
router.get('/reviews',async (req,res) => {
  try { if (typeof req.query.ids !== 'string') throw new EvidenceError('Danh sách sự kiện không hợp lệ.'); res.json(await reviews(reviewType(req.query.target_type),req.query.ids.split(','))); } catch (error) { fail(res,error); }
});
router.put('/reviews/:type/:id',requireAdmin,async (req: AuthedRequest,res) => {
  try { res.json(await saveReview(reviewType(req.params.type),req.params.id,reviewBody(req.body),req.user!.sub)); } catch (error) { fail(res,error); }
});
router.get('/activities',async (req,res) => {
  try {
    if (req.query.camera_id !== undefined && !validCameraId(Number(req.query.camera_id))) throw new EvidenceError('Camera không hợp lệ.');
    res.json(await activityGroups({ camera_id: req.query.camera_id === undefined ? undefined : Number(req.query.camera_id),
      from: typeof req.query.from === 'string' ? req.query.from : new Date(Date.now()-86400_000).toISOString(),to: typeof req.query.to === 'string' ? req.query.to : new Date().toISOString(),
      window_seconds: Number(req.query.window_seconds ?? 60),limit: Number(req.query.limit ?? 50) }));
  } catch (error) { fail(res,error); }
});
export default router;
