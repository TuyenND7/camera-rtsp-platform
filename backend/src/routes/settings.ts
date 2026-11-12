import { Router } from 'express';
import { config } from '../config';
import { AuthedRequest, requireAdmin, requireAuth } from '../middleware/auth';
import { currentSettings, saveSettings, validateSettings } from '../settings';

const router = Router();
router.use(requireAuth, requireAdmin);

router.get('/', (_req, res) => res.json({
  settings: currentSettings(),
  storage_root: config.storageRoot,
  record_timezone: config.recordTimezone,
}));

router.put('/', async (req: AuthedRequest, res) => {
  let value;
  try { value = validateSettings(req.body); }
  catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
  try { res.json({ settings: await saveSettings(value, req.user!.sub) }); }
  catch (error) {
    console.error('[settings] cannot save configuration:', error);
    res.status(503).json({ error: 'Chưa lưu được cấu hình. Vui lòng thử lại.' });
  }
});

export default router;
