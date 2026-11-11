import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setErr(''); setLoading(true);
    try {
      await api.login(username, password);
      navigate('/live');
    } catch (error: any) { setErr(error.message === 'Failed to fetch' ? 'Không thể kết nối máy chủ. Kiểm tra mạng và thử lại.' : error.message ?? 'Không thể đăng nhập'); }
    finally { setLoading(false); }
  }

  return <main className="login-simple">
    <form className="login-form" onSubmit={submit}><img className="login-brand-image" src="/brand/camera-mark.png" alt="" width="72" height="72" /><h2>Camera Station</h2><p>Đăng nhập quản trị</p><label>Tài khoản<input value={username} onChange={(event) => setUsername(event.target.value)} autoFocus autoComplete="username" required /></label><label>Mật khẩu<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>{err && <div className="notice error" role="alert">{err}</div>}<button className="button primary" type="submit" disabled={loading}>{loading ? 'Đang đăng nhập…' : 'Đăng nhập'}</button></form>
  </main>;
}
