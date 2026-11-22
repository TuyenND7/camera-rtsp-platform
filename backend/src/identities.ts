import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from './config';
import { pool } from './db';

export const faceModel = 'opencv-sface-2021dec';
export const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const identityRoot = path.join(config.storageRoot, '.identities');
export class IdentityError extends Error { constructor(public status: number, message: string) { super(message); } }
export function validName(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 60 && !/[\x00-\x1f\x7f]/.test(value); }
export function validEmbedding(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === 128 && value.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1.01) && Math.abs(Math.sqrt(value.reduce((sum, v) => sum+v*v, 0))-1) < .02;
}
export async function identityStatus() {
  try {
    const value = JSON.parse(await fs.readFile(path.join(identityRoot, 'status.json'), 'utf8'));
    if (Math.abs(Date.now()-value.updated_at) < 15000) return { state: value.state, message: value.message, model: faceModel };
  } catch {}
  return { state: 'unavailable', message: 'Bộ nhận dạng khuôn mặt chưa sẵn sàng trên máy chủ.', model: faceModel };
}
export async function identityPeople(): Promise<Map<string, string>> {
  const { rows } = await pool.query('SELECT id, name FROM identified_people');
  return new Map(rows.map(row => [row.id, row.name]));
}
export type FaceIdentity = { state: 'known' | 'unmatched' | 'not_visible' | 'pending' | 'unavailable'; person_id?: string; name?: string };
export function faceIdentity(value: any, people: Map<string, string>): FaceIdentity | undefined {
  if (!value || !['known', 'unmatched', 'not_visible', 'pending', 'unavailable'].includes(value.state)) return undefined;
  if (value.state === 'known') {
    const name = typeof value.person_id === 'string' ? people.get(value.person_id) : undefined;
    return name ? { state: 'known', person_id: value.person_id, name } : { state: 'unmatched' };
  }
  return { state: value.state };
}
export function identityMetadata(metadata: any, people: Map<string, string>) {
  if (!metadata || typeof metadata !== 'object') return metadata;
  return { ...metadata, identity: faceIdentity(metadata.identity, people), detections: Array.isArray(metadata.detections) ? metadata.detections.map((d: any) => ({ ...d, identity: d.label === 'person' ? faceIdentity(d.identity, people) : undefined })) : metadata.detections };
}
let creatingJobs = 0;
export async function startIdentityJob(input: Buffer): Promise<string> {
  if (!input.length || input.length > 4*1024*1024 || !(input.subarray(0, 3).equals(Buffer.from([255,216,255])) || input.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))) throw new IdentityError(400, 'Chọn ảnh JPEG hoặc PNG, tối đa 4 MB.');
  const status = await identityStatus();
  if (status.state !== 'ready') throw new IdentityError(503, status.message || 'Nhận dạng chưa sẵn sàng.');
  const root = path.join(identityRoot, 'jobs');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const jobs = await fs.readdir(root);
  if (jobs.length+creatingJobs >= 40) throw new IdentityError(429, 'Đang có nhiều ảnh được xử lý. Vui lòng chờ ít phút.');
  const id = randomUUID(), directory = path.join(root, id);
  creatingJobs++;
  try {
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(path.join(directory, 'input'), input, { mode: 0o600 });
    await fs.writeFile(path.join(directory, 'request.tmp'), JSON.stringify({ version: 1, created_at: Date.now() }), { mode: 0o600 });
    await fs.rename(path.join(directory, 'request.tmp'), path.join(directory, 'request.json'));
    return id;
  } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; } finally { creatingJobs--; }
}
export async function jobDirectory(id: string) {
  if (!uuid.test(id)) throw new IdentityError(400, 'Mã ảnh không hợp lệ.');
  const directory = path.join(identityRoot, 'jobs', id);
  try { const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || Date.now()-stat.mtimeMs > 600000) throw Error(); }
  catch { throw new IdentityError(404, 'Ảnh đã hết hạn. Chọn lại ảnh để đăng ký.'); }
  return directory;
}
export async function readIdentityJob(id: string) {
  const directory = await jobDirectory(id);
  try {
    const value = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8'));
    if (value.state === 'error') return { id, state: 'error', message: value.message };
    return { id, state: 'ready', faces: value.faces.slice(0, 8).filter((face: any) => /^[0-7]$/.test(face.id)).map((face: any) => ({ id: face.id, image_url: `/api/identities/jobs/${id}/faces/${face.id}` })) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { id, state: 'processing' };
    throw error;
  }
}
export async function enrollIdentity(body: any) {
  const { job_id, face_id, person_id, name } = body ?? {};
  if (typeof job_id !== 'string' || typeof face_id !== 'string' || !/^[0-7]$/.test(face_id) || (person_id ? !uuid.test(person_id) : !validName(name))) throw new IdentityError(400, 'Chọn một khuôn mặt và nhập tên hợp lệ.');
  const directory = await jobDirectory(job_id);
  let feature: any;
  try { feature = JSON.parse(await fs.readFile(path.join(directory, `${face_id}.json`), 'utf8')); }
  catch { throw new IdentityError(400, 'Ảnh chưa có mẫu khuôn mặt hợp lệ.'); }
  if (feature.model !== faceModel || !validEmbedding(feature.embedding)) throw new IdentityError(400, 'Mẫu khuôn mặt không hợp lệ.');
  const portrait = await fs.readFile(path.join(directory, `${face_id}.jpg`));
  if (!portrait.length || portrait.length > 200000) throw new IdentityError(400, 'Ảnh khuôn mặt không hợp lệ.');
  const person = person_id || randomUUID(), sample = randomUUID();
  const portraits = path.join(identityRoot, 'portraits'); await fs.mkdir(portraits, { recursive: true, mode: 0o700 });
  const target = path.join(portraits, `${sample}.jpg`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(726143)');
    if (!person_id) {
      const count = await client.query('SELECT count(*)::int AS count FROM identified_people');
      if (count.rows[0].count >= 200) throw new IdentityError(400, 'Danh sách đã đủ 200 người.');
      await client.query('INSERT INTO identified_people(id,name) VALUES($1,$2)', [person, name.trim()]);
    } else {
      const found = await client.query('SELECT id FROM identified_people WHERE id=$1 FOR UPDATE', [person]);
      if (!found.rowCount) throw new IdentityError(404, 'Không tìm thấy hồ sơ.');
    }
    const count = await client.query('SELECT count(*)::int AS count FROM identity_samples WHERE person_id=$1', [person]);
    if (count.rows[0].count >= 10) throw new IdentityError(400, 'Mỗi người được lưu tối đa 10 ảnh mẫu.');
    await fs.writeFile(target, portrait, { mode: 0o600, flag: 'wx' });
    await client.query('INSERT INTO identity_samples(id,person_id,model,embedding,enrollment_key) VALUES($1,$2,$3,$4::jsonb,$5)', [sample, person, faceModel, JSON.stringify(feature.embedding), `${job_id}:${face_id}`]);
    await client.query('COMMIT');
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    return person;
  } catch (error) {
    await client.query('ROLLBACK'); await fs.rm(target, { force: true });
    if ((error as any).code === '23505') throw new IdentityError(409, 'Khuôn mặt này đã được đăng ký. Chọn ảnh khác để thêm mẫu.');
    throw error;
  } finally { client.release(); }
}
