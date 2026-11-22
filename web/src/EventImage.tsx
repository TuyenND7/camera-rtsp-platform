import { useContext, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DetectionEvent, DetectionFrame } from './api';
import { DetectionBoxes } from './liveDetections';
import { lockBodyScroll } from './bodyScroll';
import Icon from './Icon';
import IdentityEnrollDialog from './IdentityEnrollDialog';
import { SessionContext } from './ui';
import ReviewActions from './ReviewActions';

function eventFrame(event: DetectionEvent): DetectionFrame | null {
  const data = event.metadata;
  return data?.width && data.height && Array.isArray(data.detections)
    ? { at: Date.parse(event.detected_at), width: data.width, height: data.height, detections: data.detections } : null;
}

export function EventThumbnail({ event, onOpen }: { event: DetectionEvent; onOpen: () => void }) {
  const [attempt, setAttempt] = useState(0), [loaded, setLoaded] = useState(false), [failed, setFailed] = useState(false);
  const retry = useRef<number>();
  const source = event.thumbnail_url ?? `/api/events/${event.id}/thumbnail`;
  useEffect(() => () => window.clearTimeout(retry.current), []);
  function error() {
    setLoaded(false);
    if (attempt < 3) retry.current = window.setTimeout(() => setAttempt(value => value + 1), (attempt + 1) * 1500);
    else setFailed(true);
  }
  return <button type="button" className="event-preview" onClick={onOpen} aria-label={`Xem ảnh gốc ${event.camera_name}`}>
    {!failed && <img src={`${source}${attempt ? `${source.includes('?') ? '&' : '?'}retry=${attempt}` : ''}`} alt={`Ảnh xem trước ${event.camera_name}`} loading="lazy" decoding="async" onLoad={() => setLoaded(true)} onError={error} />}
    {!loaded && <span className="event-image-status">{failed ? 'Ảnh chưa sẵn sàng' : 'Đang tải ảnh…'}</span>}
    {loaded && <DetectionBoxes frame={eventFrame(event)} />}
  </button>;
}

export function EventImageDialog({ event, playbackUrl, onClose }: { event: DetectionEvent; playbackUrl: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), user = useContext(SessionContext);
  const [enrolling, setEnrolling] = useState(false);
  const [loaded, setLoaded] = useState(false), [error, setError] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal(); const unlock = lockBodyScroll();
    return () => { dialog.current?.close(); unlock(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const original = `${event.snapshot_url}${attempt ? `?retry=${attempt}` : ''}`;
  return <dialog ref={dialog} className="device-dialog event-image-dialog" aria-labelledby="event-image-title" onCancel={onClose}>
    <header className="dialog-heading"><div><h2 id="event-image-title">{event.camera_name}</h2><p>{new Date(event.detected_at).toLocaleString('vi-VN')}</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Đóng ảnh sự kiện"><Icon name="close" /></button></header>
    <div className="event-original-picture">
      {!loaded && event.thumbnail_url && <img className="event-original-preview" src={event.thumbnail_url} alt="Ảnh xem trước" />}
      <img className={`event-original-image${loaded ? ' loaded' : ''}`} src={original} alt={`Ảnh gốc ${event.camera_name}`} onLoad={() => setLoaded(true)} onError={() => setError(true)} />
      {loaded && <DetectionBoxes frame={eventFrame(event)} />}
      {!loaded && <div className="event-original-loading" role="status">{error ? <button type="button" onClick={() => { setError(false); setAttempt(value => value + 1); }}>Tải lại ảnh gốc</button> : 'Đang tải ảnh gốc…'}</div>}
    </div>
    {user?.role === 'admin' && enrolling && <IdentityEnrollDialog event={event} onClose={() => setEnrolling(false)} onSuccess={() => setEnrolling(false)} />}
    <footer className="dialog-footer"><ReviewActions type="event" id={String(event.id)} cameraId={event.camera_id} cameraName={event.camera_name} at={event.detected_at}/>{user?.role === 'admin' && <button type="button" onClick={() => setEnrolling(true)}><Icon name="user" size={16} />Gán tên khuôn mặt</button>}<Link className="button" to={playbackUrl} onClick={onClose}><Icon name="clock" size={16} />Xem lại thời điểm này</Link><a className="button" href={event.snapshot_url ?? undefined} download>Tải ảnh gốc</a></footer>
  </dialog>;
}
