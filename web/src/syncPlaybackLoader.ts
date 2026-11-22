import type { BrowserPlaybackState } from './api';

export type PreparedSyncClip = { state: 'queued' | 'processing' | 'ready' | 'error'; url?: string; base?: number; error?: string };
type Task = { key: string; cameraId: number; day: string; file: string; controller: AbortController; value: PreparedSyncClip };
type Prepare = (cameraId: number, day: string, file: string, signal: AbortSignal) => Promise<BrowserPlaybackState>;

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** At most two conversions in flight; old selections cannot revive after a seek. */
export class SyncClipQueue {
  private tasks = new Map<string, Task>();
  private running = 0;
  private disposed = false;
  private wanted = new Set<string>();
  constructor(private prepare: Prepare, private changed: () => void, private pollMs = 1500, private deadlineMs = 75000) {}
  get closed(): boolean { return this.disposed; }
  get(key: string): PreparedSyncClip | undefined { return this.tasks.get(key)?.value; }
  request(key: string, cameraId: number, day: string, file: string): void {
    if (this.disposed || this.tasks.has(key)) return;
    this.tasks.set(key, { key, cameraId, day, file, controller: new AbortController(), value: { state: 'queued' } });
    this.trim(); this.pump();
  }
  retain(wanted: Set<string>): void {
    this.wanted = wanted;
    for (const [key, task] of this.tasks) if (!wanted.has(key) && ['queued', 'processing'].includes(task.value.state)) {
      task.controller.abort(); this.tasks.delete(key);
    }
  }
  retry(key: string): void { const task = this.tasks.get(key); if (task?.value.state === 'error') this.tasks.delete(key); }
  dispose(): void { this.disposed = true; for (const task of this.tasks.values()) task.controller.abort(); this.tasks.clear(); }
  private trim(): void {
    for (const [key, task] of this.tasks) {
      if (this.tasks.size <= 24) break;
      if (!this.wanted.has(key) && (task.value.state === 'ready' || task.value.state === 'error')) this.tasks.delete(key);
    }
  }
  private pump(): void {
    if (this.disposed) return;
    for (const task of this.tasks.values()) {
      if (this.running >= 2) break;
      if (task.value.state !== 'queued') continue;
      this.running++; task.value = { state: 'processing' }; this.changed();
      void this.run(task).finally(() => { this.running--; this.pump(); });
    }
  }
  private async run(task: Task): Promise<void> {
    const deadline = setTimeout(() => task.controller.abort(), this.deadlineMs);
    try {
      for (let attempt = 0; attempt < 50; attempt++) {
        const response = await this.prepare(task.cameraId, task.day, task.file, task.controller.signal);
        if (task.controller.signal.aborted || this.tasks.get(task.key) !== task) return;
        if (response.status === 'ready' && response.playlist) {
          task.value = { state: 'ready', url: response.playlist, base: response.start_position ?? 0 }; return;
        }
        if (response.status === 'error') throw new Error(response.error || 'Chưa chuẩn bị được bản ghi.');
        await wait(this.pollMs, task.controller.signal);
      }
      throw new Error('Chuẩn bị bản ghi quá thời gian chờ.');
    } catch (error) {
      if (this.tasks.get(task.key) === task && !this.disposed) task.value = { state: 'error',
        error: task.controller.signal.aborted ? 'Chuẩn bị bản ghi quá thời gian chờ. Nhấn Thử lại.' : error instanceof Error ? error.message : 'Chưa chuẩn bị được bản ghi.' };
    } finally {
      clearTimeout(deadline);
      if (!this.disposed && this.tasks.get(task.key) === task) this.changed();
    }
  }
}

/** Parent cancellation and a finite body-read deadline apply to every request. */
export async function syncRequest<T>(parent: AbortSignal, request: (signal: AbortSignal) => Promise<T>, timeoutMs = 10000): Promise<T> {
  const controller = new AbortController(), abort = () => controller.abort();
  parent.addEventListener('abort', abort, { once: true });
  if (parent.aborted) abort();
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([request(controller.signal), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Máy chủ trả lời quá chậm. Vui lòng thử lại.')); }, timeoutMs);
      controller.signal.addEventListener('abort', () => reject(new Error('Đã hủy lượt tải bản ghi.')), { once: true });
      if (controller.signal.aborted) reject(new Error('Đã hủy lượt tải bản ghi.'));
    })]);
  } finally { clearTimeout(timer!); parent.removeEventListener('abort', abort); }
}
