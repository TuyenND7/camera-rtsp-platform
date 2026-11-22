import express, { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { pool } from '../db';
import { config } from '../config';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { enrollIdentity, identityRoot, identityStatus, IdentityError, jobDirectory, readIdentityJob, startIdentityJob, uuid, validName } from '../identities';

const router = Router();
router.use(requireAuth, requireAdmin);
const run = (fn: express.RequestHandler): express.RequestHandler => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(error => {
    if (res.headersSent) return next(error);
    res.status(error instanceof IdentityError ? error.status : 503).json({ error: error instanceof IdentityError ? error.message : 'Chưa xử lý được dữ liệu định danh.' });
  });
};
router.get('/', run(async (_req, res) => {
  const { rows } = await pool.query(`SELECT p.id,p.name,count(s.id)::int AS sample_count,
    (SELECT id FROM identity_samples WHERE person_id=p.id ORDER BY created_at LIMIT 1) AS sample_id
    FROM identified_people p LEFT JOIN identity_samples s ON s.person_id=p.id GROUP BY p.id ORDER BY p.created_at`);
  res.json({ status: await identityStatus(), people: rows.map(({ sample_id, ...person }) => ({ ...person, image_url: sample_id ? `/api/identities/samples/${sample_id}` : null })) });
}));
router.post('/analyze', express.raw({ type: ['image/jpeg', 'image/png'], limit: '4mb' }), run(async (req, res) => {
  let input: Buffer;
  if (Buffer.isBuffer(req.body)) input = req.body;
  else {
    const id = Number(req.body?.event_id);
    if (!Number.isSafeInteger(id) || id < 1) throw new IdentityError(400, 'Chọn ảnh hoặc sự kiện hợp lệ.');
    const { rows } = await pool.query('SELECT snapshot_path FROM detection_events WHERE id=$1', [id]);
    const relative = rows[0]?.snapshot_path;
    if (typeof relative !== 'string' || !/^events\/[1-9]\d*\/\d{8}\/[A-Za-z0-9_-]+\.jpe?g$/.test(relative)) throw new IdentityError(404, 'Không tìm thấy ảnh sự kiện.');
    const root = await fs.realpath(path.join(config.storageRoot, 'events'));
    const source = await fs.realpath(path.join(config.storageRoot, relative));
    if (!source.startsWith(root + path.sep) || (await fs.stat(source)).size > 4*1024*1024) throw new IdentityError(400, 'Ảnh sự kiện không hợp lệ hoặc quá lớn.');
    input = await fs.readFile(source);
  }
  res.status(202).json({ id: await startIdentityJob(input), state: 'processing' });
}));
router.get('/jobs/:id', run(async (req, res) => { res.json(await readIdentityJob(req.params.id)); }));
router.get('/jobs/:id/faces/:face', run(async (req, res) => {
  if (!/^[0-7]$/.test(req.params.face)) throw new IdentityError(400, 'Khuôn mặt không hợp lệ.');
  const directory = await jobDirectory(req.params.id);
  res.type('jpg').sendFile(path.join(directory, `${req.params.face}.jpg`), error => { if (error && !res.headersSent) res.sendStatus(404); });
}));
router.post('/enroll', run(async (req, res) => { res.status(201).json({ id: await enrollIdentity(req.body) }); }));
router.get('/samples/:id', run(async (req, res) => {
  if (!uuid.test(req.params.id)) throw new IdentityError(400, 'Ảnh mẫu không hợp lệ.');
  const { rowCount } = await pool.query('SELECT id FROM identity_samples WHERE id=$1', [req.params.id]);
  if (!rowCount) throw new IdentityError(404, 'Ảnh mẫu đã bị xóa.');
  res.type('jpg').sendFile(path.join(identityRoot, 'portraits', `${req.params.id}.jpg`), error => { if (error && !res.headersSent) res.sendStatus(404); });
}));
router.put('/:id', run(async (req, res) => {
  if (!uuid.test(req.params.id) || !validName(req.body?.name)) throw new IdentityError(400, 'Tên cần từ 1 đến 60 ký tự.');
  const { rowCount } = await pool.query('UPDATE identified_people SET name=$1 WHERE id=$2', [req.body.name.trim(), req.params.id]);
  if (!rowCount) throw new IdentityError(404, 'Không tìm thấy hồ sơ.');
  res.json({ ok: true });
}));
router.delete('/:id', run(async (req, res) => {
  if (!uuid.test(req.params.id)) throw new IdentityError(400, 'Hồ sơ không hợp lệ.');
  const client = await pool.connect(); let samples: Array<{ id: string }> = [];
  try {
    await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(726143)');
    samples = (await client.query('SELECT id FROM identity_samples WHERE person_id=$1', [req.params.id])).rows;
    const result = await client.query('DELETE FROM identified_people WHERE id=$1', [req.params.id]);
    if (!result.rowCount) throw new IdentityError(404, 'Không tìm thấy hồ sơ.');
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  await Promise.all(samples.map(sample => fs.rm(path.join(identityRoot, 'portraits', `${sample.id}.jpg`), { force: true }).catch(() => undefined)));
  res.status(204).end();
}));
router.use((error: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (error?.type === 'entity.too.large') { res.status(413).json({ error: 'Chọn ảnh nhỏ hơn 4 MB.' }); return; }
  next(error);
});
export default router;
