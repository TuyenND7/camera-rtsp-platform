import { useCallback, useEffect, useRef, useState } from 'react';
import { api, PtzInfo } from './api';
import Icon from './Icon';

type Vector = { x: number; y: number; zoom: number };

/** Gửi lại lệnh quay khi đang giữ nút; backend đặt timeout 2s để camera tự dừng nếu mất kết nối. */
const HEARTBEAT_MS = 1000;

const DIRECTIONS: Array<{ key: string; label: string; x: number; y: number; area: string; arrow: string }> = [
  { key: 'up', label: 'Lên', x: 0, y: 1, area: 'up', arrow: '▲' },
  { key: 'left', label: 'Trái', x: -1, y: 0, area: 'left', arrow: '◀' },
  { key: 'right', label: 'Phải', x: 1, y: 0, area: 'right', arrow: '▶' },
  { key: 'down', label: 'Xuống', x: 0, y: -1, area: 'down', arrow: '▼' },
];

const KEY_VECTORS: Record<string, Vector> = {
  ArrowUp: { x: 0, y: 1, zoom: 0 },
  ArrowDown: { x: 0, y: -1, zoom: 0 },
  ArrowLeft: { x: -1, y: 0, zoom: 0 },
  ArrowRight: { x: 1, y: 0, zoom: 0 },
  '+': { x: 0, y: 0, zoom: 1 },
  '=': { x: 0, y: 0, zoom: 1 },
  '-': { x: 0, y: 0, zoom: -1 },
};

/**
 * Bảng PTZ: giữ nút để quay/zoom, thả ra để dừng (như app camera). Dùng được với
 * chuột, cảm ứng và bàn phím (mũi tên, +/−). Preset: bấm để về vị trí đã lưu.
 */
export default function PtzPanel({ cameraId }: { cameraId: number }) {
  const [info, setInfo] = useState<PtzInfo | null>(null);
  const [speed, setSpeed] = useState(0.5);
  const [active, setActive] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [err, setErr] = useState('');
  const heartbeat = useRef<number>();
  const moving = useRef(false);
  const speedRef = useRef(speed);
  speedRef.current = speed;

  const load = useCallback(() => {
    api.ptzInfo(cameraId).then(setInfo).catch((error) => setInfo({ supported: false, reason: error.message }));
  }, [cameraId]);

  useEffect(() => {
    setInfo(null);
    setErr('');
    load();
  }, [load]);

  const stop = useCallback(() => {
    if (heartbeat.current) window.clearInterval(heartbeat.current);
    heartbeat.current = undefined;
    setActive(null);
    if (!moving.current) return;
    moving.current = false;
    api.ptzCommand(cameraId, 'stop').catch((error) => setErr(error.message));
  }, [cameraId]);

  const start = useCallback((key: string, vector: Vector) => {
    if (heartbeat.current) window.clearInterval(heartbeat.current);
    const s = speedRef.current;
    const body = { x: vector.x * s, y: vector.y * s, zoom: vector.zoom * s };
    const send = () => api.ptzCommand(cameraId, 'move', body).catch((error) => {
      setErr(error.message);
      stop();
    });
    setErr('');
    setActive(key);
    moving.current = true;
    void send();
    heartbeat.current = window.setInterval(send, HEARTBEAT_MS);
  }, [cameraId, stop]);

  // Dừng camera khi rời trang / đổi camera / ẩn tab.
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') stop(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('blur', stop);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('blur', stop);
      stop();
    };
  }, [stop]);

  function holdProps(key: string, vector: Vector) {
    return {
      onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        start(key, vector);
      },
      onPointerUp: stop,
      onPointerCancel: stop,
      onLostPointerCapture: stop,
      onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
        if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
          event.preventDefault();
          start(key, vector);
        }
      },
      onKeyUp: (event: React.KeyboardEvent<HTMLButtonElement>) => {
        if (event.key === 'Enter' || event.key === ' ') stop();
      },
      onContextMenu: (event: React.MouseEvent) => event.preventDefault(),
    };
  }

  function onPadKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const vector = KEY_VECTORS[event.key];
    if (!vector) return;
    event.preventDefault();
    if (!event.repeat) start(event.key, vector);
  }

  function onPadKeyUp(event: React.KeyboardEvent<HTMLDivElement>) {
    if (KEY_VECTORS[event.key]) stop();
  }

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setErr('');
    try {
      await action();
    } catch (error: any) {
      setErr(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function savePreset(event: React.FormEvent) {
    event.preventDefault();
    const name = presetName.trim();
    if (!name) return;
    await run(async () => {
      setInfo(await api.ptzSavePreset(cameraId, name));
      setPresetName('');
    });
  }

  if (!info) return <section className="ptz-panel" aria-busy="true"><p className="ptz-muted">Đang kiểm tra PTZ…</p></section>;
  if (!info.supported) {
    return (
      <section className="ptz-panel">
        <h3>Điều khiển PTZ</h3>
        <p className="ptz-muted">Camera không hỗ trợ PTZ qua ONVIF{info.reason ? `: ${info.reason}` : '.'}</p>
      </section>
    );
  }

  return (
    <section className="ptz-panel" aria-label="Điều khiển quay quét camera">
      <div className="ptz-head">
        <h3>Điều khiển PTZ</h3>
        <button type="button" className="ptz-text-button" onClick={() => void run(() => api.ptzCommand(cameraId, 'home'))} disabled={busy} title="Về vị trí Home của camera">Home</button>
      </div>

      <div className="ptz-pad" role="group" aria-label="Giữ để quay camera, hoặc dùng phím mũi tên" tabIndex={0} onKeyDown={onPadKeyDown} onKeyUp={onPadKeyUp} onBlur={stop}>
        {DIRECTIONS.map((dir) => (
          <button
            key={dir.key}
            type="button"
            className={`ptz-dir ptz-${dir.area} ${active === dir.key || active === `Arrow${dir.key[0].toUpperCase()}${dir.key.slice(1)}` ? 'active' : ''}`}
            aria-label={`Quay ${dir.label.toLowerCase()} (giữ)`}
            title={`Giữ để quay ${dir.label.toLowerCase()}`}
            {...holdProps(dir.key, { x: dir.x, y: dir.y, zoom: 0 })}
          >{dir.arrow}</button>
        ))}
        <button type="button" className="ptz-center" onClick={stop} aria-label="Dừng" title="Dừng">■</button>
      </div>

      <div className="ptz-zoom-row">
        <button type="button" className={active === 'zoomOut' ? 'active' : ''} aria-label="Thu nhỏ (giữ)" title="Giữ để thu nhỏ" {...holdProps('zoomOut', { x: 0, y: 0, zoom: -1 })}><Icon name="zoomOut" size={18} /></button>
        <span>Zoom</span>
        <button type="button" className={active === 'zoomIn' ? 'active' : ''} aria-label="Phóng to (giữ)" title="Giữ để phóng to" {...holdProps('zoomIn', { x: 0, y: 0, zoom: 1 })}><Icon name="zoomIn" size={18} /></button>
      </div>

      <label className="ptz-speed">
        <span>Tốc độ <b>{Math.round(speed * 100)}%</b></span>
        <input type="range" min={0.1} max={1} step={0.1} value={speed} onChange={(event) => setSpeed(Number(event.target.value))} />
      </label>

      <div className="ptz-presets">
        <span className="eyebrow">Vị trí đã lưu</span>
        {(info.presets ?? []).length === 0 && <p className="ptz-muted">Chưa có preset. Quay tới góc cần xem rồi lưu bên dưới.</p>}
        <ul>
          {(info.presets ?? []).map((preset) => (
            <li key={preset.token}>
              <button type="button" className="ptz-preset-go" onClick={() => void run(() => api.ptzGotoPreset(cameraId, preset.token))} disabled={busy} title={`Quay tới "${preset.name}"`}>
                <Icon name="play" size={12} />{preset.name}
              </button>
              <button type="button" className="ptz-preset-delete" onClick={() => { if (confirm(`Xoá preset "${preset.name}"?`)) void run(async () => setInfo(await api.ptzDeletePreset(cameraId, preset.token))); }} disabled={busy} aria-label={`Xoá preset ${preset.name}`} title="Xoá">×</button>
            </li>
          ))}
        </ul>
        <form onSubmit={savePreset} className="ptz-save">
          <input value={presetName} onChange={(event) => setPresetName(event.target.value)} maxLength={40} placeholder="Tên vị trí, vd Cửa chính" aria-label="Tên preset mới" />
          <button type="submit" disabled={busy || !presetName.trim()}>Lưu</button>
        </form>
      </div>
      {err && <p className="ptz-error" role="alert">{err}</p>}
    </section>
  );
}
