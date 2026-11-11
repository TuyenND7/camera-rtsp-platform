import { BrowserRouter, Routes, Route, Navigate, Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import Login from './pages/Login';
import Cameras from './pages/Cameras';
import Playback from './pages/Playback';
import Grid from './pages/Grid';
import Events from './pages/Events';
import Storage from './pages/Storage';
import { api, SessionUser, StorageStatus } from './api';
import Icon from './Icon';

function Protected({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null | undefined>();
  const [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    void api.session().then((value) => { if (!stopped) setUser(value); }).catch(() => { if (!stopped) setError('Không thể kiểm tra phiên đăng nhập. Vui lòng tải lại trang.'); });
    return () => { stopped = true; };
  }, []);
  if (error) return <main className="loading-state" role="alert">{error}</main>;
  if (user === undefined) return <main className="loading-state">Đang kiểm tra đăng nhập…</main>;
  if (!user) return <Navigate to="/login" replace />;
  return <Layout user={user}>{children}</Layout>;
}

function Layout({ children, user: sessionUser }: { children: React.ReactNode; user: SessionUser }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [connected, setConnected] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const user = sessionUser.username;
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const page = location.pathname.startsWith('/playback') ? 'Playback' : location.pathname === '/cameras' ? 'Thiết bị' : location.pathname === '/events' ? 'Sự kiện' : 'Live view';
  useEffect(() => {
    let cancelled = false;
    const ping = () => api.health().then((value) => { if (!cancelled) setConnected(value.ok); }).catch(() => { if (!cancelled) setConnected(false); });
    const loadStorage = () => api.storageStatus().then((value) => { if (!cancelled) setStorage(value); }).catch(() => undefined);
    void ping(); void loadStorage();
    const timer = window.setInterval(ping, 15_000);
    const storageTimer = window.setInterval(loadStorage, 60_000);
    return () => { cancelled = true; clearInterval(timer); clearInterval(storageTimer); };
  }, []);
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);
  async function logout() {
    setLoggingOut(true); setLogoutError('');
    try { await api.logout(); navigate('/login'); }
    catch (error: any) { setLogoutError(error.message); }
    finally { setLoggingOut(false); }
  }

  return <div className="app-shell simple-shell">
    {mobileOpen && <button className="sidebar-shade" aria-label="Đóng điều hướng" onClick={() => setMobileOpen(false)} />}
    <aside className={`app-sidebar ${mobileOpen ? 'open' : ''}`}>
      <Link to="/live" className="app-brand" aria-label="Camera Station"><img className="brand-image" src="/brand/camera-mark.png" alt="" width="42" height="42" /><strong>Camera Station</strong></Link>
      <nav className="app-nav" aria-label="Điều hướng chính"><NavLink to="/live"><Icon name="monitor" /><span>Live view</span></NavLink><NavLink to="/playback"><Icon name="clock" /><span>Playback</span></NavLink><NavLink to="/cameras"><Icon name="settings" /><span>Thiết bị</span></NavLink><NavLink to="/events"><Icon name="bell" /><span>Sự kiện</span></NavLink></nav>
      <div className="sidebar-bottom"><span className="sidebar-server"><i className={`status-dot ${connected ? 'online' : 'error'}`} />{connected ? 'Máy chủ trực tuyến' : 'Mất kết nối máy chủ'}</span><Link to="/playback" className={`simple-storage-link ${storage && storage.used_percent >= storage.cleanup_threshold_percent ? 'warning' : ''}`}><Icon name="database" size={16} /><span>Lưu trữ</span><b>{storage ? `${storage.used_percent}%` : '—'}</b></Link><div className="account"><span className="account-avatar">{user.slice(0, 1).toUpperCase()}</span><span><b>{user}</b></span><button type="button" onClick={() => void logout()} disabled={loggingOut} title="Đăng xuất" aria-label="Đăng xuất"><Icon name="logout" size={18} /></button></div></div>
    </aside>
    <div className="app-body"><header className="app-topbar"><button type="button" className="icon-button nav-toggle" onClick={() => setMobileOpen(!mobileOpen)} aria-label="Mở điều hướng" aria-expanded={mobileOpen}><Icon name="menu" /></button><span>{page}</span></header><main className="app-main">{logoutError && <div className="notice error" role="alert">{logoutError}</div>}{children}</main></div>
  </div>;
}

export default function App() {
  return <BrowserRouter><Routes>
    <Route path="/login" element={<Login />} /><Route path="/" element={<Navigate to="/live" replace />} />
    <Route path="/cameras" element={<Protected><Cameras /></Protected>} /><Route path="/live" element={<Protected><Grid /></Protected>} /><Route path="/live/:id" element={<Navigate to="/live" replace />} />
    <Route path="/playback" element={<Protected><Storage /></Protected>} /><Route path="/playback/:id" element={<Protected><Playback /></Protected>} /><Route path="/events" element={<Protected><Events /></Protected>} />
    <Route path="/grid" element={<Navigate to="/live" replace />} /><Route path="/storage" element={<Navigate to="/playback" replace />} /><Route path="*" element={<Navigate to="/live" replace />} />
  </Routes></BrowserRouter>;
}
