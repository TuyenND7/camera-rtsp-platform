import { Router, raw } from 'express';
import { pool } from '../db';
import { AuthedRequest, requireAdmin, requireAuth } from '../middleware/auth';
import { sessionUser, tokenHash } from '../sessions';
import { TalkCamera, talkManager } from '../talk/manager';
import { TalkError } from '../talk/rtsp';
import { deviceControls } from '../controls/tenda';

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
    if (req.body?.duplex !== undefined && typeof req.body.duplex !== 'boolean') throw new TalkError(400, 'Chế độ đàm thoại không hợp lệ.');
    const rows = await cameras(ids(req.body?.camera_ids));
    if (rows.some(c => !c.enabled || c.status !== 'online')) throw new TalkError(409, 'Một camera đã chọn chưa trực tuyến.');
    if (rows.some(c => deviceControls.alarmActive(c))) throw new TalkError(409, 'Camera đang phát còi cảnh báo. Dừng còi trước khi dùng mic.');
    const token = req.sessionToken!;
    const result = await talkManager.start(tokenHash(token), rows, async () => {
      const user = await sessionUser(token);
      if (user?.role !== 'admin') return false;
      const current = await cameras(rows.map(c => c.id));
      return current.every(c => c.enabled && c.status === 'online' && rows.some(original => original.id === c.id && original.rtsp_url === c.rtsp_url));
    }, req.body?.duplex === true);
    if (res.destroyed) { talkManager.end(result.id, tokenHash(token)); return; }
    res.status(201).json(result);
  } catch (error) { const e = errorResponse(error); if (!res.destroyed) res.status(e.status).json({ error: e.message }); }
});

const listeners = new Set<string>();
router.get('/sessions/:id/listen/:cameraId', (req: AuthedRequest, res) => {
  const owner = tokenHash(req.sessionToken!), id = req.params.id, cameraId = Number(req.params.cameraId), key = `${id}:${cameraId}`;
  try {
    if (!req.secure) throw new TalkError(426, 'Mở web bằng HTTPS để nghe đàm thoại.');
    if (!Number.isSafeInteger(cameraId) || cameraId < 1) throw new TalkError(400, 'Camera không hợp lệ.');
    const first = talkManager.readAudio(id, owner, cameraId);
    if (listeners.has(key)) throw new TalkError(409, 'Kênh nghe đã được mở.');
    listeners.add(key);
    res.set({ 'Content-Type': 'application/octet-stream', 'X-Audio-Format': 'pcm_s16le', 'X-Audio-Sample-Rate': '8000', 'X-Accel-Buffering': 'no', 'Cache-Control': 'private, no-store' });
    res.flushHeaders();
    let closed = false;
    const cleanup = () => { if (closed) return; closed = true; clearInterval(timer); listeners.delete(key); try { talkManager.end(id, owner); } catch {} };
    const write = (pcm: Buffer) => {
      if (pcm.length && !res.write(pcm) && res.writableLength > 6400) { cleanup(); res.end(); }
    };
    const timer = setInterval(() => {
      try { write(talkManager.readAudio(id, owner, cameraId)); }
      catch { cleanup(); res.end(); }
    }, 20); timer.unref();
    res.on('close', cleanup); res.on('error', cleanup); write(first);
  } catch (error) { const e = errorResponse(error); if (!res.headersSent) res.status(e.status).json({ error: e.message }); }
});

router.post('/sessions/:id/audio', raw({ type: 'application/octet-stream', limit: '6400b' }), (req: AuthedRequest, res) => {
  try {
    if (!req.secure) throw new TalkError(426, 'Mở web bằng HTTPS để sử dụng mic.');
    const sequence = req.get('X-Audio-Sequence');
    if (!sequence || !/^\d{1,8}$/.test(sequence)) throw new TalkError(400, 'Thiếu số thứ tự gói audio.');
    const volume = req.get('X-Camera-Talk-Gains');
    let gains: unknown;
    if (volume !== undefined) {
      if (volume.length > 1024) throw new TalkError(400, 'Mức giọng nói không hợp lệ.');
      try { gains = JSON.parse(volume); } catch { throw new TalkError(400, 'Mức giọng nói không hợp lệ.'); }
    }
    talkManager.push(req.params.id, tokenHash(req.sessionToken!), Number(sequence), req.body, gains);
    res.status(204).end();
  } catch (error) { const e = errorResponse(error); res.status(e.status).json({ error: e.message }); }
});

router.delete('/sessions/:id', (req: AuthedRequest, res) => {
  try { talkManager.end(req.params.id, tokenHash(req.sessionToken!)); res.status(204).end(); }
  catch (error) { const e = errorResponse(error); res.status(e.status).json({ error: e.message }); }
});

export default router;
