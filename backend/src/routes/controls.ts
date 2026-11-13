import { Router } from 'express';
import { pool } from '../db';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { ControlError, deviceControls, unavailableControls } from '../controls/tenda';
import { talkManager, TalkCamera } from '../talk/manager';

const router = Router({ mergeParams: true });
router.use(requireAuth, requireAdmin);
type Camera = TalkCamera & { enabled: boolean; status: string };
async function camera(value: string): Promise<Camera> {
  if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647) throw new ControlError(400, 'ID camera không hợp lệ.');
  const { rows } = await pool.query<Camera>('SELECT id, rtsp_url, enabled, status FROM cameras WHERE id = $1', [Number(value)]);
  if (!rows[0]) throw new ControlError(404, 'Không tìm thấy camera.');
  return rows[0];
}
const failure = (error: unknown) => error instanceof ControlError ? error : new ControlError(503, 'Chưa điều khiển được camera. Hãy thử lại.');
router.get('/', async (req, res) => {
  try {
    const row = await camera((req.params as { id: string }).id);
    if (!row.enabled || row.status !== 'online') { res.json(unavailableControls(row.id, 'Camera chưa trực tuyến.')); return; }
    res.setHeader('Cache-Control', 'private, no-store'); res.json(await deviceControls.get(row));
  } catch (error) { const e = failure(error); res.status(e.status).json({ error: e.message }); }
});
router.post('/', async (req, res) => {
  try {
    if (!req.secure) throw new ControlError(426, 'Mở web bằng HTTPS để điều khiển còi và đèn.');
    const { action, enabled, duration_seconds = 10 } = req.body ?? {};
    if (!['alarm', 'light'].includes(action) || typeof enabled !== 'boolean' || ![5, 10, 30].includes(duration_seconds) || Object.keys(req.body ?? {}).some(key => !['action', 'enabled', 'duration_seconds'].includes(key))) throw new ControlError(400, 'Lệnh điều khiển không hợp lệ.');
    const row = await camera((req.params as { id: string }).id);
    if (enabled && (!row.enabled || row.status !== 'online')) throw new ControlError(409, 'Camera chưa trực tuyến.');
    if (action === 'alarm' && enabled && talkManager.isCameraBusy(row.id)) throw new ControlError(409, 'Camera đang đàm thoại. Dừng mic trước khi bật còi.');
    const result = await deviceControls.set(row, action, enabled, duration_seconds);
    const current = await camera((req.params as { id: string }).id).catch(() => undefined);
    if (!current || current.rtsp_url !== row.rtsp_url) { deviceControls.cancelCamera(row.id); throw new ControlError(409, 'Cấu hình camera đã thay đổi.'); }
    if (!res.destroyed) res.json(result); else if (action === 'alarm' && enabled) deviceControls.cancelCamera(row.id);
  } catch (error) { const e = failure(error); if (!res.destroyed) res.status(e.status).json({ error: e.message }); }
});
export default router;
