import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { config } from '../config';

export class EventImageMissing extends Error {}
export class EventThumbnailBusy extends Error {}
type Renderer = (source: string, target: string) => Promise<void>;

async function renderThumbnail(source: string, target: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1', '-i', source,
      '-vf', 'scale=320:180:force_original_aspect_ratio=decrease', '-frames:v', '1', '-q:v', '7', '-threads', '1', '-y', target],
    { timeout: 15000, maxBuffer: 16384 }, error => error ? reject(error) : resolve());
  });
}

/** Existing snapshots are resized once; new AI snapshots already have this sibling. */
export class EventThumbnailCache {
  private jobs = new Map<string, Promise<string>>();
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private root: string, private renderer: Renderer = renderThumbnail) {}

  private async acquire() {
    if (this.active < 2) { this.active++; return; }
    if (this.waiting.length >= 64) throw new EventThumbnailBusy();
    await new Promise<void>(resolve => this.waiting.push(resolve));
  }

  private release() {
    const next = this.waiting.shift();
    if (next) next(); else this.active--;
  }

  async get(snapshot: string): Promise<string> {
    if (typeof snapshot !== 'string' || !/^events\/[1-9]\d*\/\d{8}\/[A-Za-z0-9_-]+\.jpe?g$/.test(snapshot)) throw new EventImageMissing();
    let source: string, stat;
    try {
      const root = await fs.realpath(path.join(this.root, 'events'));
      source = await fs.realpath(path.join(this.root, snapshot));
      if (!source.startsWith(root + path.sep)) throw new EventImageMissing();
      stat = await fs.stat(source);
      if (!stat.isFile() || stat.size < 16 || stat.size > 25 * 1024 * 1024) throw new EventImageMissing();
    } catch (error) {
      if (error instanceof EventImageMissing || (error as NodeJS.ErrnoException).code === 'ENOENT') throw new EventImageMissing();
      throw error;
    }
    const target = source.replace(/\.jpe?g$/, '.thumb.jpg');
    try {
      const cached = await fs.lstat(target);
      if (cached.isFile() && !cached.isSymbolicLink() && cached.size > 0 && cached.size < 512 * 1024 && cached.mtimeMs + 1 >= stat.mtimeMs) return target;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const running = this.jobs.get(source);
    if (running) return running;
    const job = this.generate(source, target, stat.mtimeMs);
    this.jobs.set(source, job);
    try { return await job; } finally { this.jobs.delete(source); }
  }

  private async generate(source: string, target: string, modifiedAt: number): Promise<string> {
    await this.acquire();
    const temporary = `${target}.${randomUUID()}.part.jpg`;
    try {
      await this.renderer(source, temporary);
      await fs.utimes(temporary, new Date(), new Date(modifiedAt));
      await fs.rename(temporary, target);
      return target;
    } finally {
      this.release();
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

export const eventThumbnails = new EventThumbnailCache(config.storageRoot);
