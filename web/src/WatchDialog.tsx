import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Camera } from './api';
import Icon from './Icon';
import HlsPlayer from './HlsPlayer';
import DeviceControlPanel from './DeviceControlPanel';
import { LiveAiProvider, LiveDetectionOverlay, detectionLabel } from './liveDetections';
import { lockBodyScroll } from './bodyScroll';
import { useSurveillance, type WatchTarget } from './surveillanceContext';
import { surveillanceDetail, surveillanceKinds, surveillancePlaybackUrl } from './surveillanceLabels';

export default function WatchDialog({ target, onClose }: { target: WatchTarget; onClose: () => void }) {
  const surveillance = useSurveillance(), dialog = useRef<HTMLDialogElement>(null), id = useId();
  const [selection, setSelection] = useState(target), [cameras, setCameras] = useState<Camera[]>([]);
  const [error, setError] = useState(''), [controlOpen, setControlOpen] = useState(false), [busy, setBusy] = useState(false);
  const camera = cameras.find(item => item.id === selection.cameraId);
  const pin = surveillance?.pins.find(item => item.camera_id === selection.cameraId && item.track_id === selection.trackId);
  const fallback = selection.notice ?? selection.pin;
  const label = pin ? detectionLabel({ label: pin.label, track_number: pin.track_number, identity: pin.identity }) : fallback
    ? detectionLabel({ label: fallback.label, track_number: fallback.track_number ?? undefined, identity: fallback.identity }) : 'Camera trực tiếp';
  useEffect(() => {
    const element = dialog.current, previous = document.activeElement, unlock = lockBodyScroll();
    element?.showModal();
    return () => { element?.close(); unlock(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => { setSelection(target); }, [target]);
  useEffect(() => {
    let active = true, timer: number | undefined, controller: AbortController | undefined;
    const load = async () => {
      controller = new AbortController();
      try { const values = await api.listCameras(controller.signal); if (active) { setCameras(values); setError(''); } }
      catch { if (active) setError('Chưa cập nhật được trạng thái camera.'); }
      if (active) timer = window.setTimeout(() => void load(), 5000);
    };
    void load();
    return () => { active = false; controller?.abort(); window.clearTimeout(timer); };
  }, []);
  useEffect(() => {
    if (target.notice && !target.notice.read) void surveillance?.read([target.notice.id]).catch(() => undefined);
  }, [target.notice?.id]);

  return <dialog ref={dialog} className="device-dialog surveillance-watch-dialog" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!controlOpen) onClose(); }}>
    <header className="dialog-heading"><div><h2 id={`${id}-title`}>Theo dõi đối tượng</h2><p>{label}</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Đóng theo dõi đối tượng"><Icon name="close" /></button></header>
    <div className="surveillance-watch-body">
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="surveillance-watch-camera"><label htmlFor={`${id}-camera`}>Camera đang xem</label><select id={`${id}-camera`} value={selection.cameraId} onChange={event => setSelection({ cameraId: Number(event.target.value) })}>{!camera && <option value={selection.cameraId}>{fallback?.camera_name ?? 'Đang đọc camera…'}</option>}{cameras.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
      <LiveAiProvider cameraIds={camera?.enabled && camera.status === 'online' && camera.ai_enabled ? [camera.id] : []}>
        <WatchVideo key={selection.cameraId} cameraId={selection.cameraId} online={!!camera?.enabled && camera.status === 'online'} ready={!!camera} trackId={selection.trackId} snapshot={selection.notice?.snapshot_url ?? selection.pin?.snapshot_url ?? null} />
      </LiveAiProvider>
      <div className="surveillance-watch-status"><i className={`status-dot ${pin?.state === 'tracking' ? 'online' : 'connecting'}`} /><strong>{pin ? pin.state === 'tracking' ? 'Đang thấy đối tượng' : 'Chưa thấy lại đối tượng' : selection.trackId ? 'Đối chiếu ID trên hình trực tiếp' : 'Đang xem camera'}</strong>{pin && <time>Gặp gần nhất: {new Date(pin.last_seen_at).toLocaleString('vi-VN')}</time>}</div>
      {selection.notice && <section className="surveillance-watch-reason"><strong>{surveillanceKinds[selection.notice.kind]}</strong><p>{surveillanceDetail(selection.notice)}</p><time>{new Date(selection.notice.detected_at).toLocaleString('vi-VN')}</time></section>}
      {!!surveillance?.pins.length && <section className="surveillance-watch-pins"><h3>Đối tượng đã ghim</h3><div>{surveillance.pins.map(item => <button type="button" key={item.id} className={item.camera_id === selection.cameraId && item.track_id === selection.trackId ? 'selected' : ''} onClick={() => setSelection({ cameraId: item.camera_id, trackId: item.track_id, pin: item })}><span><strong>{detectionLabel({ label: item.label, track_number: item.track_number, identity: item.identity })}</strong><small>{item.camera_name} · {item.state === 'tracking' ? 'Đang thấy' : 'Chưa thấy lại'}</small></span><Icon name="chevronRight" size={16} /></button>)}</div></section>}
      <p className="surveillance-watch-hint">ID theo dõi liên tục trong từng camera. Đổi camera không tự xác nhận đó là cùng một người.</p>
    </div>
    <footer className="dialog-footer surveillance-watch-actions">
      <Link to={`/live?camera=${selection.cameraId}`} className="button" onClick={onClose}><Icon name="monitor" size={17} />Mở Live</Link>
      {selection.notice && <Link to={surveillancePlaybackUrl(selection.notice)} className="button" onClick={onClose}><Icon name="clock" size={17} />Xem lại</Link>}
      {pin && surveillance?.canManage && <button type="button" disabled={busy} onClick={() => { setBusy(true); setError(''); void surveillance.unpin(pin.id).catch(error => setError(error instanceof Error ? error.message : 'Chưa bỏ ghim được.')).finally(() => setBusy(false)); }}>Bỏ ghim</button>}
      {surveillance?.canManage && <button type="button" className="surveillance-alarm-action" disabled={!camera?.enabled || camera.status !== 'online'} onClick={() => setControlOpen(true)}><Icon name="bell" size={18} />Báo động…</button>}
    </footer>
    {controlOpen && camera && <DeviceControlPanel cameras={[camera]} onClose={() => setControlOpen(false)} />}
  </dialog>;
}

function WatchVideo({ cameraId, online, ready, trackId, snapshot }: { cameraId: number; online: boolean; ready: boolean; trackId?: string; snapshot: string | null }) {
  const [at, setAt] = useState<number | null>(null), [waiting, setWaiting] = useState(true);
  return <div className="surveillance-watch-video">
    {online ? <><HlsPlayer src={`/live/${cameraId}/index.m3u8`} live muted volume={0} controls={false} onLiveDate={setAt} onWaitingChange={setWaiting} /><LiveDetectionOverlay cameraId={cameraId} at={at} enabled focusTrackId={trackId} />{waiting && <span className="surveillance-video-note">Đang tải hình trực tiếp…</span>}</> : <>{snapshot && <img src={snapshot} alt="Ảnh tại thời điểm phát hiện" />}<span className="surveillance-video-note">{ready ? 'Camera chưa trực tuyến' : 'Đang đọc trạng thái camera…'}{snapshot ? ' · Ảnh đã lưu' : ''}</span></>}
  </div>;
}
