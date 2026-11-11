import type { RecordingSegment } from './api';

/** Segment có mốc thời gian thực (ms epoch) để đặt lên timeline. */
export interface TimedSegment extends RecordingSegment {
  startMs: number;
  endMs: number;
}

export interface SegmentHit {
  segment: TimedSegment;
  index: number;
  /** false = ms rơi vào khoảng không ghi hình, segment là đoạn kế tiếp. */
  inside: boolean;
}

export function toTimedSegments(segments: RecordingSegment[]): TimedSegment[] {
  return segments
    .filter((segment) => segment.started_at)
    .map((segment) => {
      const startMs = Date.parse(segment.started_at as string);
      return { ...segment, startMs, endMs: startMs + segment.duration_s * 1000 };
    })
    .filter((segment) => Number.isFinite(segment.startMs))
    .sort((a, b) => a.startMs - b.startMs);
}

/** Segment chứa ms, hoặc segment kế tiếp nếu ms nằm trong khoảng trống. */
export function segmentAt(segments: TimedSegment[], ms: number): SegmentHit | null {
  if (segments.length === 0) return null;
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].startMs <= ms) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found >= 0 && ms < segments[found].endMs) return { segment: segments[found], index: found, inside: true };
  const next = found + 1;
  if (next < segments.length) return { segment: segments[next], index: next, inside: false };
  return { segment: segments[segments.length - 1], index: segments.length - 1, inside: false };
}

/** Gộp segment liền nhau (lệch < gapMs) thành dải ghi hình để vẽ timeline. */
export function recordedRanges(segments: TimedSegment[], gapMs = 5000): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const segment of segments) {
    const last = ranges[ranges.length - 1];
    if (last && segment.startMs - last[1] <= gapMs) last[1] = Math.max(last[1], segment.endMs);
    else ranges.push([segment.startMs, segment.endMs]);
  }
  return ranges;
}

/** 00:00 giờ địa phương của thư mục ngày YYYYMMDD. */
export function dayStartMs(day: string): number {
  return new Date(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8))).getTime();
}

const clockFormat = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const shortFormat = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });

export function formatClock(ms: number): string {
  return clockFormat.format(ms);
}

export function formatShortClock(ms: number): string {
  return shortFormat.format(ms);
}
