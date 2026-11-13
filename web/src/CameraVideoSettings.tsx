import { useEffect, useRef, useState } from 'react';
import { api, Camera, CameraVideoProfile, CameraVideoSettings as VideoSettings } from './api';
import Icon from './Icon';

type Values = { resolution: string; fps: string; bitrate: string };
const values = (p: CameraVideoProfile): Values => ({ resolution: `${p.width}x${p.height}`, fps: p.fps?.toString() ?? '', bitrate: p.bitrate?.toString() ?? '' });
export default function CameraVideoSettings({ camera, onBusy }: { camera: Camera; onBusy: (value: boolean) => void }) {
  const [settings, setSettings] = useState<VideoSettings | null>(null), [token, setToken] = useState('');
  const [form, setForm] = useState<Values>({ resolution: '', fps: '', bitrate: '' });
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const alive = useRef(true);
  const profile = settings?.profiles.find(item => item.token === token);
  function accept(result: VideoSettings, preferred?: string) {
    const selected = result.profiles.find(p => p.token === preferred) ?? result.profiles[0];
    setSettings(result); setToken(selected?.token ?? ''); if (selected) setForm(values(selected));
  }
  async function load() {
    setLoading(true); setError(''); setNotice('');
    try { const result = await api.cameraVideoSettings(camera.id); if (alive.current) accept(result, token); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Chưa đọc được cài đặt camera.'); }
    finally { if (alive.current) setLoading(false); }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [camera.id]);
  async function apply(event: React.FormEvent) {
    event.preventDefault(); if (!profile || saving) return;
    const [width, height] = form.resolution.split('x').map(Number);
    setSaving(true); onBusy(true); setError(''); setNotice('');
    try {
      const result = await api.setCameraVideoSettings(camera.id, { profile_token: token, revision: profile.revision, width, height,
        ...(profile.fps_range && form.fps ? { fps: Number(form.fps) } : {}), ...(profile.bitrate_range && form.bitrate ? { bitrate: Number(form.bitrate) } : {}) });
      if (alive.current) { accept(result, token); setNotice(result.confirmed ? 'Camera đã xác nhận cài đặt mới. Live có thể cần vài giây để cập nhật.' : 'Đã gửi lệnh. Camera chưa xác nhận đủ thông số; hãy đọc lại trạng thái.'); }
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Chưa áp dụng được cài đặt.'); }
    finally { if (alive.current) setSaving(false); onBusy(false); }
  }
  const changed = profile && JSON.stringify(form) !== JSON.stringify(values(profile));
  return <section className="camera-video-settings" aria-label="Cài đặt video trên camera">
    <div className="camera-settings-heading"><div><h3>Video và chất lượng</h3><p>Đọc các lựa chọn được thiết bị hỗ trợ.</p></div><button type="button" onClick={() => void load()} disabled={loading || saving}><Icon name="refresh" size={18} />Đọc lại</button></div>
    {loading && <p className="loading-state" role="status">Đang đọc cài đặt từ camera…</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
    {!loading && settings && !settings.supported && <p className="notice">{settings.reason || 'Camera chưa cung cấp cài đặt video qua ONVIF.'}</p>}
    {!loading && profile && <form onSubmit={apply}>
      <label>Luồng video<select value={token} disabled={saving} onChange={event => { const selected = settings?.profiles.find(p => p.token === event.target.value); if (selected) { setToken(selected.token); setForm(values(selected)); setError(''); setNotice(''); } }}>{settings?.profiles.map((p, index) => <option key={p.token} value={p.token}>Luồng {index + 1} · {p.name} · {p.width}×{p.height}</option>)}</select></label>
      <div className="camera-video-current"><span>Codec <strong>{profile.codec}</strong></span><span>Độ phân giải <strong>{profile.width}×{profile.height}</strong></span><span>FPS <strong>{profile.fps ?? '—'}</strong></span><span>Bitrate <strong>{profile.bitrate !== null ? `${profile.bitrate} kbps` : '—'}</strong></span></div>
      {!profile.editable && <p className="notice">Luồng này chỉ đọc được thông tin. Camera chưa cung cấp lựa chọn chỉnh sửa tương thích.</p>}
      <fieldset disabled={saving || !profile.editable}>
        <label>Độ phân giải<select value={form.resolution} onChange={event => setForm({ ...form, resolution: event.target.value })}>{!profile.resolutions.some(r => `${r.width}x${r.height}` === form.resolution) && <option value={form.resolution}>{profile.width}×{profile.height} · hiện tại</option>}{profile.resolutions.map(r => <option key={`${r.width}x${r.height}`} value={`${r.width}x${r.height}`}>{r.width}×{r.height}{r.height === 1080 ? ' · Full HD' : r.height === 720 ? ' · HD' : ''}</option>)}</select></label>
        <div className="form-grid"><label>Tốc độ khung hình (FPS)<input type="number" step={1} min={profile.fps_range?.min} max={profile.fps_range?.max} value={form.fps} disabled={!profile.fps_range} onChange={event => setForm({ ...form, fps: event.target.value })} required={!!profile.fps_range} /><small>{profile.fps_range ? `${profile.fps_range.min}–${profile.fps_range.max} FPS` : 'Thiết bị không cung cấp lựa chọn FPS'}</small></label><label>Bitrate (kbps)<input type="number" step={1} min={profile.bitrate_range?.min} max={profile.bitrate_range?.max} value={form.bitrate} disabled={!profile.bitrate_range} onChange={event => setForm({ ...form, bitrate: event.target.value })} required={!!profile.bitrate_range} /><small>{profile.bitrate_range ? `${profile.bitrate_range.min}–${profile.bitrate_range.max} kbps` : 'Thiết bị không cung cấp lựa chọn bitrate'}</small></label></div>
      </fieldset>
      <p className="camera-settings-note">Áp dụng trực tiếp vào camera, ảnh hưởng luồng live và các bản ghi mới sử dụng luồng này.</p>
      {notice && <p className="notice" role="status">{notice}</p>}
      <div className="camera-settings-apply"><button className="primary" type="submit" disabled={saving || !profile.editable || !changed}>{saving ? 'Đang áp dụng…' : 'Áp dụng vào camera'}</button></div>
    </form>}
    <div className="camera-settings-tip"><Icon name="monitor" size={22} /><p>Quay quét, preset và zoom nằm trong tab <strong>Xem trước</strong>.</p></div>
  </section>;
}
