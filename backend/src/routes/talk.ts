import { Router, raw } from 'express';
import { pool } from '../db';
import { AuthedRequest, requireAdmin, requireAuth } from '../middleware/auth';
import { sessionUser, tokenHash } from '../sessions';
import { TalkCamera, talkManager } from '../talk/manager';
import { TalkError } from '../talk/rtsp';

const router = Router();
router.use(requireAuth, requireAdmin);

function ids(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16 || value.some(v => !Number.isSafeInteger(v) || v < 1 || v > 2147483647) || new Set(value).size !== value.length) throw new TalkError(400, 'Chọn từ 1 đến 16 camera khác nhau.');
  return value;
}

async function cameras(cameraIds: number[]) {
  const { rows } = await pool.query<TalkCamera & { enabled: boolean; status: string }>('SELECT id, rtsp_url, enabled, status FROM cameras WHERE id = ANY($1::int[]) ORDER BY id', [cameraIds]);
  if (rows.length !== cameraIds.length) throw new TalkError(404, 'Không tìm thấy camera đã chọn.');
  return rows;
}

const errorResponse = (error: unknown) => error instanceof TalkError ? error : new TalkError(503, 'Máy chủ chưa xử lý được đàm thoại.');

router.post('/capabilities', async (req, res) => {
  try {
    const rows = await cameras(ids(req.body?.camera_ids));
    const items = await Promise.all(rows.map(c => !c.enabled || c.status !== 'online'
      ? { camera_id: c.id, supported: false, reason: 'Camera chưa trực tuyến.' }
      : talkManager.probe(c)));
    res.json(items);
  } catch (error) { const e = errorResponse(error); res.status(e.status).json({ error: e.message }); }
});

router.post('/sessions', async (req: AuthedRequest, res) => {
  try {
    if (!req.secure) throw new TalkError(426, 'Mở web bằng HTTPS để sử dụng mic.');
    const rows = await cameras(ids(req.body?.camera_ids));
    if (rows.some(c => !c.enabled || c.status !== 'online')) throw new TalkError(409, 'Một camera đã chọn chưa trực tuyến.');
    const token = req.sessionToken!;
    const result = await talkManager.start(tokenHash(token), rows, async () => {
      const user = await sessionUser(token);
      if (user?.role !== 'admin') return false;
      const current = await cameras(rows.map(c => c.id));
      return current.every(c => c.enabled && c.status === 'online' && rows.some(original => original.id === c.id && original.rtsp_url === c.rtsp_url));
    });
    if (res.destroyed) { talkManager.end(result.id, tokenHash(token)); return; }
    res.status(201).json(result);
  } catch (error) { const e = errorResponse(error); if (!res.destroyed) res.status(e.status).json({ error: e.message }); }
});

router.post('/sessions/:id/audio', raw({ type: 'application/octet-stream', limit: '6400b' }), (req: AuthedRequest, res) => {
  try {
    if (!req.secure) throw new TalkError(426, 'Mở web bằng HTTPS để sử dụng mic.');
    const sequence = req.get('X-Audio-Sequence');
    if (!sequence || !/^\d{1,8}$/.test(sequence)) throw new TalkError(400, 'Thiếu số thứ tự gói audio.');
    talkManager.push(req.params.id, tokenHash(req.sessionToken!), Number(sequence), req.body);
    res.status(204).end();
  } catch (error) { const e = errorResponse(error); res.status(e.status).json({ error: e.message }); }
});

router.delete('/sessions/:id', (req: AuthedRequest, res) => {
  try { talkManager.end(req.params.id, tokenHash(req.sessionToken!)); res.status(204).end(); }
  catch (error) { const e = errorResponse(error); res.status(e.status).json({ error: e.message }); }
});

export default router;
