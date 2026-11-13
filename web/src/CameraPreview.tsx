import { useRef, useState } from 'react';
import { Camera } from './api';
import HlsPlayer, { HlsPlayerHandle } from './HlsPlayer';
import Icon from './Icon';
import PtzPanel from './PtzPanel';

export default function CameraPreview({ camera }: { camera: Camera }) {
  const player = useRef<HlsPlayerHandle>(null);
  const [zoom, setZoom] = useState(1), [muted, setMuted] = useState(true), [waiting, setWaiting] = useState(true);
  const [position, setPosition] = useState({ x: 0, y: 0 }), [error, setError] = useState('');
  const drag = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const online = camera.enabled && camera.status === 'online';
  function magnify(value: number) { setZoom(value); setPosition({ x: 0, y: 0 }); }
  return <div className="camera-preview-workspace">
    <div className="camera-preview-column">
      <div className={`camera-preview-video${zoom > 1 ? ' is-zoomed' : ''}`} aria-label={`Xem trước ${camera.name}`} onPointerDown={event => {
        if (zoom <= 1 || !online || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, y: event.clientY, originX: position.x, originY: position.y };
      }} onPointerMove={event => {
        if (!drag.current) return;
        const box = event.currentTarget.getBoundingClientRect(), maxX = (zoom - 1) * box.width / 2, maxY = (zoom - 1) * box.height / 2;
        setPosition({ x: Math.max(-maxX, Math.min(maxX, drag.current.originX + event.clientX - drag.current.x)), y: Math.max(-maxY, Math.min(maxY, drag.current.originY + event.clientY - drag.current.y)) });
      }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
        {online ? <><div className="camera-preview-transform" style={{ transform: `translate(${position.x}px, ${position.y}px) scale(${zoom})` }}><HlsPlayer ref={player} src={`/live/${camera.id}/index.m3u8`} live controls={false} muted={muted} onWaitingChange={setWaiting} onPlaybackError={setError} /></div>{waiting && <span className="camera-preview-status">Đang tải hình…</span>}</> : <div className="camera-preview-offline"><Icon name="video" size={34} /><strong>Camera chưa trực tuyến</strong><span>Kiểm tra nguồn điện và kết nối của thiết bị.</span></div>}
      </div>
      <div className="camera-preview-toolbar"><div className="camera-preview-zoom"><button type="button" className="icon-button" disabled={!online || zoom <= 1} onClick={() => magnify(Math.max(1, zoom - 0.5))} aria-label="Thu nhỏ xem trước"><Icon name="zoomOut" /></button><label>Zoom xem trước<input type="range" min={1} max={4} step={0.5} value={zoom} disabled={!online} onChange={event => magnify(Number(event.target.value))} aria-label="Mức zoom xem trước" /></label><button type="button" className="icon-button" disabled={!online || zoom >= 4} onClick={() => magnify(Math.min(4, zoom + 0.5))} aria-label="Phóng to xem trước"><Icon name="zoomIn" /></button><button type="button" onClick={() => magnify(1)} disabled={!online} aria-label="Đặt lại zoom xem trước">{zoom.toFixed(1)}×</button></div><button type="button" className="icon-button" disabled={!online} onClick={() => setMuted(value => !value)} aria-label={`${muted ? 'Bật' : 'Tắt'} tiếng xem trước`}><Icon name={muted ? 'volumeMuted' : 'volume'} /></button><button type="button" className="icon-button" disabled={!online} onClick={() => player.current?.reload()} aria-label="Tải lại xem trước"><Icon name="refresh" /></button></div>
      <p className="muted">Kéo ảnh khi phóng to để xem vùng khác. Zoom xem trước chỉ thay đổi hình đang xem.</p>
      {error && <p className="notice error" role="alert">{error}</p>}
    </div>
    <aside className="camera-preview-ptz">{online ? <PtzPanel cameraId={camera.id} /> : <><h3>Quay quét và zoom camera</h3><p className="muted">Kết nối camera để kiểm tra PTZ.</p></>}</aside>
  </div>;
}
