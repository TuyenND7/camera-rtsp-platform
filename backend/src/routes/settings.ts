import { Router } from 'express';
import { config } from '../config';
import { AuthedRequest, requireAdmin, requireAuth } from '../middleware/auth';
import { currentSettings, saveSettings, validateSettings } from '../settings';
import { AccountError, tendaAccount, validateAccountInput } from '../account/tenda';
import { loginLimiter } from '../middleware/security';
import { sessionUser } from '../sessions';

const router = Router();
router.use(requireAuth, requireAdmin);

router.get('/tenda', (_req, res) => res.json(tendaAccount.status()));
router.post('/tenda/login', loginLimiter(5, 60_000), async (req: AuthedRequest, res) => {
  if (!req.secure) { if (req.body) delete req.body.password; res.status(400).json({ error: 'Mở web bằng HTTPS để đăng nhập Tenda.' }); return; }
  let input;
  try { input = validateAccountInput(req.body); }
  catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
  finally { if (req.body) delete req.body.password; }
  const abort = new AbortController();
  const closed = () => { if (!res.writableEnded) abort.abort(); };
  res.on('close', closed);
  try {
    await tendaAccount.login(input, abort.signal, async () => (await sessionUser(req.sessionToken!))?.role === 'admin');
    res.json({ ok: true });
  } catch (error) {
    if (!res.destroyed) res.status(error instanceof AccountError ? error.status : 503).json({ error: error instanceof AccountError ? error.message : 'Chưa đăng nhập được Tenda.' });
  } finally { input.password = ''; res.off('close', closed); }
});

router.get('/', (_req, res) => res.json({
  settings: currentSettings(),
  storage_root: config.storageRoot,
  record_timezone: config.recordTimezone,
}));

router.put('/', async (req: AuthedRequest, res) => {
  let value;
  try { value = validateSettings(req.body, config.alarmDurationSeconds); }
  catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
  try { res.json({ settings: await saveSettings(value, req.user!.sub) }); }
  catch (error) {
    console.error('[settings] cannot save configuration:', error);
    res.status(503).json({ error: 'Chưa lưu được cấu hình. Vui lòng thử lại.' });
  }
});

export default router;
