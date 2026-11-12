import { Router } from 'express';
import { pool } from '../db';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { streamManager, CameraRow } from '../stream/manager';
import { probeOnvif, safeOnvifError, validateOnvifInput } from '../onvif';
import { invalidatePtz } from '../ptz';
import { talkManager } from '../talk/manager';
import { rediscoverCamera } from '../discovery';
import { deviceDiscovery, discoveryNetworks, KnownCamera, normalizeDiscoverySubnet } from '../deviceDiscovery';

const router = Router();
router.use(requireAuth, requireAdmin);

// Discovery never saves a camera or interrupts an existing RTSP worker.
router.get('/discovery/options', async (req, res) => {
  try {
    const { rows } = await pool.query<KnownCamera>('SELECT id, name, rtsp_url, onvif_url FROM cameras ORDER BY id');
    const subnets = discoveryNetworks(req.hostname, rows);
    res.json({ subnets, default_subnet: subnets[0] ?? '' });
  } catch { res.status(503).json({ error: 'Không đọc được danh sách thiết bị trên máy chủ.' }); }
});

router.post('/discovery', async (req, res) => {
  const subnet = normalizeDiscoverySubnet(req.body?.subnet);
  if (!subnet) { res.status(400).json({ error: 'Nhập một dải mạng nội bộ /24, ví dụ 192.168.0.0/24.' }); return; }
  try {
    const { rows } = await pool.query<KnownCamera>('SELECT id, name, rtsp_url, onvif_url FROM cameras ORDER BY id');
    try { res.status(202).json(deviceDiscovery.start(subnet, rows)); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : 'Không thể bắt đầu dò mạng.' }); }
  } catch { res.status(503).json({ error: 'Không đọc được danh sách thiết bị trên máy chủ.' }); }
});

router.get('/discovery/:scanId', (req, res) => {
  const state = deviceDiscovery.get(req.params.scanId);
  if (!state) { res.status(404).json({ error: 'Lượt dò đã hết hạn. Vui lòng dò lại.' }); return; }
  res.json(state);
});

router.delete('/discovery/:scanId', (req, res) => {
  const state = deviceDiscovery.cancel(req.params.scanId);
  if (!state) { res.status(404).json({ error: 'Không tìm thấy lượt dò.' }); return; }
  res.json(state);
});

// Dò ONVIF Profile S/T để web tự điền main/sub-stream. Không lưu credential ONVIF.
router.post('/onvif/probe', async (req, res) => {
  const input = validateOnvifInput(req.body);
  if (!input) {
    res.status(400).json({ error: 'url, username and password are required; URL must be http(s)' });
    return;
  }
  try {
    res.json(await probeOnvif(input));
  } catch (error) {
    res.status(422).json({ error: `Không thể dò ONVIF: ${safeOnvifError(error, input.password)}` });
  }
});

// Danh sách camera
router.get('/', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, rtsp_url, enabled, record, codec, ai_enabled, ai_rtsp_url,
            ai_fps, ai_confidence, ai_labels, onvif_url, status, last_error, updated_at
     FROM cameras ORDER BY id`
  );
  res.json(rows);
});

// Chi tiết 1 camera
router.get('/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM cameras WHERE id = $1', [
    req.params.id,
  ]);
  if (!rows[0]) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(rows[0]);
});

// Thêm camera
router.post('/', async (req, res) => {
  const {
    name,
    rtsp_url,
    enabled = true,
    record = true,
    codec = 'auto',
    ai_enabled = false,
    ai_rtsp_url = null,
    ai_fps = 2,
    ai_confidence = 0.5,
    ai_labels = ['person', 'car', 'motorcycle'],
    onvif_url = null,
  } = req.body ?? {};
  if (!name || !rtsp_url) {
    res.status(400).json({ error: 'name and rtsp_url required' });
    return;
  }
  if (!isOnvifUrlValid(onvif_url)) {
    res.status(400).json({ error: 'onvif_url phải là URL http(s) không chứa tài khoản' });
    return;
  }
  if (!['auto', 'h264', 'h265'].includes(codec)) {
    res.status(400).json({ error: 'codec must be auto|h264|h265' });
    return;
  }
  if (!isAiSettingsValid(ai_fps, ai_confidence, ai_labels)) {
    res.status(400).json({ error: 'ai_fps must be 0.1..10, ai_confidence 0..1, ai_labels must be a string array' });
    return;
  }
  const { rows } = await pool.query<CameraRow>(
    `INSERT INTO cameras (
       name, rtsp_url, enabled, record, codec, ai_enabled, ai_rtsp_url, ai_fps, ai_confidence, ai_labels, onvif_url
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [name, rtsp_url, enabled, record, codec, ai_enabled, ai_rtsp_url || null, ai_fps, ai_confidence, ai_labels, onvif_url || null]
  );
  const cam = rows[0];
  if (cam.enabled) streamManager.start(cam);
  res.status(201).json(cam);
});

// Cập nhật camera
router.put('/:id', async (req, res) => {
  const { name, rtsp_url, enabled, record, codec, ai_enabled, ai_rtsp_url, ai_fps, ai_confidence, ai_labels, onvif_url } = req.body ?? {};
  if (codec !== undefined && !['auto', 'h264', 'h265'].includes(codec)) {
    res.status(400).json({ error: 'codec must be auto|h264|h265' });
    return;
  }
  if (onvif_url !== undefined && !isOnvifUrlValid(onvif_url)) {
    res.status(400).json({ error: 'onvif_url phải là URL http(s) không chứa tài khoản' });
    return;
  }
  if ((ai_fps !== undefined || ai_confidence !== undefined || ai_labels !== undefined) &&
    !isAiSettingsValid(ai_fps ?? 2, ai_confidence ?? 0.5, ai_labels ?? ['person', 'car', 'motorcycle'])) {
    res.status(400).json({ error: 'ai_fps must be 0.1..10, ai_confidence 0..1, ai_labels must be a string array' });
    return;
  }
  const { rows } = await pool.query<CameraRow>(
    `UPDATE cameras SET
       name = COALESCE($1, name),
       rtsp_url = COALESCE($2, rtsp_url),
       enabled = COALESCE($3, enabled),
       record = COALESCE($4, record),
       codec = COALESCE($5, codec),
       ai_enabled = COALESCE($6, ai_enabled),
       ai_rtsp_url = CASE WHEN $7::text = '' THEN NULL ELSE COALESCE($7, ai_rtsp_url) END,
       ai_fps = COALESCE($8, ai_fps),
       ai_confidence = COALESCE($9, ai_confidence),
       ai_labels = COALESCE($10, ai_labels),
       onvif_url = CASE WHEN $12::text = '' THEN NULL ELSE COALESCE($12, onvif_url) END,
       updated_at = now()
     WHERE id = $11 RETURNING *`,
    [
      name ?? null, rtsp_url ?? null, enabled ?? null, record ?? null, codec ?? null,
      ai_enabled ?? null, ai_rtsp_url ?? null, ai_fps ?? null, ai_confidence ?? null,
      ai_labels ?? null, req.params.id, onvif_url ?? null,
    ]
  );
  if (!rows[0]) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const cam = rows[0];
  invalidatePtz(cam.id);
  talkManager.invalidateCamera(cam.id);
  // Áp dụng thay đổi lên worker
  if (cam.enabled) {
    await streamManager.restart(cam.id);
  } else {
    streamManager.stop(cam.id);
  }
  res.json(cam);
});

// Xóa camera
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  streamManager.stop(id);
  invalidatePtz(id);
  talkManager.invalidateCamera(id);
  await pool.query('DELETE FROM cameras WHERE id = $1', [id]);
  res.status(204).end();
});

// Điều khiển start/stop thủ công
router.post('/:id/start', async (req, res) => {
  const { rows } = await pool.query<CameraRow>(
    'SELECT * FROM cameras WHERE id = $1',
    [req.params.id]
  );
  if (!rows[0]) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  await pool.query('UPDATE cameras SET enabled = true WHERE id = $1', [rows[0].id]);
  streamManager.start({ ...rows[0], enabled: true });
  res.json({ ok: true });
});

/**
 * Nút "Kết nối lại" trên web: nếu IP cũ không còn trả lời thì quét LAN tìm camera
 * theo serial ONVIF, rồi khởi động lại luồng RTSP ngay (bỏ qua backoff).
 */
router.post('/:id/reconnect', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'cameraId không hợp lệ' });
    return;
  }
  try {
    const { rows } = await pool.query<CameraRow>('SELECT * FROM cameras WHERE id = $1', [id]);
    if (!rows[0]) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const moved = await rediscoverCamera(id, true);
    await streamManager.restart(id);
    res.json({ ok: true, moved });
  } catch (error) {
    console.error(`[cameras] reconnect ${id} failed:`, error);
    res.status(500).json({ error: 'Không kết nối lại được camera' });
  }
});

router.post('/:id/stop', async (req, res) => {
  const id = Number(req.params.id);
  await pool.query('UPDATE cameras SET enabled = false WHERE id = $1', [id]);
  streamManager.stop(id);
  talkManager.invalidateCamera(id);
  res.json({ ok: true });
});

export default router;

function isOnvifUrlValid(value: unknown): boolean {
  if (value === null || value === '') return true;
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isAiSettingsValid(fps: unknown, confidence: unknown, labels: unknown): boolean {
  return typeof fps === 'number' && Number.isFinite(fps) && fps >= 0.1 && fps <= 10 &&
    typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 &&
    Array.isArray(labels) && labels.every((label) => typeof label === 'string' && label.trim().length > 0);
}
