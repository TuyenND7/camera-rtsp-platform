import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type DetectionEvent, type IdentityJob, type IdentityPerson } from './api';
import { lockBodyScroll } from './bodyScroll';
import Icon from './Icon';

export default function IdentityEnrollDialog({ person, event, onClose, onSuccess }: { person?: IdentityPerson; event?: DetectionEvent; onClose: () => void; onSuccess: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), request = useRef<AbortController>(), sequence = useRef(0);
  const [people, setPeople] = useState<IdentityPerson[]>([]), [personId, setPersonId] = useState(person?.id ?? ''), [name, setName] = useState('');
  const [events, setEvents] = useState<DetectionEvent[] | null>(null), [job, setJob] = useState<IdentityJob | null>(null), [face, setFace] = useState('');
  const [busy, setBusy] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    const previous = document.activeElement, element = dialog.current;
    element?.showModal(); const unlock = lockBodyScroll();
    let active = true;
    void api.identities().then(value => { if (active) setPeople(value.people); }).catch(() => undefined);
    if (event) void analyze(Number(event.id));
    return () => { active = false; sequence.current++; request.current?.abort(); element?.close(); unlock(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  async function analyze(input: File | number) {
    if (saving) return;
    if (typeof input !== 'number' && (!['image/jpeg', 'image/png'].includes(input.type) || input.size > 4*1024*1024)) { setError('Chọn ảnh JPG/PNG nhỏ hơn 4 MB.'); return; }
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const current = ++sequence.current; setBusy(true); setError(''); setJob(null); setFace('');
    try {
      let result = await api.analyzeIdentityPhoto(input, controller.signal);
      const deadline = Date.now()+45000;
      while (result.state === 'processing' && Date.now() < deadline) {
        await new Promise<void>(resolve => { const timer = window.setTimeout(resolve, 700); controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
        if (controller.signal.aborted) return;
        result = await api.identityJob(result.id, controller.signal);
      }
      if (current !== sequence.current || controller.signal.aborted) return;
      if (result.state !== 'ready') throw Error(result.message || 'Xử lý ảnh quá lâu. Vui lòng thử lại.');
      setJob(result); setFace(result.faces?.length === 1 ? result.faces[0].id : '');
    } catch (err: any) { if (!controller.signal.aborted && current === sequence.current) setError(err.message); }
    finally { if (!controller.signal.aborted && current === sequence.current) setBusy(false); }
  }
  async function showEvents() {
    setError('');
    try { setEvents(await api.listEvents({ label: 'person', limit: 40 })); }
    catch (err: any) { setError(err.message); }
  }
  async function save() {
    if (!job || !face || saving) return;
    setSaving(true); setError('');
    try { await api.enrollIdentity({ job_id: job.id, face_id: face, ...(personId ? { person_id: personId } : { name: name.trim() }) }); onSuccess(); onClose(); }
    catch (err: any) { setError(err.message); }
    finally { setSaving(false); }
  }
  return createPortal(<dialog ref={dialog} className="device-dialog identity-enroll-dialog" aria-labelledby="identity-enroll-title" onCancel={e => { e.preventDefault(); e.stopPropagation(); if (!saving) onClose(); }}>
    <header className="dialog-heading"><div><h2 id="identity-enroll-title">{person ? `Thêm ảnh · ${person.name}` : 'Đăng ký khuôn mặt'}</h2><p>Chọn đúng khuôn mặt rồi gán tên.</p></div><button type="button" className="icon-button" disabled={saving} onClick={onClose} aria-label="Đóng đăng ký khuôn mặt"><Icon name="close" /></button></header>
    <div className="dialog-body">
      {!person && <div className="form-grid"><label>Hồ sơ<select aria-label="Hồ sơ định danh" value={personId} disabled={saving} onChange={e => setPersonId(e.target.value)}><option value="">Người mới</option>{people.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>{!personId && <label>Tên<input aria-label="Tên người đăng ký" placeholder="Ví dụ: Ông A" maxLength={60} value={name} disabled={saving} onChange={e => setName(e.target.value)} /></label>}</div>}
      <div className="identity-source-actions"><label className="button"><Icon name="folder" size={17} />Ảnh chân dung<input aria-label="Tải ảnh chân dung" type="file" accept="image/jpeg,image/png" disabled={saving} onChange={e => { const file = e.target.files?.[0]; if (file) void analyze(file); e.target.value = ''; }} /></label><button type="button" disabled={saving} onClick={() => void showEvents()}><Icon name="clock" size={17} />Ảnh sự kiện</button></div>
      {busy && <p className="identity-job-status" role="status">Đang tìm khuôn mặt…</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      {job?.faces && <div className="identity-face-options" role="group" aria-label="Chọn khuôn mặt">{job.faces.map(value => <button type="button" key={value.id} disabled={saving} aria-label={`Khuôn mặt ${Number(value.id)+1}`} aria-pressed={face === value.id} onClick={() => setFace(value.id)}><img src={value.image_url} alt={`Khuôn mặt ${Number(value.id)+1}`} />{face === value.id && <Icon name="check" size={18} />}</button>)}</div>}
      {!busy && !job && <p className="identity-hint">Dùng ảnh rõ mặt, đủ sáng. Có thể thêm nhiều ảnh cho cùng một người.</p>}
      {events && <div className="identity-event-list" aria-label="Chọn ảnh sự kiện">{events.length ? events.map(value => <button type="button" key={value.id} disabled={saving || busy} onClick={() => { setEvents(null); void analyze(Number(value.id)); }}><img src={value.thumbnail_url ?? `/api/events/${value.id}/thumbnail`} loading="lazy" decoding="async" alt={value.camera_name} /><span>{value.camera_name}</span><time>{new Date(value.detected_at).toLocaleString('vi-VN')}</time></button>) : <p>Chưa có ảnh sự kiện có người.</p>}</div>}
    </div>
    <footer className="dialog-footer"><button type="button" disabled={saving} onClick={onClose}>Hủy</button><button type="button" className="primary" disabled={saving || busy || !face || !job || !personId && !name.trim()} onClick={() => void save()}>{saving ? 'Đang đăng ký…' : 'Đăng ký'}</button></footer>
  </dialog>, document.body);
}
