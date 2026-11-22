import type { Camera, RecordingDay, RecordingSegment } from './api';

export type SyncSegment = RecordingSegment & { startMs: number; endMs: number };
export type SyncTarget = { kind: 'gap' } | { kind: 'unfinished' } | {
  kind: 'day'; key: string; url: string; seconds: number; coverage: number; offset: 'offset_s' | 'archive_offset_s'; segment: SyncSegment;
} | { kind: 'prepare'; key: string; segment: SyncSegment };
export const SYNC_RATES = [1, 2, 4, 8] as const;
export const DEFAULT_RECORD_ZONE = 'Asia/Ho_Chi_Minh';
const knownZones = new Set<string>();
const formatters = new Map<string, Intl.DateTimeFormat>();

export function recordZone(value: unknown): string {
  try { if (typeof value === 'string') {
    if (!knownZones.has(value)) {
      new Intl.DateTimeFormat('en', { timeZone: value }).format(); knownZones.add(value);
      if (knownZones.size > 8) knownZones.delete(knownZones.values().next().value!);
    }
    return value;
  } } catch {}
  return DEFAULT_RECORD_ZONE;
}
export function validSyncDay(value: string): boolean {
  if (!/^(20\d{2}|2100)\d{4}$/.test(value)) return false;
  const date = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10).replace(/-/g, '') === value;
}
function parts(at: number, zone: string) {
  const timezone = recordZone(zone);
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    formatters.set(timezone, formatter); if (formatters.size > 8) formatters.delete(formatters.keys().next().value!);
  }
  const values = formatter.formatToParts(at);
  const get = (key: string) => values.find(value => value.type === key)?.value ?? '';
  return { day: `${get('year')}${get('month')}${get('day')}`, time: `${get('hour')}:${get('minute')}:${get('second')}` };
}
export const syncDayAt = (at: number, zone: string) => parts(at, zone).day;
export const syncClockAt = (at: number, zone: string) => parts(at, zone).time;
export const syncDateInput = (day: string) => `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;

/** Convert the server's civil time, independently of the viewer's timezone. */
export function syncTimeOnDay(day: string, clock: string, zone: string): number | null {
  if (!validSyncDay(day) || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(clock)) return null;
  const full = clock.length === 5 ? `${clock}:00` : clock;
  return civilTime(day, full, zone);
}
function civilTime(day: string, full: string, zone: string): number | null {
  const target = Date.parse(`${syncDateInput(day)}T${full}Z`);
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const current = parts(guess, zone);
    const difference = target - Date.parse(`${syncDateInput(current.day)}T${current.time}Z`);
    if (!difference) return guess;
    guess += difference;
  }
  const result = parts(guess, zone);
  return result.day === day && result.time === full ? guess : null;
}
export function syncDayBounds(day: string, zone: string): [number, number] {
  if (!validSyncDay(day)) throw new Error('Ngày xem lại không hợp lệ.');
  const tomorrow = new Date(`${syncDateInput(day)}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const nextDay = tomorrow.toISOString().slice(0, 10).replace(/-/g, '');
  const start = civilTime(day, '00:00:00', zone), end = civilTime(nextDay, '00:00:00', zone);
  if (start === null || end === null) throw new Error('Chưa xác định được giờ bắt đầu của ngày.');
  return [start, end];
}
export function syncUrlState(search: string, zone: string, now = Date.now()) {
  const params = new URLSearchParams(search), cameras = [...new Set((params.get('cameras') ?? '').split(',')
    .filter(value => /^[1-9]\d{0,9}$/.test(value)).map(Number).filter(value => value <= 2147483647))].slice(0, 4);
  const day = params.get('day') ?? '', rawAt = params.get('at') ?? '';
  const parsedAt = /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/i.test(rawAt) && validSyncDay(rawAt.slice(0, 10).replace(/-/g, '')) ? Date.parse(rawAt) : NaN;
  const at = Number.isFinite(parsedAt) && validSyncDay(syncDayAt(parsedAt, zone)) ? parsedAt : null;
  const chosenDay = validSyncDay(day) ? day : at !== null ? syncDayAt(at, zone) : syncDayAt(now, zone);
  return { cameras, day: chosenDay, explicitDay: validSyncDay(day) || at !== null,
    at: at !== null && syncDayAt(at, zone) === chosenDay ? at : null };
}
export function syncSegments(values: RecordingSegment[]): SyncSegment[] {
  return values.flatMap(value => {
    const startMs = typeof value.started_at === 'string' ? Date.parse(value.started_at) : NaN;
    return Number.isFinite(startMs) && Number.isFinite(value.duration_s) && value.duration_s > 0
      ? [{ ...value, startMs, endMs: startMs + value.duration_s * 1000 }] : [];
  }).sort((a, b) => a.startMs - b.startMs);
}
export function exactSyncSegment(segments: SyncSegment[], at: number): SyncSegment | null {
  let lo = 0, hi = segments.length - 1, found = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (segments[mid].startMs <= at) { found = mid; lo = mid + 1; } else hi = mid - 1; }
  return found >= 0 && at < segments[found].endMs ? segments[found] : null;
}
const offset = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const dayFacts = new WeakMap<RecordingDay, { archived: boolean; original: number; archive: number }>();
export const syncClipKey = (id: number, day: string, file: string) => `${id}/${day}/${file}`;
export function syncTarget(camera: Pick<Camera, 'id' | 'codec'>, day: string, data: RecordingDay, segments: SyncSegment[], at: number): SyncTarget {
  const segment = exactSyncSegment(segments, at);
  if (!segment) return { kind: 'gap' };
  if (!offset(segment.offset_s)) return { kind: 'unfinished' };
  let facts = dayFacts.get(data);
  if (!facts) {
    facts = { archived: false, original: 0, archive: 0 };
    for (const item of segments) {
      if (offset(item.offset_s)) facts.original = Math.max(facts.original, item.offset_s + item.duration_s);
      if (offset(item.archive_offset_s)) { facts.archived = true; facts.archive = Math.max(facts.archive, item.archive_offset_s + item.duration_s); }
    }
    dayFacts.set(data, facts);
  }
  const hevc = camera.codec === 'h265' || facts.archived;
  const field = data.day_playback?.archive ? 'archive_offset_s' : 'offset_s';
  const url = field === 'archive_offset_s' ? data.day_playback?.archive : !hevc ? data.day_playback?.original : null;
  if (url && offset(segment[field])) {
    const coverage = field === 'archive_offset_s' ? facts.archive : facts.original;
    return { kind: 'day', key: `${camera.id}/${day}/${field}`, url, seconds: segment[field]! + (at - segment.startMs) / 1000, coverage, offset: field, segment };
  }
  return { kind: 'prepare', key: syncClipKey(camera.id, day, segment.file), segment };
}
/** Merge only touching/overlapping completed recordings; do not paint across a gap. */
export function syncRanges(segments: SyncSegment[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const segment of segments) {
    if (!offset(segment.offset_s)) continue;
    const last = ranges[ranges.length - 1];
    if (last && segment.startMs <= last[1]) last[1] = Math.max(last[1], segment.endMs);
    else ranges.push([segment.startMs, segment.endMs]);
  }
  return ranges;
}
export function chooseSyncStart(data: RecordingDay[], day: string, zone: string, requested: number | null): number {
  const [start, end] = syncDayBounds(day, zone);
  if (requested !== null && requested >= start && requested < end) return requested;
  const lists = data.map(item => syncSegments(item.segments).filter(segment => offset(segment.offset_s) && segment.endMs > start && segment.startMs < end));
  // Start near the latest common recorded moment, or near any recording if no overlap exists.
  const ends = lists.flatMap(list => list.map(segment => Math.min(end, segment.endMs))).sort((a, b) => b - a);
  for (const edge of ends) {
    const candidate = Math.max(start, edge - 1000);
    if (lists.length && lists.every(list => !!exactSyncSegment(list, candidate))) return candidate;
  }
  return ends.length ? Math.max(start, ends[0] - 1000) : start;
}
/** No compressed-time progress can move the common wall clock. */
export class SyncClock {
  wallMs: number;
  playing = false;
  blocked = true;
  rate = 1;
  private lastNow: number;
  constructor(at: number, now: number) { this.wallMs = at; this.lastNow = now; }
  at(now: number): number {
    const elapsed = Math.max(0, Math.min(1000, now - this.lastNow));
    return this.wallMs + (this.playing && !this.blocked ? elapsed * this.rate : 0);
  }
  tick(now: number): number {
    this.wallMs = this.at(now);
    this.lastNow = now;
    return this.wallMs;
  }
  seek(at: number, now: number): void { if (Number.isFinite(at)) this.wallMs = at; this.lastNow = now; }
  play(value: boolean, now: number): void { this.tick(now); this.playing = value; }
  block(value: boolean, now: number): void { this.tick(now); this.blocked = value; }
  speed(value: number, now: number): void { this.tick(now); if (SYNC_RATES.includes(value as typeof SYNC_RATES[number])) this.rate = value; }
}
export function needsSyncCorrection(actual: number, desired: number, now: number, lastCorrection: number): boolean {
  return Number.isFinite(actual) && Number.isFinite(desired) && Math.abs(actual - desired) > .5 && now - lastCorrection >= 800;
}
