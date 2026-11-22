import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Camera, DetectionEvent } from '../api';
import Icon from '../Icon';
import { detectionLabel } from '../liveDetections';
import { EventThumbnail, EventImageDialog } from '../EventImage';
import { EmptyState, PageHeader } from '../ui';

const labels: Record<string, string> = { person: 'Người', cat: 'Mèo', dog: 'Chó', car: 'Ô tô', motorcycle: 'Xe máy', bicycle: 'Xe đạp', truck: 'Xe tải', bus: 'Xe buýt' };
type EventLayout = 'list' | 2 | 3;
const layoutKey = 'camera-station.events-layout';
function initialLayout(): EventLayout {
  try { const value = localStorage.getItem(layoutKey); if (value === 'list') return value; if (value === '2' || value === '3') return Number(value) as 2 | 3; } catch {}
  return window.matchMedia('(max-width: 600px)').matches ? 'list' : 3;
}
function playbackUrl(item: DetectionEvent) {
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(item.detected_at)).replace(/-/g, '');
  return `/playback/${item.camera_id}?day=${day}&at=${encodeURIComponent(item.detected_at)}`;
}

export default function Events() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [cameraId, setCameraId] = useState('');
  const [events, setEvents] = useState<DetectionEvent[]>([]);
  const [label, setLabel] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [layout, setLayout] = useState<EventLayout>(initialLayout), [image, setImage] = useState<DetectionEvent | null>(null);
  const request = useRef(0);
  useEffect(() => { try { localStorage.setItem(layoutKey, String(layout)); } catch {} }, [layout]);

  async function load(silent = false) {
    const sequence = ++request.current;
    if (!silent) setLoading(true);
    try {
      const values = await api.listEvents({ cameraId: cameraId ? Number(cameraId) : undefined, limit: 100 });
      if (request.current === sequence) { setEvents(values); setErr(''); }
    }
    catch (error: any) { if (request.current === sequence) setErr(error.message); }
    finally { if (request.current === sequence) setLoading(false); }
  }

  useEffect(() => { api.listCameras().then(setCameras).catch((error) => setErr(error.message)); }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(true); }, 5000);
    return () => { window.clearInterval(timer); request.current++; };
  }, [cameraId]);
  const filtered = events.filter((item) => !label || item.label === label);
  const aiEnabled = cameras.some((camera) => camera.ai_enabled);

  return <section className="events-page"><PageHeader title="Sự kiện" actions={<><label className="event-layout-picker"><Icon name={layout === 'list' ? 'menu' : 'layout'} size={17} /><select aria-label="Chế độ xem sự kiện" value={layout} onChange={event => setLayout(event.target.value === 'list' ? 'list' : Number(event.target.value) as 2 | 3)}><option value="list">Danh sách</option><option value="2">2 cột</option><option value="3">3 cột</option></select></label><button type="button" onClick={() => void load()} disabled={loading}><Icon name="refresh" size={16} />Làm mới</button></>} />
    {err && <div className="notice error" role="alert">{err}</div>}
    <div className="panel table-toolbar"><label className="filter-field"><span>Thiết bị</span><select value={cameraId} onChange={(event) => setCameraId(event.target.value)}><option value="">Tất cả camera</option>{cameras.map((camera) => <option key={camera.id} value={camera.id}>{camera.name}</option>)}</select></label><label className="filter-field"><span>Loại sự kiện</span><select value={label} onChange={(event) => setLabel(event.target.value)}><option value="">Tất cả đối tượng</option>{Object.entries(labels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label><span className="subtle-badge">{filtered.length} sự kiện</span></div>
    {!filtered.length ? <section className="panel"><EmptyState icon="bell" title={loading ? 'Đang tải sự kiện…' : 'Chưa có sự kiện'} action={!aiEnabled && !loading && <Link to="/cameras" className="button">Cấu hình nhận dạng</Link>}>{aiEnabled ? 'Sự kiện sẽ xuất hiện khi phát hiện đối tượng.' : 'Bật AI trong cấu hình thiết bị để lưu các lần phát hiện.'}</EmptyState></section> : <div className={`event-grid event-layout-${layout}`}>{filtered.map((item) => <article className="panel event-card" key={item.id}>{item.snapshot_url ? <div className="event-picture"><EventThumbnail event={item} onOpen={() => setImage(item)} /></div> : <div className="event-no-image"><Icon name="camera" size={30} /></div>}<div><div className="panel-heading"><span className="event-label"><Icon name={item.label === 'person' ? 'user' : 'shield'} size={16} />{detectionLabel({ label: item.label, track_number: item.metadata?.track_number })}</span><span className="subtle-badge">{(item.confidence * 100).toFixed(0)}%</span></div><h3>{item.camera_name}</h3><time>{new Date(item.detected_at).toLocaleString('vi-VN')}</time><Link className="event-playback" to={playbackUrl(item)}><Icon name="clock" size={16} />Xem recording<Icon name="chevronRight" size={15} /></Link></div></article>)}</div>}
    {image && <EventImageDialog key={image.id} event={image} playbackUrl={playbackUrl(image)} onClose={() => setImage(null)} />}
  </section>;
}
