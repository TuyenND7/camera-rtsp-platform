import { FormEvent, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type TendaAccountStatus } from './api';
import Icon from './Icon';

const labels: Record<TendaAccountStatus['state'], string> = {
  unavailable: 'Chưa sẵn sàng', login_required: 'Cần đăng nhập', connected: 'Đã kết nối', signing_in: 'Đang đăng nhập…', refreshing: 'Đang gia hạn…', retrying: 'Đang thử lại',
};
function LoginDialog({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), request = useRef<AbortController | null>(null), id = useId();
  const [account, setAccount] = useState(''), [password, setPassword] = useState(''), [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); return () => { request.current?.abort(); dialog.current?.close(); }; }, []);
  function close() { request.current?.abort(); setPassword(''); onClose(); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const controller = new AbortController(); request.current = controller; setBusy(true); setError('');
    try {
      await api.loginTenda(account.trim(), password, controller.signal);
      if (!controller.signal.aborted) { setPassword(''); onSuccess(); onClose(); }
    } catch (err: any) { if (!controller.signal.aborted) setError(err.message); }
    finally { if (!controller.signal.aborted) { setBusy(false); setPassword(''); } }
  }
  return createPortal(<dialog ref={dialog} className="device-dialog compact-device-dialog tenda-login-dialog" aria-labelledby={id} onCancel={event => { event.preventDefault(); close(); }}>
    <form onSubmit={event => void submit(event)}>
      <header className="dialog-heading"><div><h2 id={id}>Đăng nhập Tenda</h2><p>Tài khoản TDSEE đang sở hữu camera</p></div><button type="button" className="icon-button" onClick={close} aria-label="Đóng đăng nhập Tenda"><Icon name="close" /></button></header>
      <div className="dialog-body">
        <label>Email hoặc số điện thoại<input autoFocus autoComplete="username" name="tenda-account" value={account} onChange={event => setAccount(event.target.value)} placeholder="Email, 09… hoặc +84…" maxLength={254} disabled={busy} required /></label>
        <label>Mật khẩu<div className="tenda-password"><input type={show ? 'text' : 'password'} autoComplete="current-password" name="tenda-password" value={password} onChange={event => setPassword(event.target.value)} maxLength={128} disabled={busy} required /><button type="button" onClick={() => setShow(value => !value)} aria-pressed={show}>{show ? 'Ẩn' : 'Hiện'}</button></div></label>
        <p className="muted">Lưu phiên mã hóa trên máy chủ. Không lưu mật khẩu.</p>
        {error && <div className="notice error" role="alert">{error}</div>}
        {busy && <p role="status">Đang xác thực với Tenda…</p>}
      </div>
      <footer className="dialog-footer"><button type="button" onClick={close}>{busy ? 'Hủy đăng nhập' : 'Hủy'}</button><button type="submit" className="primary" disabled={busy || !account.trim() || !password}>{busy ? 'Đang đăng nhập…' : 'Đăng nhập'}</button></footer>
    </form>
  </dialog>, document.body);
}

export default function TendaAccountSettings() {
  const [status, setStatus] = useState<TendaAccountStatus | null>(null), [open, setOpen] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const secure = window.location.protocol === 'https:';
  useEffect(() => {
    let stopped = false;
    const refresh = () => { if (document.hidden) return; void api.tendaAccount().then(value => { if (!stopped) { setStatus(value); setError(''); } }).catch(err => { if (!stopped) setError(err.message); }); };
    refresh(); const timer = window.setInterval(refresh, 5000); document.addEventListener('visibilitychange', refresh);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  const state = status?.state ?? 'unavailable';
  const busy = state === 'signing_in' || state === 'refreshing';
  return <section className="panel settings-section tenda-account-settings">
    <header className="settings-heading"><Icon name="shield" size={22} /><div><h2>Tài khoản Tenda</h2></div><span className={`status-badge ${state === 'connected' ? 'online' : state === 'login_required' ? 'error' : 'connecting'}`}>{status ? labels[state] : 'Đang kiểm tra…'}</span></header>
    <div className="tenda-account-row"><div><strong>{status?.account_label || 'Mic, còi và đèn camera'}</strong><p className="muted">{status?.auto_refresh ? 'Tự gia hạn phiên trên máy chủ' : status?.sdk_ready ? 'Phiên hiện tại còn dùng được · Đăng nhập để tự gia hạn' : 'Đăng nhập bằng tài khoản TDSEE'}</p></div><button type="button" onClick={() => { setNotice(''); setOpen(true); }} disabled={!secure || !status?.available || busy}><Icon name="user" size={18} />{status?.account_label ? 'Đăng nhập lại' : 'Đăng nhập'}</button></div>
    {!secure && <p className="notice">Mở web bằng HTTPS để đăng nhập Tenda.</p>}
    {(error || status?.error) && <p className="notice error" role="alert">{error || status?.error}</p>}
    {notice && <p className="settings-save-status" role="status">{notice}</p>}
    {open && <LoginDialog onClose={() => setOpen(false)} onSuccess={() => { setNotice('Đã đăng nhập. Đang kiểm tra kênh điều khiển…'); void api.tendaAccount().then(setStatus).catch(() => undefined); }} />}
  </section>;
}
