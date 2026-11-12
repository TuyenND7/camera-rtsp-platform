import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, Camera } from '../api';
import HlsPlayer, { HlsPlayerHandle } from '../HlsPlayer';
import Icon from '../Icon';
import PtzPanel from '../PtzPanel';
import LiveDevicePicker from '../LiveDevicePicker';
import { PageHeader, statusLabels } from '../ui';

type LayoutSize = 1 | 4 | 9 | 16;

export default function Grid() {
  const [searchParams] = useSearchParams();
  const focusedCameraId = Number(searchParams.get('camera'));
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [slots, setSlots] = useState<Array<number | null>>([]);
  const [layout, setLayout] = useState<LayoutSize>(focusedCameraId > 0 ? 1 : 4);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSlot, setPickerSlot] = useState<number | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.listCameras().then((items) => {
      setCameras(items);
      const enabled = items.filter((camera) => camera.enabled);
      const focused = enabled.find((camera) => camera.id === focusedCameraId);
      const size = focused ? 1 : 4;
      const initial = focused ? [focused] : enabled.slice(0, size);
      setLayout(size);
      setSlots(Array.from({ length: size }, (_, index) => initial[index]?.id ?? null));
    }).catch((error) => setErr(error.message));
  }, [focusedCameraId]);

  // Cập nhật trạng thái online/offline mà không đổi lựa chọn camera của người dùng.
  useEffect(() => {
    const timer = window.setInterval(() => {
      api.listCameras().then((items) => { setCameras(items); setErr(''); }).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  const cameraById = useMemo(() => new Map(cameras.map(camera => [camera.id, camera])), [cameras]);
  const visible = useMemo(
    () => Array.from({ length: layout }, (_, index) => cameraById.get(slots[index] ?? -1) ?? null),
    [cameraById, layout, slots]
  );
  const selected = useMemo(() => new Set(visible.flatMap(camera => camera ? [camera.id] : [])), [visible]);

  function changeLayout(size: LayoutSize) {
    setLayout(size);
    setSlots(current => Array.from({ length: size }, (_, index) => current[index] ?? null));
    setPickerOpen(false);
  }

  function closeSlot(index: number) {
    setSlots(current => current.map((id, slot) => slot === index ? null : id));
  }

  function openPicker(index?: number) {
    const firstEmpty = visible.findIndex(camera => !camera);
    setPickerSlot(index ?? (firstEmpty >= 0 ? firstEmpty : null));
    setPickerOpen(true);
  }

  function chooseCamera(id: number, index: number) {
    if (!cameraById.has(id) || index < 0 || index >= layout) return;
    setSlots(current => {
      if (current.includes(id)) return current;
      return Array.from({ length: layout }, (_, slot) => slot === index ? id : current[slot] ?? null);
    });
    setPickerOpen(false);
  }
  return (
    <section className="mi-live-page">
      <PageHeader title="Live view" actions={<div className="mi-live-actions">
          <button type="button" className="mi-camera-picker-button" onClick={() => openPicker()} aria-label="Chọn camera Live view"><Icon name="video" size={18} />{selected.size} camera <Icon name="chevronDown" size={15} /></button>
          <div className="mi-layout-picker" role="group" aria-label="Bố cục camera">
            {([1, 4, 9, 16] as LayoutSize[]).map((size) => <button key={size} className={layout === size ? 'active' : ''} type="button" onClick={() => changeLayout(size)} title={`Bố cục ${size} camera`}>{size === 1 ? '1' : size === 4 ? '2×2' : size === 9 ? '3×3' : '4×4'}</button>)}
          </div>
        </div>} />

      {err && <div className="notice error">Không tải được camera: {err}</div>}
      {!err && layout === 1 && visible[0] && <FocusView camera={visible[0]} cameras={cameras.filter(camera => camera.enabled)} onChoose={id => chooseCamera(id, 0)} onClose={() => closeSlot(0)} />}
      {!err && (layout !== 1 || !visible[0]) && <>
        <div className={`mi-camera-grid layout-${layout}`}>
          {visible.map((camera, index) => camera
            ? <CameraTile key={`slot-${index}`} camera={camera} onClose={() => closeSlot(index)} />
            : <button key={`slot-${index}`} type="button" className="empty-camera-tile" onClick={() => openPicker(index)} aria-label={`Chọn camera cho ô ${index + 1}`}><Icon name="plus" size={26} /><span>Chọn camera</span><small>Thêm vào ô {index + 1}</small></button>)}
        </div>
      </>}
      {pickerOpen && <LiveDevicePicker cameras={cameras} selected={selected} slot={pickerSlot} onChoose={id => { if (pickerSlot !== null) chooseCamera(id, pickerSlot); }} onClose={() => setPickerOpen(false)} />}
    </section>
  );
}

function FocusView({ camera, cameras, onChoose, onClose }: { camera: Camera; cameras: Camera[]; onChoose: (id: number) => void; onClose: () => void }) {
  return (
    <>
      <section className="mi-live-focus">
        <article className="mi-featured-camera">
          <LiveVideo camera={camera} className="mi-featured-video" offlineLabel={camera.status === 'connecting' ? 'Đang kết nối camera' : 'Camera chưa online'} onClose={onClose}>
            <div className="mi-featured-title"><i className={`status-dot ${camera.status}`} /><div><span>LIVE CAMERA</span><strong>{camera.name}</strong></div></div>
          </LiveVideo>
        </article>
        <aside className="mi-device-panel">
          <PtzPanel key={camera.id} cameraId={camera.id} />
          <div className="mi-device-quick-actions"><Link className="button" to={`/playback/${camera.id}`}><Icon name="clock" size={17} />Xem lại</Link><Link className="button" to="/cameras"><Icon name="settings" size={17} />Cấu hình</Link></div>
          <details className="live-device-details"><summary>Thông tin thiết bị<Icon name="chevronDown" size={14} /></summary><dl><div><dt>Địa chỉ</dt><dd>{cameraHost(camera.rtsp_url)}</dd></div><div><dt>Video</dt><dd>{camera.codec.toUpperCase()}</dd></div><div><dt>Ghi hình</dt><dd>{camera.record ? 'Bật' : 'Tắt'}</dd></div></dl></details>
        </aside>
      </section>
      {cameras.length > 1 && <section className="mi-camera-carousel" aria-label="Chuyển camera">
        <div className="mi-carousel-items">{cameras.map((item) => <button key={item.id} type="button" className={item.id === camera.id ? 'active' : ''} onClick={() => onChoose(item.id)}><Icon name="camera" size={18} /><span>{item.name}</span><i className={`status-dot ${item.status}`} /><small>{statusLabels[item.status] ?? item.status}</small></button>)}</div>
      </section>}
    </>
  );
}

function cameraHost(url: string): string {
  try { return new URL(url).hostname; } catch { return 'Camera RTSP'; }
}

function CameraTile({ camera, onClose }: { camera: Camera; onClose: () => void }) {
  return (
    <article className="mi-camera-card">
      <LiveVideo camera={camera} className="mi-camera-video" offlineLabel={camera.status === 'connecting' ? 'Đang kết nối' : 'Camera chưa online'} onClose={onClose}>
        <div className="mi-camera-overlay">
          <div><i className={`status-dot ${camera.status}`} /><strong>{camera.name}</strong><small>{statusLabels[camera.status] ?? camera.status}</small></div>
          <div className="mi-camera-card-actions"><Link to={`/live?camera=${camera.id}`} title="Chỉ xem camera này"><Icon name="monitor" size={17} /></Link><Link to={`/playback/${camera.id}`} title="Xem Playback"><Icon name="clock" size={17} /></Link></div>
        </div>
      </LiveVideo>
    </article>
  );
}

/**
 * Tự tải lại player khi camera chuyển sang online sau khi mất kết nối.
 * Nút kết nối lại chỉ hiện khi camera offline để tìm lại IP nếu DHCP đã đổi.
 */
function LiveVideo({ camera, className, offlineLabel, children, onClose }: { camera: Camera; className: string; offlineLabel: string; children: React.ReactNode; onClose: () => void }) {
  const player = useRef<HlsPlayerHandle>(null);
  const previousStatus = useRef(camera.status);
  const [reconnecting, setReconnecting] = useState(false);
  const [notice, setNotice] = useState('');
  const offline = camera.status !== 'online';

  useEffect(() => {
    if (camera.status === 'online' && previousStatus.current !== 'online') player.current?.reload();
    previousStatus.current = camera.status;
  }, [camera.status]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function reload() {
    player.current?.reload();
    if (!offline) {
      setNotice('Đã tải lại luồng live');
      return;
    }
    setReconnecting(true);
    setNotice('');
    try {
      const result = await api.reconnectCamera(camera.id);
      setNotice(result.moved ? `Camera đổi IP ${result.moved.from} → ${result.moved.to}, đang kết nối lại…` : 'Đang kết nối lại camera…');
    } catch (error: any) {
      setNotice(error.message);
    } finally {
      setReconnecting(false);
    }
  }

  return (
    <div className={className}>
      <HlsPlayer ref={player} src={`/live/${camera.id}/index.m3u8`} live controls={false} />
      {offline && (
        <div className="mi-stream-state">
          <i className={`status-dot ${camera.status}`} />{offlineLabel}
          <button type="button" onClick={() => void reload()} disabled={reconnecting}>{reconnecting ? 'Đang tìm camera…' : 'Kết nối lại'}</button>
        </div>
      )}
      {notice && <div className="mi-live-notice" role="status">{notice}</div>}
      {children}
      <button type="button" className="mi-camera-close" onClick={onClose} aria-label={`Bỏ ${camera.name} khỏi Live view`} title="Bỏ camera khỏi ô này"><Icon name="close" size={19} /></button>
    </div>
  );
}
