import { pool } from '../db';
import type { SurveillanceConfig } from '../detections/surveillance';

export const profileModes = ['manual', 'home', 'away', 'night'] as const;
export type ProfileMode = typeof profileModes[number];
export type ProfileOverride = Partial<Pick<SurveillanceConfig, 'intrusion_enabled' | 'loitering_enabled' | 'pacing_enabled' | 'unfamiliar_enabled' | 'popup_enabled'>>;
export interface OperatingProfile { notifications_enabled: boolean; cameras: Record<string, ProfileOverride> }
export interface WeeklyProfile { id: string; days: number[]; start: string; end: string; mode: Exclude<ProfileMode, 'manual'> }
export interface ProfileSettings {
  timezone: string; control: 'manual' | 'schedule'; manual_mode: ProfileMode; fallback_mode: ProfileMode;
  profiles: Record<Exclude<ProfileMode, 'manual'>, OperatingProfile>; schedules: WeeklyProfile[];
}
export interface ProfileRuntime {
  mode: ProfileMode; source: 'manual' | 'schedule' | 'fallback'; camera_overrides: Record<string, ProfileOverride>;
  notifications_enabled: boolean; settings_revision: number; updated_at: string;
}
const flags = ['intrusion_enabled', 'loitering_enabled', 'pacing_enabled', 'unfamiliar_enabled', 'popup_enabled'];
export const defaultProfileSettings = (): ProfileSettings => ({ timezone: 'Asia/Ho_Chi_Minh', control: 'manual', manual_mode: 'manual', fallback_mode: 'manual',
  profiles: { home: { notifications_enabled: true, cameras: {} }, away: { notifications_enabled: true, cameras: {} }, night: { notifications_enabled: true, cameras: {} } }, schedules: [] });
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k)) && keys.every(k => Object.prototype.hasOwnProperty.call(v, k));
export const validTimezone = (v: unknown): v is string => {
  if (typeof v !== 'string' || v.length > 64) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: v }).format(); return true; } catch { return false; }
};
export const clockMinutes = (v: unknown): number | null => typeof v === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v) ? Number(v.slice(0, 2)) * 60 + Number(v.slice(3)) : null;
export function localClock(at: Date, timezone: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(at);
  const field = (name: string) => parts.find(p => p.type === name)?.value ?? '';
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(field('weekday')), minute: Number(field('hour')) * 60 + Number(field('minute')) };
}

/** Weekly wall-clock intervals; overnight belongs to its starting weekday. */
export function weeklyIntervals(schedule: WeeklyProfile): Array<[number, number]> {
  const start = clockMinutes(schedule.start)!, finish = clockMinutes(schedule.end)!;
  return schedule.days.flatMap(day => {
    const from = day * 1440 + start, to = day * 1440 + finish + (finish < start ? 1440 : 0);
    return to <= 10080 ? [[from, to] as [number, number]] : [[from, 10080] as [number, number], [0, to - 10080] as [number, number]];
  });
}
export class ProfileError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export function validateProfileSettings(raw: unknown): ProfileSettings {
  if (!object(raw) || !exact(raw, ['timezone', 'control', 'manual_mode', 'fallback_mode', 'profiles', 'schedules']) || !validTimezone(raw.timezone) ||
    !['manual', 'schedule'].includes(raw.control) || !profileModes.includes(raw.manual_mode) || !profileModes.includes(raw.fallback_mode) ||
    !object(raw.profiles) || !exact(raw.profiles, ['home', 'away', 'night']) || !Array.isArray(raw.schedules) || raw.schedules.length > 28) throw new ProfileError('Cấu hình chế độ không hợp lệ.');
  for (const profile of Object.values(raw.profiles)) {
    if (!object(profile) || !exact(profile, ['notifications_enabled', 'cameras']) || typeof profile.notifications_enabled !== 'boolean' || !object(profile.cameras) || Object.keys(profile.cameras).length > 64) throw new ProfileError('Cấu hình camera theo chế độ không hợp lệ.');
    for (const [id, value] of Object.entries(profile.cameras)) {
      if (!/^[1-9]\d{0,9}$/.test(id) || Number(id) > 2147483647 || !object(value) || Object.keys(value).some(key => !flags.includes(key) || typeof value[key] !== 'boolean')) throw new ProfileError('Chỉ được thay đổi quy tắc nhận dạng và popup.');
    }
  }
  const spans: Array<[number, number]> = [], ids = new Set<string>();
  for (const item of raw.schedules) {
    if (!object(item) || !exact(item, ['id', 'days', 'start', 'end', 'mode']) || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(item.id) || ids.has(item.id) ||
      !Array.isArray(item.days) || !item.days.length || item.days.length > 7 || new Set(item.days).size !== item.days.length || item.days.some((d: unknown) => !Number.isInteger(d) || Number(d) < 0 || Number(d) > 6) ||
      clockMinutes(item.start) === null || clockMinutes(item.end) === null || item.start === item.end || !['home', 'away', 'night'].includes(item.mode)) throw new ProfileError('Chọn ngày, giờ bắt đầu/kết thúc khác nhau và chế độ cho lịch.');
    ids.add(item.id);
    for (const span of weeklyIntervals(item as WeeklyProfile)) {
      if (spans.some(old => span[0] < old[1] && old[0] < span[1])) throw new ProfileError('Các lịch đang trùng giờ, kể cả phần qua nửa đêm.');
      spans.push(span);
    }
  }
  return JSON.parse(JSON.stringify(raw)) as ProfileSettings;
}

export function resolveProfile(settings: ProfileSettings, at = new Date(), revision = 1): ProfileRuntime {
  let mode = settings.manual_mode, source: ProfileRuntime['source'] = 'manual';
  if (settings.control === 'schedule') {
    const clock = localClock(at, settings.timezone), minute = clock.day * 1440 + clock.minute;
    const current = settings.schedules.find(s => weeklyIntervals(s).some(([start, end]) => minute >= start && minute < end));
    mode = current?.mode ?? settings.fallback_mode; source = current ? 'schedule' : 'fallback';
  }
  const profile = mode === 'manual' ? undefined : settings.profiles[mode];
  return { mode, source, camera_overrides: profile?.cameras ?? {}, notifications_enabled: profile?.notifications_enabled ?? true, settings_revision: revision, updated_at: at.toISOString() };
}

let cache = resolveProfile(defaultProfileSettings()), refreshedAt = 0;
function acceptRuntime(runtime: ProfileRuntime) {
  if (runtime.settings_revision >= cache.settings_revision) { cache = runtime; refreshedAt = Date.now(); }
}
export function effectiveProfilePolicy(cameraId: number, base: SurveillanceConfig): SurveillanceConfig { return { ...base, ...(cache.camera_overrides[String(cameraId)] ?? {}) }; }
export function profileNotificationsAllowed(): boolean { return refreshedAt > 0 && Date.now() - refreshedAt < 60_000 && cache.notifications_enabled; }
export function currentProfileRuntime(): ProfileRuntime { return JSON.parse(JSON.stringify(cache)); }

type Queryable = { query: (sql: string, values?: any[]) => Promise<any> };
async function writeRuntime(client: Queryable, settings: ProfileSettings, revision: number): Promise<ProfileRuntime> {
  const next = resolveProfile(settings, new Date(), revision);
  const { rows } = await client.query(`INSERT INTO operating_profile_runtime (id,mode,source,camera_overrides,notifications_enabled,settings_revision,updated_at)
    VALUES (1,$1,$2,$3::jsonb,$4,$5,clock_timestamp()) ON CONFLICT(id) DO UPDATE SET mode=EXCLUDED.mode,source=EXCLUDED.source,
    camera_overrides=EXCLUDED.camera_overrides,notifications_enabled=EXCLUDED.notifications_enabled,settings_revision=EXCLUDED.settings_revision,updated_at=EXCLUDED.updated_at RETURNING *`,
    [next.mode, next.source, JSON.stringify(next.camera_overrides), next.notifications_enabled, revision]);
  return { ...next, updated_at: new Date(rows[0].updated_at).toISOString() };
}
async function ensureSettings(client: Queryable) {
  await client.query('INSERT INTO operating_profile_settings (id,value) VALUES (1,$1::jsonb) ON CONFLICT DO NOTHING', [JSON.stringify(defaultProfileSettings())]);
}
export async function operatingProfilesSnapshot() {
  await ensureSettings(pool);
  const [{ rows }, cameras] = await Promise.all([pool.query('SELECT value,revision FROM operating_profile_settings WHERE id=1'), pool.query('SELECT id,name FROM cameras ORDER BY id')]);
  return { settings: validateProfileSettings(rows[0].value), revision: rows[0].revision, runtime: currentProfileRuntime(), cameras: cameras.rows };
}
export async function saveOperatingProfiles(value: ProfileSettings, expected: number | undefined, userId: number) {
  const settings = validateProfileSettings(value), client = await pool.connect();
  let runtime: ProfileRuntime;
  try {
    await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(731923,4)'); await ensureSettings(client);
    const { rows } = await client.query('SELECT revision FROM operating_profile_settings WHERE id=1 FOR UPDATE');
    if (expected !== undefined && expected !== rows[0].revision) throw new ProfileError('Cấu hình đã thay đổi trên thiết bị khác. Đọc lại trước khi lưu.', 409);
    const revision = rows[0].revision + 1;
    await client.query('UPDATE operating_profile_settings SET value=$1::jsonb,revision=$2,updated_at=now(),updated_by=$3 WHERE id=1', [JSON.stringify(settings), revision, userId]);
    runtime = await writeRuntime(client, settings, revision); await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  acceptRuntime(runtime!);
  return operatingProfilesSnapshot();
}
export async function selectOperatingMode(mode: ProfileMode, userId: number) {
  const current = await operatingProfilesSnapshot();
  return saveOperatingProfiles({ ...current.settings, control: 'manual', manual_mode: mode }, current.revision, userId);
}
export async function refreshOperatingProfiles(): Promise<void> {
  const client = await pool.connect(); let runtime: ProfileRuntime;
  try {
    await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(731923,4)'); await ensureSettings(client);
    const { rows } = await client.query('SELECT value,revision FROM operating_profile_settings WHERE id=1');
    runtime = await writeRuntime(client, validateProfileSettings(rows[0].value), rows[0].revision); await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  acceptRuntime(runtime!);
}
export async function startOperatingProfiles(): Promise<{ stop(): void }> {
  await refreshOperatingProfiles(); let busy = false;
  const timer = setInterval(() => {
    if (busy) return; busy = true;
    void refreshOperatingProfiles().catch(() => console.warn('[profiles] schedule refresh unavailable')).finally(() => { busy = false; });
  }, 15000);
  timer.unref(); return { stop: () => clearInterval(timer) };
}
