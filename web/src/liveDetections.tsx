import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { api, type LiveDetectionState, type DetectionFrame, type FaceIdentity, type SurveillanceZone } from './api';
import { useSurveillance, type PinSelection } from './surveillanceContext';
import Icon from './Icon';

const LiveContext = createContext<Map<number, LiveDetectionState>>(new Map());
export function LiveAiProvider({ cameraIds, children }: { cameraIds: number[]; children: React.ReactNode }) {
  const [items, setItems] = useState<Map<number, LiveDetectionState>>(new Map());
  const key = [...cameraIds].sort((a, b) => a - b).join(',');
  useEffect(() => {
    let active = true, timer: number | undefined, timeout: number | undefined, controller: AbortController | undefined;
    const selected = new Set(key.split(',').map(Number));
    setItems(value => new Map([...value].filter(([id]) => selected.has(id))));
    const poll = async () => {
      if (!active || !key) return;
      if (!document.hidden) {
        controller = new AbortController(); timeout = window.setTimeout(() => controller?.abort(), 5000);
        try {
          const values = await api.liveDetections(key.split(',').map(Number), controller.signal);
          if (active) setItems(new Map(values.map(value => [value.camera_id, normalizeDetectionClock(value)])));
        } catch { if (active) setItems(new Map()); }
        finally { window.clearTimeout(timeout); }
      }
      if (active) timer = window.setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => { active = false; controller?.abort(); window.clearTimeout(timer); window.clearTimeout(timeout); };
  }, [key]);
  return <LiveContext.Provider value={items}>{children}</LiveContext.Provider>;
}

export function normalizeDetectionClock(value: LiveDetectionState, now = Date.now()): LiveDetectionState {
  // Video/frame timestamps share the server clock. Only freshness uses the
  // viewer's clock, which may differ by minutes on a tablet or Windows host.
  return { ...value, updated_at: Number.isFinite(value.server_time) ? now - Math.max(0, value.server_time - value.updated_at) : value.updated_at };
}

export function selectDetectionFrame(value: LiveDetectionState | undefined, at: number | null, now = Date.now()): DetectionFrame | null {
  if (!value || value.state !== 'ready' || !value.synchronized || at === null || now - value.updated_at > 12000) return null;
  const frames = value.frames.filter(frame => frame.at <= at && at - frame.at <= value.frame_ttl_ms);
  return frames[frames.length - 1] ?? null;
}

export function LiveDetectionOverlay({ cameraId, at, enabled, focusTrackId }: { cameraId: number; at: number | null; enabled: boolean; focusTrackId?: string }) {
  const state = useContext(LiveContext).get(cameraId);
  const surveillance = useSurveillance(), [pending, setPending] = useState<string | null>(null), [error, setError] = useState('');
  const pinned = new Set(surveillance?.pins.filter(pin => pin.camera_id === cameraId).map(pin => pin.track_id) ?? []);
  const canPin = !!surveillance?.canManage && state?.manual_pin_enabled !== false;
  async function pin(value: PinSelection) {
    if (!surveillance || pending) return;
    setPending(value.track_id); setError('');
    try { await surveillance.pin(value); }
    catch (error) { setError(error instanceof Error ? error.message : 'Chưa ghim được đối tượng.'); }
    finally { setPending(null); }
  }
  useEffect(() => { if (!error) return; const timer = window.setTimeout(() => setError(''), 6000); return () => window.clearTimeout(timer); }, [error]);
  return <><DetectionBoxes frame={enabled ? selectDetectionFrame(state, at) : null} cameraId={cameraId} zones={state?.zones} onPin={canPin ? value => void pin(value) : undefined} onWatch={surveillance ? trackId => surveillance.watch({ cameraId, trackId, pin: surveillance.pins.find(pin => pin.camera_id === cameraId && pin.track_id === trackId) }) : undefined} pinned={pinned} pending={pending} focusTrackId={focusTrackId} />{error && <p className="surveillance-overlay-error" role="alert">{error}</p>}</>;
}
const labels: Record<string, string> = { person: 'Người', cat: 'Mèo', dog: 'Chó', car: 'Ô tô', motorcycle: 'Xe máy', bicycle: 'Xe đạp', truck: 'Xe tải', bus: 'Xe buýt' };
export function identityClass(detection: { label: string; identity?: FaceIdentity }): string {
  const face = detection.label === 'person' ? detection.identity : undefined;
  return !face ? '' : face.state === 'known' && face.name ? ' identity-known' : ' identity-unknown';
}
export function detectionLabel(detection: { label: string; track_number?: number; identity?: FaceIdentity }): string {
  const number = detection.track_number;
  const face = detection.label === 'person' ? detection.identity : undefined;
  const identityLabel = face?.state === 'known' && face.name ? face.name : face?.state === 'not_visible' ? 'Chưa rõ mặt' : face?.state === 'pending' ? 'Đang đối chiếu' : face?.state === 'unavailable' ? 'Định danh chưa sẵn sàng' : face ? 'Chưa định danh' : undefined;
  return `${identityLabel ?? labels[detection.label] ?? detection.label} · ${typeof number === 'number' && Number.isInteger(number) && number > 0 ? `ID #${number}` : 'Chưa có ID'}`;
}
export function DetectionBoxes({ frame, cameraId, onPin, onWatch, pinned = new Set(), pending, focusTrackId, zones = [] }: {
  frame: DetectionFrame | null; cameraId?: number; onPin?: (value: PinSelection) => void; onWatch?: (trackId: string) => void;
  pinned?: Set<string>; pending?: string | null; focusTrackId?: string; zones?: SurveillanceZone[];
}) {
  const layer = useRef<HTMLDivElement>(null), [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = layer.current; if (!element) return;
    const resize = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    resize(); const observer = new ResizeObserver(resize); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const scale = frame ? Math.min(size.width / frame.width, size.height / frame.height) : 0;
  const left = frame ? (size.width - frame.width * scale) / 2 : 0, top = frame ? (size.height - frame.height * scale) / 2 : 0;
  return <div className="detection-layer" ref={layer} aria-hidden={onPin || onWatch ? undefined : true} data-ai-detections={frame?.detections.length ?? 0}>
    {scale > 0 && frame && !!zones.length && <svg className="surveillance-zone-layer" aria-hidden="true" viewBox="0 0 1000 1000" preserveAspectRatio="none" style={{ left, top, width: frame.width * scale, height: frame.height * scale }}>{zones.map(zone => <polygon key={zone.id} points={zone.points.map(([x, y]) => `${x * 1000},${y * 1000}`).join(' ')} />)}</svg>}
    {scale > 0 && frame?.detections.map((detection, index) => {
      const [x1, y1, x2, y2] = detection.box;
      const isPinned = !!detection.track_id && pinned.has(detection.track_id);
      const interactive = !!cameraId && !!detection.track_id && !!detection.track_number && (isPinned ? !!onWatch : !!onPin);
      const rightAligned = left + x1 * scale > size.width / 2;
      const labelWidth = Math.max(44, Math.min(260, rightAligned ? left + x2 * scale : size.width - left - x1 * scale));
      return <div key={detection.track_id ?? index} className={`detection-box${identityClass(detection)}${isPinned ? ' object-pinned' : ''}${focusTrackId && focusTrackId === detection.track_id ? ' object-focused' : ''}`} style={{ left: left + x1 * scale, top: top + y1 * scale, width: (x2 - x1) * scale, height: (y2 - y1) * scale }}><span className={`${y1 * scale < (interactive ? 46 : 22) ? 'inside' : ''}${interactive ? ' interactive-label' : ''}${rightAligned ? ' label-right' : ''}`} style={{ maxWidth: labelWidth }}><b className="detection-box-label-text">{detectionLabel(detection)}{!detection.identity && ` ${Math.round(detection.confidence * 100)}%`}</b>{interactive && <button type="button" disabled={pending === detection.track_id} aria-label={`${isPinned ? 'Theo dõi' : 'Ghim theo dõi'} ID ${detection.track_number}`} title={isPinned ? 'Đang ghim · mở theo dõi' : 'Ghim đối tượng này để theo dõi'} onClick={event => {
        event.stopPropagation();
        if (isPinned) onWatch?.(detection.track_id!);
        else onPin?.({ camera_id: cameraId!, track_id: detection.track_id!, track_number: detection.track_number!, label: detection.label });
      }}><Icon name={isPinned ? 'check' : 'shield'} size={17} /></button>}</span></div>;
    })}
  </div>;
}
