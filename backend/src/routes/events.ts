import { Router } from 'express';
import { pool } from '../db';
import { requireAuth } from '../middleware/auth';
import { readLiveDetections } from '../detections/live';
import { eventThumbnails, EventImageMissing, EventThumbnailBusy } from '../detections/thumbnails';

import { identityMetadata, identityPeople } from '../identities';

const router = Router();
router.use(requireAuth);

// Read-only, authenticated metadata; hidden worker files are never web-served.
router.get('/live', async (req, res) => {
  const raw = req.query.camera_ids;
  if (typeof raw !== 'string' || !/^\d+(,\d+){0,15}$/.test(raw)) { res.status(400).json({ error: 'Chọn từ 1 đến 16 camera.' }); return; }
  const ids = raw.split(',').map(Number);
  if (new Set(ids).size !== ids.length || ids.some(id => !Number.isSafeInteger(id) || id < 1 || id > 2147483647)) { res.status(400).json({ error: 'Camera không hợp lệ.' }); return; }
  try {
    const { rows } = await pool.query('SELECT id, status, enabled, ai_enabled, ai_fps, ai_overlay_enabled, ai_overlay_labels, ai_identity_enabled, ai_surveillance FROM cameras WHERE id = ANY($1::int[]) ORDER BY id', [ids]);
    const people = await identityPeople();
    res.json(await Promise.all(rows.map(camera => readLiveDetections(camera, people))));
  } catch { res.status(503).json({ error: 'Chưa đọc được kết quả nhận dạng.' }); }
});

/** Thumbnail riêng cho danh sách; giữ nguyên ảnh gốc. */
router.get('/:id/thumbnail', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1 || !/^[1-9]\d*$/.test(req.params.id)) { res.status(400).json({ error: 'Sự kiện không hợp lệ.' }); return; }
  try {
    const { rows } = await pool.query('SELECT snapshot_path FROM detection_events WHERE id = $1', [id]);
    if (!rows[0]?.snapshot_path) { res.sendStatus(404); return; }
    const file = await eventThumbnails.get(rows[0].snapshot_path);
    res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    res.type('jpg').sendFile(file, error => { if (error && !res.headersSent) res.sendStatus(404); });
  } catch (error) {
    if (error instanceof EventImageMissing) { res.sendStatus(404); return; }
    if (error instanceof EventThumbnailBusy) { res.set('Retry-After', '2').sendStatus(503); return; }
    res.status(502).json({ error: 'Chưa tạo được ảnh xem trước.' });
  }
});

/** Sự kiện nhận dạng, có thể lọc theo camera và khoảng thời gian ISO. */
router.get('/', async (req, res) => {
  const cameraId = req.query.cameraId ? Number(req.query.cameraId) : undefined;
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  const label = typeof req.query.label === 'string' ? req.query.label : undefined;
  const requestedLimit = Number(req.query.limit ?? 100);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.floor(requestedLimit), 1), 500)
    : 100;

  if ((cameraId !== undefined && (!Number.isInteger(cameraId) || cameraId <= 0)) ||
    (from && Number.isNaN(Date.parse(from))) || (to && Number.isNaN(Date.parse(to)))) {
    res.status(400).json({ error: 'invalid event filters' });
    return;
  }

  const where: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    where.push(sql.replace('?', `$${values.length}`));
  };
  if (cameraId !== undefined) add('e.camera_id = ?', cameraId);
  if (from) add('e.detected_at >= ?', from);
  if (to) add('e.detected_at <= ?', to);
  if (label) add('e.label = ?', label);
  values.push(limit);

  const { rows } = await pool.query(
    `SELECT e.id, e.camera_id, c.name AS camera_name, e.detected_at, e.label,
            e.confidence, e.snapshot_path, e.source, e.metadata
     FROM detection_events e
     JOIN cameras c ON c.id = e.camera_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY e.detected_at DESC
     LIMIT $${values.length}`,
    values,
  );
  const people = await identityPeople();
  res.json(rows.map((row) => ({
    ...row,
    metadata: identityMetadata(row.metadata, people),
    snapshot_url: row.snapshot_path ? `/${row.snapshot_path}` : null,
    thumbnail_url: row.snapshot_path ? `/api/events/${row.id}/thumbnail` : null,
  })));
});

export default router;
