import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { api, type SurveillanceNotice, type SurveillancePin } from './api';
import Icon from './Icon';
import { SessionContext } from './ui';
import { SurveillanceContext, type PinSelection, type WatchTarget } from './surveillanceContext';
import { appendPopupNotices, consumeNoticeBatch, surveillanceDetail, surveillanceKinds, isHealthNotice } from './surveillanceLabels';
import WatchDialog from './WatchDialog';
import './surveillance-ui.css';

export default function SurveillanceProvider({ children }: { children: React.ReactNode }) {
  const user = useContext(SessionContext);
  const [unread, setUnread] = useState(0), [pins, setPins] = useState<SurveillancePin[]>([]), [error, setError] = useState('');
  const [queue, setQueue] = useState<SurveillanceNotice[]>([]), [target, setTarget] = useState<WatchTarget | null>(null);
  const [modalOpen, setModalOpen] = useState(false), [portal, setPortal] = useState<Element>(document.fullscreenElement ?? document.body);
  const running = useRef(false), mounted = useRef(true), initialized = useRef(false), watermark = useRef('0');
  const generation = useRef(0);
  const controller = useRef<AbortController>(), timer = useRef<number>(), deadline = useRef<number>();

  const poll = useCallback(async () => {
    if (!mounted.current || running.current || document.hidden) return;
    const requestGeneration = generation.current;
    running.current = true;
    const request = new AbortController(); controller.current = request;
    const requestDeadline = window.setTimeout(() => request.abort(), 8000); deadline.current = requestDeadline;
    const signal = request.signal;
    try {
      const [notifications, tracked] = await Promise.allSettled([
        api.surveillanceNotifications(initialized.current ? { after: watermark.current, limit: 100 } : { limit: 1 }, signal),
        api.surveillancePins(signal),
      ]);
      if (!mounted.current || generation.current !== requestGeneration) return;
      if (tracked.status === 'fulfilled') setPins(tracked.value);
      if (notifications.status === 'fulfilled') {
        const value = notifications.value;
        setUnread(value.unread_count);
        const batch = consumeNoticeBatch(initialized.current ? watermark.current : null, value);
        if (batch.popups.length) setQueue(current => appendPopupNotices(current, batch.popups));
        // The first request establishes a baseline. Later pages advance only over
        // records actually received, so a burst larger than limit cannot be skipped.
        watermark.current = batch.cursor;
        initialized.current = true;
        setError(tracked.status === 'rejected' ? 'Chưa cập nhật được danh sách theo dõi.' : '');
      } else setError('Chưa cập nhật được thông báo. Đang thử lại…');
    } catch {
      if (mounted.current && generation.current === requestGeneration) setError('Chưa cập nhật được thông báo. Đang thử lại…');
    } finally {
      window.clearTimeout(requestDeadline);
      if (generation.current === requestGeneration) {
        running.current = false;
        if (mounted.current) timer.current = window.setTimeout(() => void poll(), 5000);
      }
    }
  }, []);
  const refresh = useCallback(() => {
    window.clearTimeout(timer.current);
    void poll();
  }, [poll]);
  useEffect(() => {
    generation.current++; mounted.current = true; running.current = false; void poll();
    const visible = () => { if (!document.hidden) refresh(); };
    const settings = () => { setQueue([]); refresh(); };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('camera-station.surveillance-updated', settings);
    return () => {
      generation.current++; mounted.current = false; controller.current?.abort(); window.clearTimeout(timer.current); window.clearTimeout(deadline.current);
      document.removeEventListener('visibilitychange', visible); window.removeEventListener('camera-station.surveillance-updated', settings);
    };
  }, [poll, refresh]);
  useEffect(() => {
    const update = () => setModalOpen(!!document.querySelector('dialog[open]'));
    const fullscreen = () => setPortal(document.fullscreenElement ?? document.body);
    const observer = new MutationObserver(update);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    update(); document.addEventListener('fullscreenchange', fullscreen);
    return () => { observer.disconnect(); document.removeEventListener('fullscreenchange', fullscreen); };
  }, []);

  const read = useCallback(async (ids?: string[]) => {
    await api.readSurveillanceNotifications(ids ? { ids } : { all: true });
    if (!mounted.current) return;
    setQueue(current => ids ? current.filter(item => !ids.includes(item.id)) : []);
    refresh();
  }, [refresh]);
  const pin = useCallback(async (value: PinSelection) => {
    const result = await api.pinSurveillanceObject(value);
    if (mounted.current) setPins(current => [result, ...current.filter(item => item.id !== result.id)]);
    refresh();
  }, [refresh]);
  const unpin = useCallback(async (id: string) => {
    await api.unpinSurveillanceObject(id);
    if (mounted.current) setPins(current => current.filter(item => item.id !== id));
    refresh();
  }, [refresh]);
  const notice = queue[0];
  return <SurveillanceContext.Provider value={{ unread, pins, error, canManage: user?.role === 'admin', refresh, read, pin, unpin, watch: setTarget }}>
    {children}
    {createPortal(<>
      {notice && !modalOpen && !target && <aside className="surveillance-toast" role="status" aria-live="polite">
        <Icon name={isHealthNotice(notice)?'server':'shield'} size={22} /><div><strong>{surveillanceKinds[notice.kind]}</strong><span>{notice.camera_name}{!isHealthNotice(notice)&&` · ${notice.track_number ? `ID #${notice.track_number}` : 'Đối tượng'}`}</span><small>{surveillanceDetail(notice)}</small><div className="surveillance-toast-actions">{isHealthNotice(notice)?<Link to="/settings#health" onClick={()=>setQueue(value=>value.filter(item=>item.id!==notice.id))}>Kiểm tra máy chủ</Link>:<button type="button" onClick={() => { setQueue(value => value.filter(item => item.id !== notice.id)); setTarget({ cameraId: notice.camera_id, trackId: notice.track_id, notice }); }}>Theo dõi</button>}<Link to="/notifications" onClick={() => setQueue([])}>Thông báo{queue.length > 1 ? ` (${queue.length})` : ''}</Link></div></div>
        <button type="button" className="icon-button" aria-label="Ẩn thông báo mới" onClick={() => setQueue(value => value.filter(item => item.id !== notice.id))}><Icon name="close" size={18} /></button>
      </aside>}
      {target && <WatchDialog target={target} onClose={() => setTarget(null)} />}
    </>, portal)}
  </SurveillanceContext.Provider>;
}
