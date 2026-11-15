import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Camera, DetectionEvent } from '../api';
import Icon from '../Icon';
import { DetectionBoxes } from '../liveDetections';
import { EmptyState, PageHeader } from '../ui';

const labels: Record<string, string> = { person: 'Người', car: 'Ô tô', motorcycle: 'Xe máy', bicycle: 'Xe đạp', truck: 'Xe tải', bus: 'Xe buýt' };

export default function Events() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [cameraId, setCameraId] = useState('');
  const [events, setEvents] = useState<DetectionEvent[]>([]);
  const [label, setLabel] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const request = useRef(0);

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

  return <section className="events-page"><PageHeader title="Sự kiện" actions={<button type="button" onClick={() => void load()} disabled={loading}><Icon name="refresh" size={16} />Làm mới</button>} />
    {err && <div className="notice error" role="alert">{err}</div>}
    <div className="panel table-toolbar"><label className="filter-field"><span>Thiết bị</span><select value={cameraId} onChange={(event) => setCameraId(event.target.value)}><option value="">Tất cả camera</option>{cameras.map((camera) => <option key={camera.id} value={camera.id}>{camera.name}</option>)}</select></label><label className="filter-field"><span>Loại sự kiện</span><select value={label} onChange={(event) => setLabel(event.target.value)}><option value="">Tất cả đối tượng</option>{Object.entries(labels).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label><span className="subtle-badge">{filtered.length} sự kiện</span></div>
    {!filtered.length ? <section className="panel"><EmptyState icon="bell" title={loading ? 'Đang tải sự kiện…' : 'Chưa có sự kiện'} action={!aiEnabled && !loading && <Link to="/cameras" className="button">Cấu hình nhận dạng</Link>}>{aiEnabled ? 'Sự kiện sẽ xuất hiện khi phát hiện đối tượng.' : 'Bật AI trong cấu hình thiết bị để lưu các lần phát hiện.'}</EmptyState></section> : <div className="event-grid">{filtered.map((item) => <article className="panel event-card" key={item.id}>{item.snapshot_url ? <div className="event-picture"><img src={item.snapshot_url} alt={`${labels[item.label] ?? item.label} tại ${item.camera_name}`} loading="lazy" /><DetectionBoxes frame={item.metadata?.width && item.metadata?.height && Array.isArray(item.metadata?.detections) ? { at: Date.parse(item.detected_at), width: item.metadata.width, height: item.metadata.height, detections: item.metadata.detections } : null} /></div> : <div className="event-no-image"><Icon name="camera" size={30} /></div>}<div><div className="panel-heading"><span className="event-label"><Icon name={item.label === 'person' ? 'user' : 'shield'} size={16} />{labels[item.label] ?? item.label}</span><span className="subtle-badge">{(item.confidence * 100).toFixed(0)}%</span></div><h3>{item.camera_name}</h3><time>{new Date(item.detected_at).toLocaleString('vi-VN')}</time><Link className="event-playback" to={`/playback/${item.camera_id}?day=${new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date(item.detected_at)).replace(/-/g, '')}&at=${encodeURIComponent(item.detected_at)}`}><Icon name="clock" size={16} />Xem recording<Icon name="chevronRight" size={15} /></Link></div></article>)}</div>}
  </section>;
}
