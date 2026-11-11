import fs from 'fs';

/** Số stat chạy song song khi quét thư mục recording. */
export const STAT_CONCURRENCY = 32;

/** Chạy fn cho từng item với tối đa `limit` promise đồng thời. */
export async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

/** stat không ném lỗi khi file vừa bị FFmpeg/retention xoá giữa chừng. */
export async function statIfExists(file: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(file);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}
