import { Router } from 'express';
import { pool } from '../db';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { ControlError, deviceControls } from '../controls/tenda';
import { validateDeviceSettingsChange } from '../controls/settings';
import { talkManager } from '../talk/manager';

const router = Router({ mergeParams: true });
router.use(requireAuth, requireAdmin);
async function camera(id: string) {
  if (!/^[1-9]\d{0,9}$/.test(id) || Number(id) > 2147483647) throw new ControlError(400, 'ID camera không hợp lệ.');
  const { rows } = await pool.query<{ id: number; rtsp_url: string }>('SELECT id, rtsp_url FROM cameras WHERE id = $1', [Number(id)]);
  if (!rows[0]) throw new ControlError(404, 'Không tìm thấy camera.');
  return rows[0];
}
const failure = (error: unknown) => error instanceof ControlError ? error : new ControlError(503, 'Chưa đọc/lưu được cài đặt camera. Hãy thử lại.');
router.get('/', async (req, res) => {
  try {
    // Privacy can stop RTSP while the authenticated SDK stays available to turn it back off.
    const row = await camera((req.params as { id: string }).id);
    res.setHeader('Cache-Control', 'private, no-store'); res.json(await deviceControls.getSettings(row));
  } catch (error) { const e = failure(error); res.status(e.status).json({ error: e.message }); }
});
router.put('/', async (req, res) => {
  try {
    if (!req.secure) throw new ControlError(426, 'Mở web bằng HTTPS để cài đặt camera.');
    const change = validateDeviceSettingsChange(req.body);
    if (!change) throw new ControlError(400, 'Chỉ chọn các cài đặt camera được hỗ trợ.');
    const row = await camera((req.params as { id: string }).id);
    if (talkManager.isCameraBusy(row.id)) throw new ControlError(409, 'Dừng đàm thoại trước khi cài đặt camera.');
    const result = await deviceControls.setSettings(row, change);
    const current = await camera((req.params as { id: string }).id).catch(() => undefined);
    if (!current || current.rtsp_url !== row.rtsp_url) { deviceControls.cancelCamera(row.id); throw new ControlError(409, 'Kết nối camera đã thay đổi. Mở lại cài đặt.'); }
    if (!res.destroyed) res.json(result);
  } catch (error) { const e = failure(error); if (!res.destroyed) res.status(e.status).json({ error: e.message }); }
});
export default router;
