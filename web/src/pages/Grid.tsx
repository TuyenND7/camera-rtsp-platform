import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, Camera } from '../api';
import HlsPlayer, { HlsPlayerHandle } from '../HlsPlayer';
import Icon from '../Icon';
import PtzPanel from '../PtzPanel';
import { EmptyState, PageHeader, statusLabels } from '../ui';

type LayoutSize = 1 | 4 | 9 | 16;

export default function Grid() {
  const [searchParams] = useSearchParams();
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [layout, setLayout] = useState<LayoutSize>(1);
  const [featuredCameraId, setFeaturedCameraId] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const focusedCameraId = Number(searchParams.get('camera'));

  useEffect(() => {
    api.listCameras().then((items) => {
      setCameras(items);
      const enabled = items.filter((camera) => camera.enabled);
      const focused = enabled.find((camera) => camera.id === focusedCameraId);
      setSelected(new Set((focused ? [focused] : enabled.slice(0, 16)).map((camera) => camera.id)));
      setFeaturedCameraId((focused ?? enabled[0])?.id ?? null);
    }).catch((error) => setErr(error.message));
  }, [focusedCameraId]);

  // Cập nhật trạng thái online/offline mà không đổi lựa chọn camera của người dùng.
  useEffect(() => {
    const timer = window.setInterval(() => {
      api.listCameras().then((items) => { setCameras(items); setErr(''); }).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  function toggle(id: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      if (!next.has(featuredCameraId ?? -1)) setFeaturedCameraId(Array.from(next)[0] ?? null);
      return next;
    });
  }

  const selectedCameras = useMemo(
    () => cameras.filter((camera) => selected.has(camera.id)),
    [cameras, selected]
  );
  const featuredCamera = selectedCameras.find((camera) => camera.id === featuredCameraId) ?? selectedCameras[0];
  const visible = useMemo(
    () => selectedCameras.slice(0, layout),
    [layout, selectedCameras]
  );
  return (
    <section className="mi-live-page">
      <PageHeader title="Live view" actions={<div className="mi-live-actions">
          <details className="mi-camera-picker">
            <summary><Icon name="video" size={18} />{selected.size} camera <Icon name="chevronDown" size={15} /></summary>
            <div>{cameras.map((camera) => <label key={camera.id}><input type="checkbox" checked={selected.has(camera.id)} onChange={() => toggle(camera.id)} /><i className={`status-dot ${camera.status}`} />{camera.name}</label>)}</div>
          </details>
          <div className="mi-layout-picker" role="group" aria-label="Bố cục camera">
            {([1, 4, 9, 16] as LayoutSize[]).map((size) => <button key={size} className={layout === size ? 'active' : ''} type="button" onClick={() => setLayout(size)} title={`Bố cục ${size} camera`}>{size === 1 ? '1' : size === 4 ? '2×2' : size === 9 ? '3×3' : '4×4'}</button>)}
          </div>
        </div>} />

      {err && <div className="notice error">Không tải được camera: {err}</div>}
      {!err && selectedCameras.length === 0 && <section className="panel"><EmptyState title="Chưa có camera trong màn hình" action={<Link to="/cameras" className="button primary">Thêm thiết bị</Link>}>Thêm camera RTSP/ONVIF hoặc chọn camera ở bộ lọc phía trên.</EmptyState></section>}
      {!err && selectedCameras.length > 0 && layout === 1 && featuredCamera && <FocusView camera={featuredCamera} cameras={selectedCameras} onChoose={setFeaturedCameraId} />}
      {!err && selectedCameras.length > 0 && layout !== 1 && <>
        <div className={`mi-camera-grid layout-${layout}`}>
          {visible.map((camera) => <CameraTile key={camera.id} camera={camera} />)}
          {Array.from({ length: Math.max(0, layout - visible.length) }, (_, index) => <Link key={`empty-${index}`} to="/cameras" className="empty-camera-tile"><Icon name="plus" size={26} /><span>Chưa có camera</span><small>Thêm thiết bị để theo dõi</small></Link>)}
        </div>
      </>}
    </section>
  );
}

function FocusView({ camera, cameras, onChoose }: { camera: Camera; cameras: Camera[]; onChoose: (id: number) => void }) {
  return (
    <>
      <section className="mi-live-focus">
        <article className="mi-featured-camera">
          <LiveVideo camera={camera} className="mi-featured-video" offlineLabel={camera.status === 'connecting' ? 'Đang kết nối camera' : 'Camera chưa online'}>
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

function CameraTile({ camera }: { camera: Camera }) {
  return (
    <article className="mi-camera-card">
      <LiveVideo camera={camera} className="mi-camera-video" offlineLabel={camera.status === 'connecting' ? 'Đang kết nối' : 'Camera chưa online'}>
        <div className="mi-camera-overlay">
          <div><i className={`status-dot ${camera.status}`} /><strong>{camera.name}</strong><small>{statusLabels[camera.status] ?? camera.status}</small></div>
          <div className="mi-camera-card-actions"><Link to={`/live?camera=${camera.id}`} title="Chỉ xem camera này"><Icon name="monitor" size={17} /></Link><Link to={`/playback/${camera.id}`} title="Xem Playback"><Icon name="clock" size={17} /></Link></div>
        </div>
      </LiveVideo>
    </article>
  );
}

/**
 * Khung live + nút Tải lại. Tự tải lại player khi camera chuyển sang online
 * (sau khi mất kết nối). Khi camera chưa online, nút còn yêu cầu backend kết nối
 * lại ngay và tìm IP mới nếu router đã đổi IP camera.
 */
function LiveVideo({ camera, className, offlineLabel, children }: { camera: Camera; className: string; offlineLabel: string; children: React.ReactNode }) {
  const player = useRef<HlsPlayerHandle>(null);
  const previousStatus = useRef(camera.status);
  const [reconnecting, setReconnecting] = useState(false);
  const [notice, setNotice] = useState('');
  const [playing, setPlaying] = useState(false);
  const videoWrap = useRef<HTMLDivElement>(null);
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
    <div className={className} ref={videoWrap}>
      <HlsPlayer ref={player} src={`/live/${camera.id}/index.m3u8`} live controls={false} onPlayingChange={setPlaying} />
      {offline && (
        <div className="mi-stream-state">
          <i className={`status-dot ${camera.status}`} />{offlineLabel}
          <button type="button" onClick={() => void reload()} disabled={reconnecting}>{reconnecting ? 'Đang tìm camera…' : 'Kết nối lại'}</button>
        </div>
      )}
      <button type="button" className={`mi-live-reload ${reconnecting ? 'busy' : ''}`} onClick={() => void reload()} disabled={reconnecting} title="Tải lại luồng live" aria-label={`Tải lại luồng live ${camera.name}`}>
        <Icon name="refresh" size={17} />
      </button>
      {notice && <div className="mi-live-notice" role="status">{notice}</div>}
      {children}
      <div className="live-media-bar"><button type="button" onClick={() => player.current?.togglePlay()} aria-label={playing ? `Tạm dừng ${camera.name}` : `Phát ${camera.name}`} title={playing ? 'Tạm dừng' : 'Phát'}><Icon name={playing ? 'pause' : 'play'} size={17} /></button><span><i className={`status-dot ${offline ? 'error' : 'online'}`} />{offline ? 'Chưa kết nối' : playing ? 'Đang phát trực tiếp' : 'Đã tạm dừng'}</span><button type="button" onClick={() => { if (document.fullscreenElement) void document.exitFullscreen(); else void videoWrap.current?.requestFullscreen().catch(() => undefined); }} aria-label={`Toàn màn hình ${camera.name}`} title="Toàn màn hình"><Icon name="layout" size={17} /></button></div>
    </div>
  );
}
