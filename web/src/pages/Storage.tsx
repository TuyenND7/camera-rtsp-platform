import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Camera, StorageStatus } from '../api';
import Icon from '../Icon';
import { cameraHost, EmptyState, formatBytes, PageHeader } from '../ui';

export default function Storage() {
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [daysByCamera, setDaysByCamera] = useState<Record<number, string[]>>({});
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  async function load() {
    setLoading(true);
    try {
      const [nextStatus, nextCameras] = await Promise.all([api.storageStatus(), api.listCameras()]);
      setStatus(nextStatus); setCameras(nextCameras);
      const lists = await Promise.all(nextCameras.map(async (camera) => [camera.id, await api.recordingDays(camera.id)] as const));
      setDaysByCamera(Object.fromEntries(lists)); setErr('');
    } catch (error: any) { setErr(error.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  const warning = status && status.used_percent >= status.cleanup_threshold_percent;
  return <section className="storage-page"><PageHeader title="Playback" actions={<button type="button" onClick={() => void load()} disabled={loading}><Icon name="refresh" size={16} />Làm mới</button>} />
    {err && <div className="notice error" role="alert">{err}</div>}
    <section className="panel recording-table"><div className="table-scroll"><table><thead><tr><th>Camera</th><th>Ngày có video</th><th>Mới nhất</th><th /></tr></thead><tbody>{cameras.map((camera) => { const days = daysByCamera[camera.id] ?? []; return <tr key={camera.id}><td><div className="device-cell"><span className="device-icon"><Icon name="camera" size={21} /></span><span><strong>{camera.name}</strong><small>{cameraHost(camera.rtsp_url)}</small></span></div></td><td>{days.length || '—'}</td><td>{days[0] ? displayDay(days[0]) : 'Chưa có recording'}</td><td className="align-right">{days[0] ? <Link to={`/playback/${camera.id}`} className="button"><Icon name="play" size={14} />Xem lại</Link> : <span className="muted">Chờ ghi hình</span>}</td></tr>; })}</tbody></table></div>{loading && !cameras.length ? <div className="loading-state">Đang tải recording…</div> : !cameras.length && <EmptyState icon="folder" title="Chưa có recording" action={<Link to="/cameras" className="button">Thêm thiết bị</Link>}>Kết nối camera và bật ghi hình để lưu video.</EmptyState>}</section>
    {status && <details className="storage-disclosure"><summary><Icon name="database" size={17} /><span>Lưu trữ máy chủ</span><b className={warning ? 'storage-warning' : ''}>{status.used_percent}%</b><small>Còn {formatBytes(status.free_bytes)}</small><Icon name="chevronDown" size={15} /></summary><div><div className={`usage-track ${warning ? 'warning' : ''}`}><span style={{ width: `${status.used_percent}%` }} /></div><p>{status.label} · {formatBytes(status.recording_bytes)} video đã lưu</p><p>Tự xóa ngày cũ từ {status.cleanup_threshold_percent}% đến {status.cleanup_target_percent}%. Giữ lại ngày đang ghi.</p>{warning && <p className="storage-warning">Ổ gần đầy. Nếu không còn ngày cũ để dọn, cần giải phóng dung lượng hoặc mở rộng ổ.</p>}{!!status.recent_cleanups?.length && <div className="compact-cleanups"><h3>Dọn gần đây</h3>{status.recent_cleanups.filter((item) => item.bytes > 0).slice(0, 4).map((item) => <p key={`${item.at}-${item.camera_id}-${item.day}`}><span>{displayDay(item.day)} · Camera #{item.camera_id}</span><span>{formatBytes(item.bytes)}</span></p>)}</div>}</div></details>}
  </section>;
}
function displayDay(day: string) { return `${day.slice(6, 8)}/${day.slice(4, 6)}/${day.slice(0, 4)}`; }
