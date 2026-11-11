import { Request, Response, Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth';
import {
  ptzGotoPreset, ptzHome, ptzInfo, ptzMove, ptzRemovePreset, ptzSetPreset, ptzStop, PtzError,
} from '../ptz';

/** Mount tại /api/cameras/:id/ptz */
const router = Router({ mergeParams: true });
router.use(requireAuth, requireAdmin);

type Handler = (cameraId: number, req: Request, res: Response) => Promise<void>;

/** Express 4 không bắt lỗi của handler async — bọc lại để lỗi camera không làm sập backend. */
function route(handler: Handler) {
  return async (req: Request, res: Response) => {
    const cameraId = Number(req.params.id);
    if (!Number.isInteger(cameraId) || cameraId <= 0) {
      res.status(400).json({ error: 'cameraId không hợp lệ' });
      return;
    }
    try {
      await handler(cameraId, req, res);
    } catch (err) {
      const status = err instanceof PtzError ? err.status : 500;
      if (status === 500) console.error(`[ptz] camera ${cameraId}:`, err);
      res.status(status).json({ error: err instanceof Error ? err.message : 'Lỗi PTZ' });
    }
  };
}

router.get('/', route(async (cameraId, _req, res) => {
  res.json(await ptzInfo(cameraId));
}));

router.post('/move', route(async (cameraId, req, res) => {
  const x = axis(req.body?.x);
  const y = axis(req.body?.y);
  const zoom = axis(req.body?.zoom);
  if (x === null || y === null || zoom === null) {
    res.status(400).json({ error: 'x, y, zoom phải là số trong khoảng -1..1' });
    return;
  }
  await ptzMove(cameraId, { x, y, zoom });
  res.json({ ok: true });
}));

router.post('/stop', route(async (cameraId, _req, res) => {
  await ptzStop(cameraId);
  res.json({ ok: true });
}));

router.post('/home', route(async (cameraId, _req, res) => {
  await ptzHome(cameraId);
  res.json({ ok: true });
}));

router.post('/presets', route(async (cameraId, req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 40) {
    res.status(400).json({ error: 'Tên preset phải có 1–40 ký tự' });
    return;
  }
  await ptzSetPreset(cameraId, name);
  res.status(201).json(await ptzInfo(cameraId));
}));

router.post('/presets/:token/goto', route(async (cameraId, req, res) => {
  const token = presetToken(req.params.token);
  if (!token) {
    res.status(400).json({ error: 'Preset không hợp lệ' });
    return;
  }
  await ptzGotoPreset(cameraId, token);
  res.json({ ok: true });
}));

router.delete('/presets/:token', route(async (cameraId, req, res) => {
  const token = presetToken(req.params.token);
  if (!token) {
    res.status(400).json({ error: 'Preset không hợp lệ' });
    return;
  }
  await ptzRemovePreset(cameraId, token);
  res.json(await ptzInfo(cameraId));
}));

function axis(value: unknown): number | null {
  if (value === undefined || value === null) return 0;
  const n = Number(value);
  return Number.isFinite(n) && n >= -1 && n <= 1 ? n : null;
}

function presetToken(value: string): string | null {
  return /^[\w.:-]{1,64}$/.test(value) ? value : null;
}

export default router;
