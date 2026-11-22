import type { SurveillanceNotice } from './api';

export const surveillanceKinds: Record<SurveillanceNotice['kind'], string> = {
  intrusion: 'Xâm nhập vùng', loitering: 'Lảng vảng', pacing: 'Đi qua lại', unfamiliar: 'Khuôn mặt chưa đăng ký',
  camera_offline: 'Camera mất kết nối', video_stalled: 'Luồng hình bị dừng', recording_stopped: 'Ghi hình gián đoạn',
  storage_error: 'Lỗi lưu trữ', resource_overload: 'Máy chủ quá tải',
};
export function isHealthNotice(notice: Pick<SurveillanceNotice,'kind'>): boolean {
  return ['camera_offline','video_stalled','recording_stopped','storage_error','resource_overload'].includes(notice.kind);
}
export function surveillanceDetail(notice: SurveillanceNotice): string {
  if (notice.message) return notice.message;
  const seconds = notice.metrics.visible_seconds ?? notice.metrics.dwell_seconds ?? notice.metrics.seconds;
  const suffix = notice.zone_name ? ` · ${notice.zone_name}` : '';
  if (notice.kind === 'loitering') return `${typeof seconds === 'number' ? `Ở trong vùng ${Math.round(seconds)} giây` : 'Ở lại trong vùng quá thời gian đã đặt'}${suffix}`;
  if (notice.kind === 'pacing') return `${typeof notice.metrics.reversals === 'number' ? `Đổi hướng ${notice.metrics.reversals} lần` : 'Đối tượng đổi hướng nhiều lần'}${suffix}`;
  if (notice.kind === 'unfamiliar') return `Chưa khớp với người đã đăng ký${suffix}`;
  return `Đối tượng xuất hiện trong vùng giám sát${suffix}`;
}
export function surveillancePlaybackUrl(notice: SurveillanceNotice): string {
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(notice.detected_at)).replace(/-/g, '');
  return `/playback/${notice.camera_id}?day=${day}&at=${encodeURIComponent(notice.detected_at)}`;
}
export function newerNoticeId(a: string, b: string): boolean {
  return /^\d+$/.test(a) && /^\d+$/.test(b) && BigInt(a) > BigInt(b);
}
export function consumeNoticeBatch(previous: string | null, batch: { latest_id: string; items: SurveillanceNotice[] }): { cursor: string; popups: SurveillanceNotice[] } {
  if (previous === null) return { cursor: /^\d+$/.test(batch.latest_id) ? batch.latest_id : '0', popups: [] };
  let cursor = previous;
  const received = batch.items.filter(item => newerNoticeId(item.id, previous));
  for (const item of received) if (newerNoticeId(item.id, cursor)) cursor = item.id;
  return { cursor, popups: received.filter(item => item.popup_enabled && !item.read)
    .sort((a, b) => newerNoticeId(a.id, b.id) ? 1 : a.id === b.id ? 0 : -1) };
}
export function appendPopupNotices(current: SurveillanceNotice[], incoming: SurveillanceNotice[]): SurveillanceNotice[] {
  const seen = new Set(current.map(item => item.id));
  return [...current, ...incoming.filter(item => { if (seen.has(item.id)) return false; seen.add(item.id); return true; })].slice(-3);
}
