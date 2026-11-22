import fs from 'fs/promises';
import { constants } from 'fs';
import path from 'path';
import { config } from '../config';
import { EvidenceError, validUuid } from './types';

export const clipRoot = () => path.join(config.storageRoot, 'protected-clips');
export function jobDirectory(id: string): string {
  if (!validUuid(id)) throw new EvidenceError('Clip không hợp lệ.');
  return path.join(clipRoot(), id);
}
export async function privateDirectory(directory: string): Promise<void> {
  await fs.mkdir(config.storageRoot, { recursive: true });
  const relative = path.relative(config.storageRoot, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new EvidenceError('Thư mục clip không hợp lệ.');
  let current = config.storageRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    await fs.mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await fs.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new EvidenceError('Thư mục clip không an toàn.');
  }
}
export async function safeStorageFile(relative: string): Promise<string> {
  if (!relative || relative.includes('\\') || path.isAbsolute(relative) || relative.split('/').some(value => !value || value === '.' || value === '..')) throw new EvidenceError('Đường dẫn bản ghi không hợp lệ.');
  const root = await fs.realpath(config.storageRoot);
  let current = root;
  const components = relative.split('/');
  for (let index = 0; index < components.length; index++) {
    current = path.join(current, components[index]);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (index < components.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new EvidenceError('Không đọc liên kết trong kho ghi hình.');
  }
  const real = await fs.realpath(current);
  if (!real.startsWith(root + path.sep)) throw new EvidenceError('Bản ghi nằm ngoài kho lưu trữ.');
  return real;
}
/** Opened handles remain readable if retention unlinks a completed source on Linux. */
export async function snapshotSource(relative: string, destination: string, signal?: AbortSignal): Promise<void> {
  const source = await safeStorageFile(relative);
  const input = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let output: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const stat = await input.stat();
    if (!stat.isFile()) throw new EvidenceError('Bản ghi không phải file hoàn tất.');
    output = await fs.open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    const buffer = Buffer.alloc(1024 * 1024);
    let at = 0;
    while (true) {
      if (signal?.aborted) throw new EvidenceError('Đã hủy tạo clip.',409);
      const { bytesRead } = await input.read(buffer, 0, buffer.length, at);
      if (!bytesRead) break;
      let written = 0;
      while (written < bytesRead) written += (await output.write(buffer, written, bytesRead - written, at + written)).bytesWritten;
      at += bytesRead;
    }
    if (at !== stat.size) throw new EvidenceError('Bản ghi thay đổi trong lúc giữ clip. Chọn lại mốc đã ghi xong.', 409);
    await output.sync();
  } finally { await input.close(); await output?.close(); }
}
export async function removeJobFiles(id: string): Promise<void> {
  const directory = jobDirectory(id);
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new EvidenceError('Thư mục clip không an toàn.');
    await fs.rm(directory, { recursive: true, force: true });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
