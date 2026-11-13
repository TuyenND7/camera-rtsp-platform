import { Router } from 'express';
import { requireAdmin, requireAuth } from '../middleware/auth';
import { cameraVideo, validateVideoChange, VideoSettingsError } from '../videoSettings';

const router = Router({ mergeParams: true });
router.use(requireAuth, requireAdmin);
router.use((req, res, next) => {
  const value = (req.params as { id: string }).id;
  if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647) { res.status(400).json({ error: 'ID camera không hợp lệ.' }); return; }
  res.setHeader('Cache-Control', 'private, no-store'); next();
});
router.get('/', async (req, res) => {
  try { res.json(await cameraVideo.get(Number((req.params as { id: string }).id))); }
  catch (error) { const e = error instanceof VideoSettingsError ? error : new VideoSettingsError(503, 'Chưa đọc được cài đặt camera.'); res.status(e.status).json({ error: e.message }); }
});
router.put('/', async (req, res) => {
  try {
    if (!req.secure) throw new VideoSettingsError(426, 'Mở web bằng HTTPS để cài đặt camera.');
    res.json(await cameraVideo.set(Number((req.params as { id: string }).id), validateVideoChange(req.body)));
  } catch (error) { const e = error instanceof VideoSettingsError ? error : new VideoSettingsError(503, 'Chưa áp dụng được cài đặt camera.'); res.status(e.status).json({ error: e.message }); }
});
export default router;
