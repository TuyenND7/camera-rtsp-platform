import fs from 'fs/promises';
import path from 'path';
import { config } from '../config';
import { safeStorageFile } from './paths';
import { ClipGap, ClipPart, ClipPlan, EvidenceError, validCameraId } from './types';

function filenameTime(file: string, source: 'rec' | 'playback'): number | null {
  const match = new RegExp(`^${source === 'rec' ? 'rec' : 'play'}_(\\d{4})(\\d{2})(\\d{2})_(\\d{2})(\\d{2})(\\d{2})\\.ts$`).exec(file);
  if (!match) return null;
  const [, y, m, d, h, mi, s] = match.map(Number), value = Date.UTC(y, m - 1, d, h, mi, s);
  if (new Date(value).toISOString().replace(/[-:TZ]/g, '').slice(0, 14) !== `${match[1]}${match[2]}${match[3]}${match[4]}${match[5]}${match[6]}`) return null;
  return value;
}
export function completedEntries(text: string, source: 'rec' | 'playback'): Array<{ file: string; start: number; duration: number }> {
  const entries: Array<{ file: string; start: number; duration: number }> = [];
  let pending: number | null = null, blockAt: number | null = null, elapsed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line === '#EXT-X-DISCONTINUITY') { blockAt = null; elapsed = 0; pending = null; continue; }
    const match = /^#EXTINF:([\d.]+),/.exec(line);
    if (match) { const duration = Number(match[1]); pending = duration > 0 && duration <= 3600 ? duration : null; continue; }
    if (pending === null || !line || line.startsWith('#')) continue;
    const at = filenameTime(line, source), duration = pending; pending = null;
    if (at === null) throw new EvidenceError('Playlist chứa tên bản ghi không hợp lệ.', 409);
    // A block has a continuous media clock. Filename seconds are only an anchor;
    // using each rounded filename would manufacture tiny gaps between segments.
    if (blockAt === null) blockAt = at;
    entries.push({ file: line, start: blockAt + elapsed * 1000, duration }); elapsed += duration;
  }
  return entries;
}
function localDay(at: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: config.recordTimezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
  return ['year','month','day'].map(type => parts.find(part => part.type === type)?.value ?? '').join('');
}
async function sourceParts(cameraId: number, start: number, end: number, source: 'rec' | 'playback'): Promise<ClipPart[]> {
  const days = new Set([localDay(start - 86400_000), localDay(start), localDay(end - 1), localDay(end + 86400_000)]);
  const found = new Map<string, ClipPart>();
  for (const day of days) {
    const prefix = `${source}/${cameraId}/${day}`;
    let entries: ReturnType<typeof completedEntries>;
    try {
      const file = await safeStorageFile(`${prefix}/index.m3u8`), stat = await fs.stat(file);
      if (stat.size > 4 * 1024 * 1024) throw new EvidenceError('Playlist quá lớn để cắt clip an toàn.', 409);
      entries = completedEntries(await fs.readFile(file, 'utf8'), source);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      if (entry.start >= end || entry.start + entry.duration * 1000 <= start) continue;
      if (found.size >= 512) throw new EvidenceError('Khoảng chọn có quá nhiều đoạn. Hãy chọn clip ngắn hơn.', 409);
      const relative = `${prefix}/${entry.file}`;
      try {
        const file = await safeStorageFile(relative), stat = await fs.stat(file);
        if (!stat.size) continue;
        found.set(relative, { file: relative, duration: entry.duration, start: entry.start, size: stat.size, local: '' });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  return [...found.values()].sort((a, b) => a.start - b.start);
}
export function planParts(parts: ClipPart[], start: number, end: number, source: 'rec' | 'playback'): ClipPlan {
  const gaps: ClipGap[] = [], selected: ClipPart[] = [];
  let cursor = start;
  const gap = (a: number, b: number) => { if (b - a > 50) gaps.push({ start_at: new Date(a).toISOString(), end_at: new Date(b).toISOString(), seconds: Number(((b - a) / 1000).toFixed(3)) }); };
  for (const part of parts) {
    if (part.start >= end || part.start + part.duration * 1000 <= start) continue;
    if (selected.length && part.start < cursor - 100) throw new EvidenceError('Bản ghi có mốc thời gian chồng nhau. Chọn khoảng nhỏ hơn ở một phiên ghi.', 409);
    if (part.start > cursor) gap(cursor, Math.min(part.start, end));
    selected.push({ ...part, local: `source-${String(selected.length).padStart(3, '0')}.ts` });
    cursor = Math.max(cursor, Math.min(end, part.start + part.duration * 1000));
  }
  gap(cursor, end);
  const first = selected[0], last = selected[selected.length - 1];
  const seek = first ? Math.max(0, (start - first.start) / 1000) : 0;
  const trim = last ? Math.max(0, (last.start + last.duration * 1000 - end) / 1000) : 0;
  return { source, parts: selected, start, end, seek, gaps, duration: Number(Math.max(0, selected.reduce((sum, part) => sum + part.duration, 0) - seek - trim).toFixed(3)), sourceBytes: selected.reduce((sum, part) => sum + part.size, 0) };
}
export async function recordingPlan(cameraId: number, start: number, end: number): Promise<ClipPlan> {
  if (!validCameraId(cameraId)) throw new EvidenceError('Camera không hợp lệ.');
  let original:ClipPlan|undefined,archive:ClipPlan|undefined,failure:EvidenceError|undefined;
  for(const source of ['rec','playback'] as const){
    try{const plan=planParts(await sourceParts(cameraId,start,end,source),start,end,source);if(source==='rec')original=plan;else archive=plan;}
    catch(error){if(!(error instanceof EvidenceError)||error.status!==409)throw error;failure=error;}
  }
  const plan = archive && (!original || archive.duration >= original.duration - .1) && archive.parts.length ? archive : original;
  if(!plan)throw failure ?? new EvidenceError('Không có bản ghi phù hợp.',409);
  if (!plan.parts.length || plan.duration < .5) throw new EvidenceError('Chưa có đoạn ghi hình đã hoàn tất ở mốc này. Chờ ghi xong hoặc chọn thời gian cũ hơn.', 409);
  return plan;
}
export function privatePlaylist(plan: ClipPlan): string {
  return ['#EXTM3U','#EXT-X-VERSION:3',`#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...plan.parts.map(part => part.duration)))}`,
    '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD',
    ...plan.parts.flatMap((part, index) => [...(index ? ['#EXT-X-DISCONTINUITY'] : []), `#EXTINF:${part.duration.toFixed(6)},`, part.local]), '#EXT-X-ENDLIST',''].join('\n');
}
