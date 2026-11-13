import { api, type DeviceControls } from './api';

export const alarmDurations = [10, 15, 30, 60, 0];
export const alarmDurationLabel = (seconds: number) => seconds === 0 ? 'Đến khi người dùng tắt' : `${seconds} giây`;
export const alarmIsActive = (state?: DeviceControls) => !!state && (state.alarm_command_active === true || state.alarm_active === true || !!state.ends_at);
export async function currentAlarmDuration() {
  const info = await api.getSettings(), seconds = info.settings.alarm_duration_seconds ?? 30;
  if (!alarmDurations.includes(seconds)) throw new Error('Thời lượng báo động chưa hợp lệ. Kiểm tra trong Cài đặt.');
  return seconds;
}
