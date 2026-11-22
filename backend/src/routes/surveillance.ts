import { Router } from 'express';
import { randomUUID } from 'crypto';
import { pool } from '../db';
import { AuthedRequest, requireAuth, requireAdmin } from '../middleware/auth';
import { identityPeople } from '../identities';
import { readLiveDetections } from '../detections/live';
import { publicNotice, publicPin, surveillanceConfig, validSurveillanceConfig } from '../detections/surveillance';
import { eventThumbnails, EventImageMissing, EventThumbnailBusy } from '../detections/thumbnails';

const positive = (v: unknown): v is string => typeof v === 'string' && /^[1-9]\d{0,15}$/.test(v) && Number.isSafeInteger(Number(v));
const cameraId = (v: unknown) => positive(v) && Number(v) <= 2147483647 ? Number(v) : null;
const kindSet = new Set(['intrusion','loitering','pacing','unfamiliar','camera_offline','video_stalled','recording_stopped','storage_error','resource_overload']);
export const cameraSurveillanceRouter = Router({ mergeParams: true });
cameraSurveillanceRouter.use(requireAuth, requireAdmin);
cameraSurveillanceRouter.get('/', async (req: AuthedRequest, res) => {
  const id = cameraId(req.params.id);
  if (!id) { res.sendStatus(400); return; }
  try {
    const { rows } = await pool.query('SELECT ai_surveillance FROM cameras WHERE id = $1', [id]);
    if (!rows[0]) { res.sendStatus(404); return; }
    res.json(surveillanceConfig(rows[0].ai_surveillance));
  } catch { res.status(503).json({ error: 'Chưa đọc được cấu hình theo dõi.' }); }
});
cameraSurveillanceRouter.put('/', async (req: AuthedRequest, res) => {
  const id = cameraId(req.params.id);
  if (!id || !validSurveillanceConfig(req.body)) { res.status(400).json({ error: 'Vùng nhận dạng hoặc tùy chọn theo dõi không hợp lệ.' }); return; }
  try {
    const value = { ...req.body, zones: req.body.zones.map((z: any) => ({ id: z.id, name: z.name.trim(), points: z.points })) };
    const { rows } = await pool.query('UPDATE cameras SET ai_surveillance = $1::jsonb, updated_at = now() WHERE id = $2 RETURNING ai_surveillance', [JSON.stringify(value), id]);
    if (!rows[0]) { res.sendStatus(404); return; }
    // No RTSP restart or hardware controls: worker hot-loads the new policy.
    res.json(surveillanceConfig(rows[0].ai_surveillance));
  } catch { res.status(503).json({ error: 'Chưa lưu được cấu hình theo dõi.' }); }
});

const router = Router();
router.use(requireAuth);
router.get('/notifications', async (req: AuthedRequest, res) => {
  const { before, after, unread, kind } = req.query;
  const limit = Number(req.query.limit ?? 50);
  if ((before !== undefined && !positive(before)) || (after !== undefined && !positive(after)) || (before && after) ||
    (unread !== undefined && !['true','false'].includes(String(unread))) || (kind !== undefined && !kindSet.has(String(kind))) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    res.status(400).json({ error: 'Bộ lọc thông báo không hợp lệ.' }); return;
  }
  try {
    const values: unknown[] = [req.user!.sub]; const where: string[] = [];
    if (before) { values.push(before); where.push(`n.id < $${values.length}`); }
    if (after) { values.push(after); where.push(`n.id > $${values.length}`); }
    if (unread === 'true') where.push('r.notification_id IS NULL');
    if (kind) { values.push(kind); where.push(`n.kind = $${values.length}`); }
    values.push(limit);
    const [list, counts, people] = await Promise.all([
      pool.query(`SELECT n.*, c.name AS camera_name, c.ai_surveillance, (r.notification_id IS NOT NULL) AS read
        FROM surveillance_notifications n JOIN cameras c ON c.id = n.camera_id
        LEFT JOIN surveillance_notification_reads r ON r.notification_id = n.id AND r.user_id = $1
        ${where.length ? 'WHERE '+where.join(' AND ') : ''} ORDER BY n.id ${after ? 'ASC' : 'DESC'} LIMIT $${values.length}`, values),
      pool.query(`SELECT count(*) FILTER (WHERE r.notification_id IS NULL)::int AS unread_count, COALESCE(max(n.id),0)::text AS latest_id
        FROM surveillance_notifications n LEFT JOIN surveillance_notification_reads r ON r.notification_id = n.id AND r.user_id = $1`, [req.user!.sub]),
      identityPeople(),
    ]);
    // ASC when after=cursor prevents losing the middle of a burst larger than limit.
    res.json({ items: list.rows.map(row => publicNotice(row, people)), ...counts.rows[0] });
  } catch { res.status(503).json({ error: 'Chưa tải được thông báo.' }); }
});
router.post('/notifications/read', async (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  if (Object.keys(body).some(k => !['ids','all'].includes(k)) || (body.all !== undefined && body.all !== true) ||
    (body.all !== true && (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 100 || !body.ids.every(positive))) ||
    (body.all === true && body.ids !== undefined)) { res.status(400).json({ error: 'Chọn thông báo cần đánh dấu.' }); return; }
  try {
    await pool.query(`INSERT INTO surveillance_notification_reads (notification_id, user_id)
      SELECT id, $1 FROM surveillance_notifications ${body.all === true ? '' : 'WHERE id = ANY($2::bigint[])'} ON CONFLICT DO NOTHING`,
      body.all === true ? [req.user!.sub] : [req.user!.sub, body.ids]);
    res.json({ ok: true });
  } catch { res.status(503).json({ error: 'Chưa đánh dấu được thông báo.' }); }
});
router.get('/notifications/:id/thumbnail', async (req, res) => {
  if (!positive(req.params.id)) { res.sendStatus(400); return; }
  try {
    const { rows } = await pool.query('SELECT snapshot_path FROM surveillance_notifications WHERE id = $1', [req.params.id]);
    if (!rows[0]?.snapshot_path) { res.sendStatus(404); return; }
    const file = await eventThumbnails.get(rows[0].snapshot_path);
    res.type('jpg').sendFile(file, err => { if (err && !res.headersSent) res.sendStatus(404); });
  } catch (err) {
    if (err instanceof EventImageMissing) { res.sendStatus(404); return; }
    if (err instanceof EventThumbnailBusy) { res.set('Retry-After', '2').sendStatus(503); return; }
    res.sendStatus(503);
  }
});

const pinQuery = `SELECT p.*, c.name AS camera_name, c.status, c.enabled, c.ai_enabled,
  e.id AS event_id, e.snapshot_path FROM surveillance_pins p JOIN cameras c ON c.id = p.camera_id
  LEFT JOIN LATERAL (SELECT id,snapshot_path FROM detection_events WHERE camera_id = p.camera_id AND metadata->>'track_id' = p.track_id LIMIT 1) e ON true`;
router.get('/pins', async (_req, res) => {
  try {
    const [{ rows }, people] = await Promise.all([pool.query(`${pinQuery} WHERE p.active ORDER BY p.created_at DESC LIMIT 64`), identityPeople()]);
    res.json(rows.map(row => publicPin(row, people)));
  } catch { res.status(503).json({ error: 'Chưa tải được đối tượng đã ghim.' }); }
});
router.post('/pins', requireAdmin, async (req: AuthedRequest, res) => {
  const b = req.body ?? {}, id = cameraId(String(b.camera_id));
  if (!id || typeof b.camera_id !== 'number' || typeof b.track_id !== 'string' || !Number.isInteger(b.track_number) || b.track_number < 1 || b.track_number > 2147483647 ||
    !new RegExp(`^c${id}-[a-f0-9]{12}-${b.track_number}$`).test(b.track_id) || Object.keys(b).some(k => !['camera_id','track_id','track_number','label'].includes(k))) {
    res.status(400).json({ error: 'Đối tượng không hợp lệ.' }); return;
  }
  try {
    const { rows } = await pool.query('SELECT id,status,enabled,ai_enabled,ai_fps,ai_identity_enabled,ai_surveillance FROM cameras WHERE id = $1', [id]);
    const camera = rows[0];
    if (!camera) { res.sendStatus(404); return; }
    if (!surveillanceConfig(camera.ai_surveillance).manual_pin_enabled) { res.status(409).json({ error: 'Camera đang tắt ghim thủ công.' }); return; }
    const people = await identityPeople();
    const live = await readLiveDetections(camera, people);
    const frame = [...live.frames].reverse().find(f => f.at >= Date.now()-20000 && f.detections.some(d => d.track_id === b.track_id));
    const detection = frame?.detections.find(d => d.track_id === b.track_id && d.label === b.label);
    if (!frame || !detection) { res.status(409).json({ error: 'Đối tượng không còn trong hình. Chọn khung mới nhất.' }); return; }
    const identity = detection.identity ? { state: detection.identity.state, person_id: detection.identity.person_id } : null;
    const client = await pool.connect();
    let pinId;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(731923, 2)');
      const count = await client.query('SELECT count(*)::int AS count FROM surveillance_pins WHERE active');
      const current = await client.query('SELECT id,active FROM surveillance_pins WHERE camera_id=$1 AND track_id=$2', [id,b.track_id]);
      if (count.rows[0].count >= 64 && !current.rows[0]?.active) {
        await client.query('ROLLBACK'); res.status(409).json({ error: 'Đã ghim 64 đối tượng. Bỏ ghim bớt để thêm.' }); return;
      }
      const saved = await client.query(`INSERT INTO surveillance_pins (id,camera_id,track_id,track_number,label,last_seen_at,identity,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT (camera_id,track_id)
        DO UPDATE SET active=true,automatic=false,last_seen_at=EXCLUDED.last_seen_at,identity=EXCLUDED.identity RETURNING id`,
        [randomUUID(),id,b.track_id,b.track_number,b.label,new Date(frame.at),JSON.stringify(identity),req.user!.sub]);
      pinId = saved.rows[0].id;
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
    const saved = await pool.query(`${pinQuery} WHERE p.id = $1`, [pinId]);
    res.json(publicPin(saved.rows[0], people));
  } catch { res.status(503).json({ error: 'Chưa ghim được đối tượng.' }); }
});
router.delete('/pins/:id', requireAdmin, async (req, res) => {
  if (!/^[a-f0-9-]{36}$/.test(req.params.id)) { res.sendStatus(400); return; }
  try {
    await pool.query('UPDATE surveillance_pins SET active=false WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(503).json({ error: 'Chưa bỏ ghim được đối tượng.' }); }
});
export default router;
