import { BrowserRouter, Routes, Route, Navigate, Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import Login from './pages/Login';
import Cameras from './pages/Cameras';
import Playback from './pages/Playback';
import Grid from './pages/Grid';
import Events from './pages/Events';
import Storage from './pages/Storage';
import Settings from './pages/Settings';
import { api, SessionUser, StorageStatus } from './api';
import Icon from './Icon';
import { isUiPreview } from './preview';
import { NavigationContext, SessionContext } from './ui';

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
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('camera-station.sidebar-collapsed') === 'true'; }
    catch { return false; }
  });
  const user = sessionUser.username;
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const page = location.pathname.startsWith('/playback') ? 'Playback' : location.pathname === '/cameras' ? 'Thiết bị' : location.pathname === '/events' ? 'Sự kiện' : location.pathname === '/settings' ? 'Cài đặt' : 'Live view';
  useEffect(() => {
    let cancelled = false;
    const ping = () => api.health().then((value) => { if (!cancelled) setConnected(value.ok); }).catch(() => { if (!cancelled) setConnected(false); });
    const loadStorage = () => api.storageStatus().then((value) => { if (!cancelled) setStorage(value); }).catch(() => undefined);
    void ping(); void loadStorage();
    window.addEventListener('camera-station.settings-updated', loadStorage);
    const timer = window.setInterval(ping, 15_000);
    const storageTimer = window.setInterval(loadStorage, 60_000);
    return () => { cancelled = true; clearInterval(timer); clearInterval(storageTimer); window.removeEventListener('camera-station.settings-updated', loadStorage); };
  }, []);
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => { setIsMobile(media.matches); setMobileOpen(false); };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    try { localStorage.setItem('camera-station.sidebar-collapsed', String(sidebarCollapsed)); }
    catch { /* Navigation still works when storage is unavailable. */ }
  }, [sidebarCollapsed]);
  const navigationExpanded = isMobile ? mobileOpen : !sidebarCollapsed;
  function toggleNavigation() {
    if (isMobile) setMobileOpen(value => !value);
    else setSidebarCollapsed(value => !value);
  }
  async function logout() {
    setLoggingOut(true); setLogoutError('');
    try { await api.logout(); navigate('/login'); }
    catch (error: any) { setLogoutError(error.message); }
    finally { setLoggingOut(false); }
  }

  return <SessionContext.Provider value={sessionUser}><NavigationContext.Provider value={{ expanded: navigationExpanded, toggle: toggleNavigation }}><div className={`app-shell simple-shell${location.pathname === '/live' ? ' live-shell' : ''}${location.pathname.startsWith('/playback/') ? ' playback-view-shell' : ''}${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
    {isMobile && mobileOpen && <button className="sidebar-shade" aria-label="Đóng điều hướng" onClick={() => setMobileOpen(false)} />}
    <aside id="app-navigation" className={`app-sidebar ${mobileOpen ? 'open' : ''}`} aria-hidden={!navigationExpanded}>
      <Link to="/live" className="app-brand" aria-label="Camera Station"><img className="brand-image" src="/brand/camera-mark.png" alt="" width="42" height="42" /><strong>Camera Station</strong></Link>
      <nav className="app-nav" aria-label="Điều hướng chính"><NavLink to="/live"><Icon name="monitor" /><span>Live view</span></NavLink><NavLink to="/playback"><Icon name="clock" /><span>Playback</span></NavLink><NavLink to="/cameras"><Icon name="camera" /><span>Thiết bị</span></NavLink><NavLink to="/events"><Icon name="bell" /><span>Sự kiện</span></NavLink><NavLink to="/settings"><Icon name="settings" /><span>Cài đặt</span></NavLink></nav>
      <div className="sidebar-bottom"><div className="sidebar-server"><span className="sidebar-server-label"><i className={`status-dot ${connected ? 'online' : 'error'}`} />{isUiPreview ? 'Xem trước UI · dữ liệu mẫu' : connected ? 'Máy chủ trực tuyến' : 'Mất kết nối máy chủ'}</span><button type="button" className="icon-button sidebar-refresh" onClick={() => window.location.reload()} title="Tải lại trang" aria-label="Tải lại trang"><Icon name="refresh" size={18} /></button></div><Link to="/playback" className={`simple-storage-link ${storage && storage.used_percent >= storage.cleanup_threshold_percent ? 'warning' : ''}`}><Icon name="database" size={16} /><span>Lưu trữ</span><b>{storage ? `${storage.used_percent}%` : '—'}</b></Link><div className="account"><span className="account-avatar">{user.slice(0, 1).toUpperCase()}</span><span><b>{user}</b></span><button type="button" onClick={() => void logout()} disabled={loggingOut} title="Đăng xuất" aria-label="Đăng xuất"><Icon name="logout" size={18} /></button></div></div>
    </aside>
    <div className="app-body"><header className="app-topbar"><button type="button" className="icon-button nav-toggle" onClick={toggleNavigation} aria-controls="app-navigation" aria-label={navigationExpanded ? 'Ẩn menu' : 'Hiện menu'} aria-expanded={navigationExpanded}><Icon name="menu" /></button><span>{page}{isUiPreview ? ' · UI mẫu' : ''}</span></header><main className="app-main">{logoutError && <div className="notice error" role="alert">{logoutError}</div>}{children}</main></div>
  </div></NavigationContext.Provider></SessionContext.Provider>;
}

export default function App() {
  return <BrowserRouter><Routes>
    <Route path="/login" element={<Login />} /><Route path="/" element={<Navigate to="/live" replace />} />
    <Route path="/cameras" element={<Protected><Cameras /></Protected>} /><Route path="/live" element={<Protected><Grid /></Protected>} /><Route path="/live/:id" element={<Navigate to="/live" replace />} />
    <Route path="/playback" element={<Protected><Storage /></Protected>} /><Route path="/playback/:id" element={<Protected><Playback /></Protected>} /><Route path="/events" element={<Protected><Events /></Protected>} />
    <Route path="/settings" element={<Protected><Settings /></Protected>} />
    <Route path="/grid" element={<Navigate to="/live" replace />} /><Route path="/storage" element={<Navigate to="/playback" replace />} /><Route path="*" element={<Navigate to="/live" replace />} />
  </Routes></BrowserRouter>;
}
