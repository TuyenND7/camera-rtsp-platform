import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type SurveillanceNotice } from '../api';
import Icon from '../Icon';
import { detectionLabel } from '../liveDetections';
import { useSurveillance } from '../surveillanceContext';
import { surveillanceDetail, surveillanceKinds, surveillancePlaybackUrl } from '../surveillanceLabels';
import { EmptyState, PageHeader } from '../ui';

export default function Notifications() {
  const surveillance = useSurveillance();
  const [items, setItems] = useState<SurveillanceNotice[]>([]), [kind, setKind] = useState(''), [unreadOnly, setUnreadOnly] = useState(false);
  const [loading, setLoading] = useState(true), [more, setMore] = useState(false), [error, setError] = useState(''), [reading, setReading] = useState(false);
  const running = useRef(false), generation = useRef(0), controller = useRef<AbortController>();
  const filters = useRef({ kind, unreadOnly }); filters.current = { kind, unreadOnly };
  const limit = 40;
  async function load(append = false, silent = false) {
    if (running.current) return;
    running.current = true;
    const sequence = generation.current;
    const before = append ? items[items.length - 1]?.id : undefined;
    if (!silent) setLoading(true);
    const abort = new AbortController(); controller.current = abort;
    const deadline = window.setTimeout(() => abort.abort(), 8000);
    try {
      const value = await api.surveillanceNotifications({ kind: filters.current.kind || undefined, unread: filters.current.unreadOnly || undefined, before, limit }, abort.signal);
      if (sequence !== generation.current) return;
      setItems(previous => append ? [...previous, ...value.items.filter(item => !previous.some(old => old.id === item.id))] : value.items);
      setMore(value.items.length === limit); setError('');
    } catch (error) { if (sequence === generation.current && !abort.signal.aborted) setError(error instanceof Error ? error.message : 'Chưa tải được thông báo.'); }
    finally { window.clearTimeout(deadline); if (sequence === generation.current) { running.current = false; setLoading(false); } }
  }
  useEffect(() => {
    generation.current++; controller.current?.abort(); running.current = false; setItems([]); setMore(false);
    void load();
    return () => { generation.current++; controller.current?.abort(); };
  }, [kind, unreadOnly]);
  useEffect(() => {
    // Keep loaded older pages; a new count offers refresh instead of resetting scroll.
    if (!items.length && !loading && surveillance?.unread) void load(false, true);
  }, [surveillance?.unread]);
  async function markRead(ids?: string[]) {
    if (!surveillance || reading) return;
    setReading(true); setError('');
    try {
      await surveillance.read(ids);
      setItems(value => unreadOnly ? value.filter(item => ids && !ids.includes(item.id)) : value.map(item => !ids || ids.includes(item.id) ? { ...item, read: true } : item));
    } catch (error) { setError(error instanceof Error ? error.message : 'Chưa đánh dấu được thông báo.'); }
    finally { setReading(false); }
  }
  return <section className="surveillance-notifications-page">
    <PageHeader title="Thông báo" actions={<><span className="subtle-badge">{surveillance?.unread ?? 0} chưa đọc</span><button type="button" disabled={loading} onClick={() => void load()} aria-label="Làm mới thông báo"><Icon name="refresh" size={17} /></button></>} />
    <section className="panel surveillance-notification-toolbar"><label>Loại thông báo<select value={kind} onChange={event => setKind(event.target.value)}><option value="">Tất cả</option>{Object.entries(surveillanceKinds).map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label><label className="simple-check"><input type="checkbox" checked={unreadOnly} onChange={event => setUnreadOnly(event.target.checked)} />Chưa đọc</label><button type="button" disabled={reading || !surveillance?.unread} onClick={() => void markRead()}><Icon name="check" size={16} />Đọc tất cả</button></section>
    {error && <div className="notice error" role="alert">{error}</div>}
    {surveillance?.error && <div className="notice" role="status">{surveillance.error}</div>}
    {!items.length ? <section className="panel"><EmptyState icon="bell" title={loading ? 'Đang tải thông báo…' : 'Chưa có thông báo'}>{unreadOnly ? 'Các thông báo chưa đọc sẽ xuất hiện tại đây.' : <>Bật cảnh báo trong <Link to="/cameras">cài đặt nhận dạng của camera</Link>.</>}</EmptyState></section> : <div className="surveillance-notification-list">{items.map(item => <article key={item.id} className={`panel surveillance-notification-card${item.read ? '' : ' unread'}`}>
      <button type="button" className="surveillance-notification-image" onClick={() => surveillance?.watch({ cameraId: item.camera_id, trackId: item.track_id, notice: item })} aria-label={`Theo dõi ${item.camera_name}, ${surveillanceKinds[item.kind]}`}>{item.thumbnail_url ? <img src={item.thumbnail_url} alt="Ảnh xem trước thông báo" loading="lazy" decoding="async" /> : <Icon name="camera" size={28} />}</button>
      <div className="surveillance-notification-content"><div className="surveillance-notification-heading"><strong>{surveillanceKinds[item.kind]}</strong>{!item.read && <span className="surveillance-unread-dot" aria-label="Chưa đọc" />}</div><h3>{item.camera_name}</h3><p>{detectionLabel({ label: item.label, track_number: item.track_number ?? undefined, identity: item.identity })}</p><p>{surveillanceDetail(item)}</p><time>{new Date(item.detected_at).toLocaleString('vi-VN')}</time><div className="surveillance-notification-actions"><button type="button" onClick={() => surveillance?.watch({ cameraId: item.camera_id, trackId: item.track_id, notice: item })}>Theo dõi</button><Link className="button" to={surveillancePlaybackUrl(item)}>Xem lại</Link>{!item.read && <button type="button" className="icon-button" disabled={reading} onClick={() => void markRead([item.id])} aria-label={`Đánh dấu đã đọc thông báo tại ${item.camera_name}`}><Icon name="check" size={17} /></button>}</div></div>
    </article>)}</div>}
    {more && <div className="surveillance-load-more"><button type="button" disabled={loading} onClick={() => void load(true)}>{loading ? 'Đang tải…' : 'Xem thông báo cũ hơn'}</button></div>}
  </section>;
}
