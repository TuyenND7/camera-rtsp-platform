import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon';
import { useTheme } from './theme';
import { formatClock, formatShortClock, recordedRanges, segmentAt, TimedSegment } from './playbackTime';

interface ThumbInfo {
  width: number;
  height: number;
  interval_s: number;
}

interface Props {
  segments: TimedSegment[];
  /** 00:00 của ngày đang xem (ms). */
  dayStart: number;
  /** Vị trí đang phát (ms epoch), null khi chưa phát. */
  positionMs: number | null;
  thumb: ThumbInfo;
  /** Gọi khi thả tay/nhấn phím: ms đã được đưa về đoạn có ghi hình. */
  onSeek: (ms: number) => void;
  onTogglePlay?: () => void;
}

const HOUR = 3_600_000;
const MINUTE = 60_000;
/** Khoảng thời gian hiển thị trên toàn bộ chiều rộng timeline. */
const ZOOM_SPANS = [24 * HOUR, 12 * HOUR, 6 * HOUR, 2 * HOUR, HOUR, 30 * MINUTE, 10 * MINUTE];
const TICK_STEPS = [MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR];
const TRACK_HEIGHT = 72;
const PREVIEW_SCALE = 1.2;
const DRAG_THRESHOLD_PX = 4;

type Interaction =
  | { kind: 'idle' }
  | { kind: 'drag'; pointerId: number; startX: number; startCenter: number; moved: boolean; samples: Array<{ t: number; x: number }> }
  | { kind: 'fling' };

/**
 * Timeline kiểu app camera: vạch giữa cố định là thời điểm đang xem, kéo dải
 * thời gian sang trái/phải để tua, thả tay mới seek video. Có ảnh preview của
 * mốc đang kéo/hover, zoom bằng con lăn hoặc nút, và điều khiển bằng bàn phím.
 */
export default function PlaybackTimeline({ segments, dayStart, positionMs, thumb, onSeek, onTogglePlay }: Props) {
  const { textSize, theme } = useTheme();
  const textScale = textSize / 100;
  const labelOffset = Math.ceil((textScale - 1) * 16);
  const trackHeight = TRACK_HEIGHT + labelOffset;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [zoomIndex, setZoomIndex] = useState(3);
  const [dragCenter, setDragCenter] = useState<number | null>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const interaction = useRef<Interaction>({ kind: 'idle' });
  const flingFrame = useRef<number>();
  const wheelTimer = useRef<number>();

  const span = ZOOM_SPANS[zoomIndex];
  const ranges = useMemo(() => recordedRanges(segments), [segments]);
  const firstMs = segments[0]?.startMs ?? dayStart;
  const lastMs = segments[segments.length - 1]?.endMs ?? dayStart + 24 * HOUR;
  const minMs = Math.min(dayStart, firstMs);
  const maxMs = Math.max(dayStart + 24 * HOUR, lastMs);
  const clamp = useCallback((ms: number) => Math.min(maxMs, Math.max(minMs, ms)), [maxMs, minMs]);

  const center = dragCenter ?? positionMs ?? lastMs;
  const msPerPx = width > 0 ? span / width : 1;
  const xToMs = useCallback((x: number) => center + (x - width / 2) * msPerPx, [center, msPerPx, width]);

  // ---- Kích thước ----
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(() => setWidth(wrap.clientWidth));
    observer.observe(wrap);
    setWidth(wrap.clientWidth);
    return () => observer.disconnect();
  }, []);

  // ---- Vẽ ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(trackHeight * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, trackHeight);

    const viewStart = center - (width / 2) * msPerPx;
    const viewEnd = center + (width / 2) * msPerPx;
    const toX = (ms: number) => (ms - viewStart) / msPerPx;

    // Nền và vùng ngoài ngày đang xem
    ctx.fillStyle = '#e8eff8';
    ctx.fillRect(0, 30 + labelOffset, width, 26);
    ctx.fillStyle = 'rgba(36, 57, 79, 0.04)';
    if (viewStart < minMs) ctx.fillRect(0, 0, toX(minMs), trackHeight);
    if (viewEnd > maxMs) ctx.fillRect(toX(maxMs), 0, width - toX(maxMs), trackHeight);

    // Dải đã ghi hình
    ctx.fillStyle = '#72a8f4';
    for (const [start, end] of ranges) {
      if (end < viewStart || start > viewEnd) continue;
      const x = toX(start);
      ctx.fillRect(x, 30 + labelOffset, Math.max(1.5, toX(end) - x), 26);
    }

    // Vạch chia + nhãn giờ
    const labelStep = TICK_STEPS.find((step) => step / msPerPx >= 76 * textScale) ?? TICK_STEPS[TICK_STEPS.length - 1];
    const minorStep = labelStep / (labelStep >= HOUR ? 4 : 5);
    const tzOffset = new Date(center).getTimezoneOffset() * MINUTE;
    const firstTick = (value: number, step: number) => Math.ceil((value - tzOffset) / step) * step + tzOffset;
    ctx.strokeStyle = '#c0d0e2';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let ms = firstTick(viewStart, minorStep); ms <= viewEnd; ms += minorStep) {
      const x = Math.round(toX(ms)) + 0.5;
      ctx.moveTo(x, 22 + labelOffset);
      ctx.lineTo(x, 28 + labelOffset);
    }
    ctx.stroke();
    ctx.strokeStyle = '#8aa0ba';
    ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--text-muted').trim() || '#6a819c';
    ctx.font = `500 ${11 * textScale}px "Be Vietnam Pro", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.beginPath();
    for (let ms = firstTick(viewStart, labelStep); ms <= viewEnd; ms += labelStep) {
      const x = Math.round(toX(ms)) + 0.5;
      ctx.moveTo(x, 17 + labelOffset);
      ctx.lineTo(x, 28 + labelOffset);
      ctx.fillText(formatShortClock(ms), x, 13 + labelOffset);
    }
    ctx.stroke();
  }, [center, maxMs, minMs, msPerPx, ranges, width, textScale, trackHeight, labelOffset, theme]);

  // ---- Seek: đưa mốc về đoạn có ghi hình gần nhất phía sau ----
  const commit = useCallback((ms: number) => {
    const hit = segmentAt(segments, clamp(ms));
    if (!hit) return;
    const target = hit.inside ? ms : hit.segment.startMs;
    setDragCenter(null);
    onSeek(target);
  }, [clamp, onSeek, segments]);

  const stopFling = () => {
    if (flingFrame.current) cancelAnimationFrame(flingFrame.current);
    flingFrame.current = undefined;
  };

  useEffect(() => () => {
    stopFling();
    if (wheelTimer.current) window.clearTimeout(wheelTimer.current);
  }, []);

  // ---- Kéo bằng chuột/cảm ứng ----
  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || segments.length === 0) return;
    stopFling();
    event.currentTarget.setPointerCapture(event.pointerId);
    interaction.current = {
      kind: 'drag',
      pointerId: event.pointerId,
      startX: event.clientX,
      startCenter: center,
      moved: false,
      samples: [{ t: performance.now(), x: event.clientX }],
    };
    setDragCenter(center);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    setHoverX(event.clientX - rect.left);
    const state = interaction.current;
    if (state.kind !== 'drag' || state.pointerId !== event.pointerId) return;
    const dx = event.clientX - state.startX;
    if (Math.abs(dx) > DRAG_THRESHOLD_PX) state.moved = true;
    if (!state.moved) return;
    const now = performance.now();
    state.samples.push({ t: now, x: event.clientX });
    while (state.samples.length > 2 && now - state.samples[0].t > 100) state.samples.shift();
    setDragCenter(clamp(state.startCenter - dx * msPerPx));
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const state = interaction.current;
    if (state.kind !== 'drag' || state.pointerId !== event.pointerId) return;
    interaction.current = { kind: 'idle' };
    if (!state.moved) {
      // Bấm (không kéo): nhảy tới mốc dưới con trỏ.
      const rect = event.currentTarget.getBoundingClientRect();
      commit(state.startCenter + (event.clientX - rect.left - width / 2) * msPerPx);
      return;
    }
    // Vuốt nhanh: trượt tiếp theo quán tính rồi mới seek.
    const first = state.samples[0];
    const last = state.samples[state.samples.length - 1];
    const dt = last.t - first.t;
    const velocityPx = dt > 0 ? (last.x - first.x) / dt : 0; // px/ms
    const startCenter = clamp(state.startCenter - (event.clientX - state.startX) * msPerPx);
    if (Math.abs(velocityPx) < 0.3) {
      commit(startCenter);
      return;
    }
    interaction.current = { kind: 'fling' };
    let value = startCenter;
    let velocity = -velocityPx * msPerPx; // ms timeline mỗi ms thực
    let previous = performance.now();
    const step = (now: number) => {
      const elapsed = now - previous;
      previous = now;
      value = clamp(value + velocity * elapsed);
      velocity *= Math.pow(0.994, elapsed);
      setDragCenter(value);
      if (Math.abs(velocity) * 16 > msPerPx * 0.5 && value > minMs && value < maxMs) {
        flingFrame.current = requestAnimationFrame(step);
      } else {
        flingFrame.current = undefined;
        interaction.current = { kind: 'idle' };
        commit(value);
      }
    };
    flingFrame.current = requestAnimationFrame(step);
  }

  function onPointerCancel() {
    if (interaction.current.kind === 'drag') {
      interaction.current = { kind: 'idle' };
      setDragCenter(null);
    }
  }

  // ---- Con lăn: dọc = zoom, ngang (touchpad) = tua ----
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (event: WheelEvent) => {
      if (segments.length === 0) return;
      event.preventDefault();
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        stopFling();
        const base = dragCenter ?? center;
        const next = clamp(base + event.deltaX * msPerPx);
        setDragCenter(next);
        if (wheelTimer.current) window.clearTimeout(wheelTimer.current);
        wheelTimer.current = window.setTimeout(() => commit(next), 350);
        return;
      }
      if (event.deltaY === 0) return;
      setZoomIndex((index) => Math.min(ZOOM_SPANS.length - 1, Math.max(0, index + (event.deltaY < 0 ? 1 : -1))));
    };
    wrap.addEventListener('wheel', onWheel, { passive: false });
    return () => wrap.removeEventListener('wheel', onWheel);
  }, [center, clamp, commit, dragCenter, msPerPx, segments.length]);

  // ---- Bàn phím ----
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const base = positionMs ?? lastMs;
    const jump = event.shiftKey ? MINUTE : 10_000;
    switch (event.key) {
      case 'ArrowLeft': commit(base - jump); break;
      case 'ArrowRight': commit(base + jump); break;
      case 'Home': commit(firstMs); break;
      case 'End': commit(Math.max(firstMs, lastMs - 30_000)); break;
      case '+': case '=': setZoomIndex((index) => Math.min(ZOOM_SPANS.length - 1, index + 1)); break;
      case '-': case '_': setZoomIndex((index) => Math.max(0, index - 1)); break;
      case ' ': case 'k': onTogglePlay?.(); break;
      default: return;
    }
    event.preventDefault();
  }

  // ---- Preview ----
  const dragging = dragCenter !== null;
  const previewMs = dragging ? dragCenter : hoverX !== null ? xToMs(hoverX) : null;
  const previewX = dragging ? width / 2 : hoverX ?? 0;
  const preview = previewMs !== null ? previewFor(segments, previewMs, thumb) : null;
  const previewWidth = thumb.width * PREVIEW_SCALE;
  const previewLeft = Math.min(Math.max(previewX, previewWidth / 2 + 4), Math.max(previewWidth / 2 + 4, width - previewWidth / 2 - 4));

  return (
    <div className="pt-root">
      <div className="pt-toolbar">
        <span className="pt-readout" aria-live="off">{positionMs !== null || dragging ? formatClock(center) : '--:--:--'}</span>
        <div className="pt-zoom" role="group" aria-label="Thu phóng timeline">
          <button type="button" onClick={() => setZoomIndex((index) => Math.max(0, index - 1))} disabled={zoomIndex === 0} title="Thu nhỏ (−)"><Icon name="zoomOut" size={17} /></button>
          <span>{formatSpan(span)}</span>
          <button type="button" onClick={() => setZoomIndex((index) => Math.min(ZOOM_SPANS.length - 1, index + 1))} disabled={zoomIndex === ZOOM_SPANS.length - 1} title="Phóng to (+)"><Icon name="zoomIn" size={17} /></button>
        </div>
      </div>
      <div
        ref={wrapRef}
        className={`pt-track ${dragging ? 'dragging' : ''}`}
        role="slider"
        tabIndex={0}
        aria-label="Timeline playback — kéo để tua, mũi tên để tua 10 giây"
        aria-valuemin={minMs}
        aria-valuemax={maxMs}
        aria-valuenow={Math.round(center)}
        aria-valuetext={formatClock(center)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={() => setHoverX(null)}
        onKeyDown={onKeyDown}
      >
        <canvas ref={canvasRef} style={{ width: '100%', height: trackHeight }} />
        <div className="pt-playhead" aria-hidden="true"><span /></div>
        {preview && (
          <div className="pt-preview" style={{ left: previewLeft, width: previewWidth }} aria-hidden="true">
            <div className="pt-preview-image" style={{ height: thumb.height * PREVIEW_SCALE, ...preview.style }}>
              {!preview.style.backgroundImage && <span>{preview.recorded ? 'Đang tạo ảnh…' : 'Không ghi hình'}</span>}
            </div>
            <b>{formatClock(previewMs as number)}</b>
          </div>
        )}
      </div>
    </div>
  );
}

function previewFor(segments: TimedSegment[], ms: number, thumb: ThumbInfo) {
  const hit = segmentAt(segments, ms);
  if (!hit || !hit.inside) return { recorded: false, style: {} as React.CSSProperties };
  const { segment } = hit;
  if (!segment.thumb_url) return { recorded: true, style: {} as React.CSSProperties };
  const tile = Math.min(segment.thumb_tiles - 1, Math.max(0, Math.floor((ms - segment.startMs) / 1000 / thumb.interval_s)));
  const w = thumb.width * PREVIEW_SCALE;
  return {
    recorded: true,
    style: {
      backgroundImage: `url(${segment.thumb_url})`,
      backgroundSize: `${segment.thumb_tiles * w}px ${thumb.height * PREVIEW_SCALE}px`,
      backgroundPosition: `${-tile * w}px 0`,
    } as React.CSSProperties,
  };
}

function formatSpan(span: number): string {
  return span >= HOUR ? `${span / HOUR} giờ` : `${span / MINUTE} phút`;
}
