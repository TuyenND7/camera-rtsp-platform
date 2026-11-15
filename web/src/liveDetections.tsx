import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { api, type LiveDetectionState, type DetectionFrame } from './api';

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

export function LiveDetectionOverlay({ cameraId, at, enabled }: { cameraId: number; at: number | null; enabled: boolean }) {
  const state = useContext(LiveContext).get(cameraId);
  return <DetectionBoxes frame={enabled ? selectDetectionFrame(state, at) : null} />;
}
const labels: Record<string, string> = { person: 'Người', cat: 'Mèo', dog: 'Chó', car: 'Ô tô', motorcycle: 'Xe máy', bicycle: 'Xe đạp', truck: 'Xe tải', bus: 'Xe buýt' };
export function DetectionBoxes({ frame }: { frame: DetectionFrame | null }) {
  const layer = useRef<HTMLDivElement>(null), [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = layer.current; if (!element) return;
    const resize = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    resize(); const observer = new ResizeObserver(resize); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const scale = frame ? Math.min(size.width / frame.width, size.height / frame.height) : 0;
  const left = frame ? (size.width - frame.width * scale) / 2 : 0, top = frame ? (size.height - frame.height * scale) / 2 : 0;
  return <div className="detection-layer" ref={layer} aria-hidden="true" data-ai-detections={frame?.detections.length ?? 0}>
    {scale > 0 && frame?.detections.map((detection, index) => {
      const [x1, y1, x2, y2] = detection.box;
      return <div key={index} className="detection-box" style={{ left: left + x1 * scale, top: top + y1 * scale, width: (x2 - x1) * scale, height: (y2 - y1) * scale }}><span className={y1 * scale < 22 ? 'inside' : ''}>{labels[detection.label] ?? detection.label} {Math.round(detection.confidence * 100)}%</span></div>;
    })}
  </div>;
}
