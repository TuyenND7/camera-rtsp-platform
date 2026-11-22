import type { BrowserPlaybackState, RecordingDay } from '../src/api';

/** Recording-only fixtures: a real gap, a mapped archive, and a partial HEVC day. */
export function syncPreviewDay(cameraId: number, value: RecordingDay): RecordingDay {
  if (cameraId === 5) return { playlist: null, segments: [] };
  if (cameraId === 2) return { ...value, segments: value.segments.map((segment, index) => ({ ...segment,
    started_at: index === 2 ? new Date(Date.parse(segment.started_at!) + 40000).toISOString() : segment.started_at })) };
  if (cameraId === 3) return { ...value, day_playback: { original: value.day_playback!.original, archive: '/__ui-preview__/sample.mp4', duration_s: 120 },
    segments: value.segments.map(segment => ({ ...segment, archive_offset_s: segment.offset_s })) };
  if (cameraId === 4) return { ...value, segments: value.segments.map((segment, index) => ({ ...segment,
    archive_offset_s: index === 0 ? null : (index - 1) * 40 })) };
  return value;
}
const attempts = new Map<string, number>();
export function syncPreviewPrepared(cameraId: number, day: string, file: string): BrowserPlaybackState {
  const key = `${cameraId}/${day}/${file}`, count = attempts.get(key) ?? 0;
  attempts.set(key, count + 1);
  if (cameraId === 4 && count === 0) return { status: 'processing', playlist: null, start_position: null, error: null };
  return { status: 'ready', playlist: '/__ui-preview__/sample.mp4', start_position: 0, error: null };
}
