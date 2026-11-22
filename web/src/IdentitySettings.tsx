import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type IdentityList, type IdentityPerson } from './api';
import Icon from './Icon';
import IdentityEnrollDialog from './IdentityEnrollDialog';
import { lockBodyScroll } from './bodyScroll';

function ProfileDialog({ person, onClose, onSuccess }: { person: IdentityPerson; onClose: () => void; onSuccess: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(person.name), [deleting, setDeleting] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { const previous = document.activeElement; dialog.current?.showModal(); const unlock = lockBodyScroll(); return () => { dialog.current?.close(); unlock(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); }; }, []);
  async function apply() {
    setBusy(true); setError('');
    try { if (deleting) await api.deleteIdentity(person.id); else await api.renameIdentity(person.id, name); onSuccess(); onClose(); }
    catch (err: any) { setError(err.message); }
    finally { setBusy(false); }
  }
  return createPortal(<dialog ref={dialog} className="device-dialog identity-profile-dialog" aria-labelledby="identity-profile-title" onCancel={e => { e.preventDefault(); e.stopPropagation(); if (!busy) onClose(); }}><header className="dialog-heading"><h2 id="identity-profile-title">{deleting ? 'Xóa hồ sơ?' : 'Sửa hồ sơ'}</h2></header><div className="dialog-body">{deleting ? <p>Xóa {person.name} và toàn bộ ảnh mẫu khuôn mặt của người này?</p> : <label>Tên<input value={name} aria-label="Đổi tên hồ sơ" maxLength={60} disabled={busy} onChange={e => setName(e.target.value)} /></label>}{error && <p className="notice error" role="alert">{error}</p>}</div><footer className="dialog-footer">{!deleting && <button type="button" className="danger" disabled={busy} onClick={() => setDeleting(true)}>Xóa hồ sơ</button>}<button type="button" disabled={busy} onClick={onClose}>Hủy</button><button type="button" className={deleting ? 'danger' : 'primary'} disabled={busy || !deleting && !name.trim()} onClick={() => void apply()}>{busy ? 'Đang xử lý…' : deleting ? 'Xóa' : 'Đổi tên'}</button></footer></dialog>, document.body);
}

export default function IdentitySettings() {
  const [value, setValue] = useState<IdentityList | null>(null), [error, setError] = useState('');
  const [enrolling, setEnrolling] = useState<IdentityPerson | 'new' | null>(null), [editing, setEditing] = useState<IdentityPerson | null>(null);
  useEffect(() => { if (window.location.hash === '#identities') document.getElementById('identities')?.scrollIntoView({ block: 'start' }); }, []);
  async function refresh() { try { setValue(await api.identities()); setError(''); } catch (err: any) { setError(err.message); } }
  useEffect(() => { let active = true; const load = () => { if (!document.hidden) void api.identities().then(v => { if (active) { setValue(v); setError(''); } }).catch(e => { if (active) setError(e.message); }); }; load(); const timer = setInterval(load, 10000); return () => { active = false; clearInterval(timer); }; }, []);
  return <section className="panel settings-section identity-settings" id="identities"><header className="settings-heading"><Icon name="user" size={22} /><div><h2>Định danh người</h2></div><button type="button" disabled={value?.status.state !== 'ready'} onClick={() => setEnrolling('new')}><Icon name="plus" size={17} />Thêm người</button></header>
    {value?.status.state !== 'ready' && <p className="identity-hint" role="status">{value?.status.message || 'Đang kiểm tra bộ nhận dạng…'}</p>}
    {value?.people.length === 0 && <p className="identity-hint">Chưa đăng ký người. Thêm ảnh chân dung hoặc chọn ảnh sự kiện.</p>}
    <div className="identity-people">{value?.people.map(person => <div className="identity-person" key={person.id}>{person.image_url && <img src={person.image_url} alt={person.name} loading="lazy" />}<div><strong>{person.name}</strong><small>{person.sample_count}/10 ảnh mẫu</small></div><button type="button" className="icon-button" aria-label={`Thêm ảnh ${person.name}`} disabled={value.status.state !== 'ready'} onClick={() => setEnrolling(person)}><Icon name="plus" size={18} /></button><button type="button" className="icon-button" aria-label={`Sửa hồ sơ ${person.name}`} onClick={() => setEditing(person)}><Icon name="edit" size={18} /></button></div>)}</div>
    <p className="identity-hint">Bật “Định danh khuôn mặt” trong cài đặt nhận dạng của từng camera. Xanh: đã xác định · Đỏ: chưa xác định.</p>
    {error && <p className="notice error" role="alert">{error}</p>}
    {enrolling && <IdentityEnrollDialog person={enrolling === 'new' ? undefined : enrolling} onClose={() => setEnrolling(null)} onSuccess={() => void refresh()} />}
    {editing && <ProfileDialog person={editing} onClose={() => setEditing(null)} onSuccess={() => void refresh()} />}
  </section>;
}
