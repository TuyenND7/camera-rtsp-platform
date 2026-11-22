import { featureRequest } from './api';

export type ProfileMode = 'manual' | 'home' | 'away' | 'night';
export type ProfileFlag = 'intrusion_enabled' | 'loitering_enabled' | 'pacing_enabled' | 'unfamiliar_enabled' | 'popup_enabled';
export type ProfileOverride = Partial<Record<ProfileFlag, boolean>>;
export interface OperatingProfile { notifications_enabled: boolean; cameras: Record<string, ProfileOverride> }
export interface WeeklyProfile { id: string; days: number[]; start: string; end: string; mode: Exclude<ProfileMode, 'manual'> }
export interface ProfileSettings {
  timezone: string; control: 'manual' | 'schedule'; manual_mode: ProfileMode; fallback_mode: ProfileMode;
  profiles: Record<Exclude<ProfileMode, 'manual'>, OperatingProfile>; schedules: WeeklyProfile[];
}
export interface ProfileSnapshot {
  settings: ProfileSettings; revision: number; runtime: { mode: ProfileMode; source: 'manual' | 'schedule' | 'fallback'; camera_overrides: Record<string, ProfileOverride>; notifications_enabled: boolean; settings_revision: number; updated_at: string };
  cameras: Array<{ id: number; name: string }>;
}
export interface PushPreferences { enabled: boolean; timezone: string; quiet_enabled: boolean; quiet_start: string; quiet_end: string; snooze_until: string | null }
export interface PushDevice { id: string; name: string; current_session: boolean; endpoint_fingerprint: string; expires_at: string; created_at: string; last_success_at: string | null; last_error: string | null }
export interface PushSnapshot { vapid_public_key: string; preferences: PushPreferences; devices: PushDevice[]; profile_notifications_enabled: boolean }
export const operationsApi = {
  profiles: () => featureRequest<ProfileSnapshot>('/operations/profiles'),
  saveProfiles: (revision: number, settings: ProfileSettings) => featureRequest<ProfileSnapshot>('/operations/profiles', { method: 'PUT', body: JSON.stringify({ revision, settings }) }),
  selectMode: (mode: ProfileMode) => featureRequest<ProfileSnapshot>('/operations/profiles/mode', { method: 'POST', body: JSON.stringify({ mode }) }),
  push: () => featureRequest<PushSnapshot>('/operations/push'),
  registerPush: (subscription: PushSubscriptionJSON, name: string) => featureRequest<PushSnapshot>('/operations/push/subscriptions', { method: 'POST', body: JSON.stringify({ subscription, name }) }),
  deletePush: (id: string) => featureRequest<{ ok: boolean }>(`/operations/push/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  savePushPreferences: (value: Partial<Omit<PushPreferences, 'snooze_until'>>) => featureRequest<PushSnapshot>('/operations/push/preferences', { method: 'PUT', body: JSON.stringify(value) }),
  snoozePush: (minutes: number) => featureRequest<PushSnapshot>('/operations/push/snooze', { method: 'POST', body: JSON.stringify({ minutes }) }),
  testPush: (device_id: string) => featureRequest<{ accepted: boolean }>('/operations/push/test', { method: 'POST', body: JSON.stringify({ device_id }) }),
};
export const profileNames: Record<ProfileMode, string> = { manual: 'Theo camera', home: 'Ở nhà', away: 'Vắng nhà', night: 'Ban đêm' };
export const operatingTimezones = (selected: string) => [...new Set([selected, Intl.DateTimeFormat().resolvedOptions().timeZone, 'Asia/Ho_Chi_Minh', 'Asia/Bangkok', 'Asia/Tokyo', 'Europe/London', 'America/New_York', 'UTC'])].filter(Boolean);
export const operatingTimes = (selected: string[] = []) => [...new Set([...Array.from({ length: 48 }, (_, n) => `${String(Math.floor(n / 2)).padStart(2, '0')}:${n % 2 ? '30' : '00'}`), ...selected])].sort();
