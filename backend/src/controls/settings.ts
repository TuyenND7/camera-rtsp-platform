export const settingValues = {
  flash_light: [0, 1],
  night_vision: [0, 2, 3], infrared: [0, 1, 2], image_flip: [0, 1], indicator: [0, 1], anti_flicker: [50, 60], privacy: [0, 1],
  motion_detection: [0, 1], motion_sensitivity: [1, 2, 3], tdsee_notifications: [0, 1], alarm_sound: [0, 1], alarm_light: [0, 1],
  sd_recording: [0, 1, 2], intercom: [1, 2], microphone_volume: Array.from({ length: 101 }, (_, i) => i), speaker_volume: Array.from({ length: 101 }, (_, i) => i),
} satisfies Record<string, number[]>;
export type DeviceSettingKey = keyof typeof settingValues;
export type DeviceSettingsChange = { revision: string; changes: Partial<Record<DeviceSettingKey, number>> };
export interface DeviceSettingsSnapshot {
  revision: string;
  values: Partial<Record<DeviceSettingKey, number>>;
  options: Partial<Record<DeviceSettingKey, number[]>>;
  info: { firmware?: string; timezone?: string; StorageStatus?: number; StorageTotalCapacity?: number; StorageRemainCapacity?: number; SignalStrength?: number };
}
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const known = (key: string): key is DeviceSettingKey => Object.prototype.hasOwnProperty.call(settingValues, key);
export function validateDeviceSettingsChange(value: unknown): DeviceSettingsChange | null {
  const body = record(value), changes = record(body.changes), entries = Object.entries(changes);
  if (Object.keys(body).some(key => !['revision', 'changes'].includes(key)) || typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision) || !entries.length || entries.length > Object.keys(settingValues).length) return null;
  if (entries.some(([key, item]) => !known(key) || !Number.isInteger(item) || !settingValues[key].includes(item))) return null;
  return { revision: body.revision, changes };
}
/** Filter SDK state again at the HTTP boundary. No arbitrary device properties leave IPC. */
export function deviceSettingsSnapshot(raw: unknown): DeviceSettingsSnapshot | undefined {
  const state = record(raw);
  if (typeof state.revision !== 'string' || !/^[a-f0-9]{64}$/.test(state.revision)) return;
  const values: DeviceSettingsSnapshot['values'] = {}, options: DeviceSettingsSnapshot['options'] = {}, sourceValues = record(state.values), sourceOptions = record(state.options);
  for (const key of Object.keys(settingValues) as DeviceSettingKey[]) {
    const value = sourceValues[key], allowed = sourceOptions[key];
    if (!Number.isInteger(value) || !settingValues[key].includes(value) || !Array.isArray(allowed) || allowed.length > 101) continue;
    const safe = [...new Set(allowed.filter((v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && settingValues[key].includes(v)))];
    if (!safe.includes(value)) continue;
    values[key] = value; options[key] = safe;
  }
  const info: DeviceSettingsSnapshot['info'] = {}, source = record(state.info);
  if (typeof source.firmware === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(source.firmware)) info.firmware = source.firmware;
  if (typeof source.timezone === 'string' && /^[+-]\d{2}:\d{2}$/.test(source.timezone)) info.timezone = source.timezone;
  for (const key of ['StorageStatus', 'StorageTotalCapacity', 'StorageRemainCapacity', 'SignalStrength'] as const) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= (key === 'SignalStrength' ? -200 : 0) && value <= (key === 'SignalStrength' ? 200 : key === 'StorageStatus' ? 3 : 2147483647)) info[key] = value;
  }
  return { revision: state.revision, values, options, info };
}
