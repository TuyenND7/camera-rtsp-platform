import { useEffect, useRef, useState } from 'react';
import { api, Camera, CameraVideoProfile, CameraVideoSettings as VideoSettings } from './api';
import Icon from './Icon';
import CameraSettingSelect, { SettingOption } from './CameraSettingSelect';

type Values = { resolution: string; fps: string; bitrate: string };
const values = (p: CameraVideoProfile): Values => ({ resolution: `${p.width}x${p.height}`, fps: p.fps?.toString() ?? '', bitrate: p.bitrate?.toString() ?? '' });
function choices(common: number[], limits: { min: number; max: number } | null, current: number | null) {
  const available = limits ? [...common, Math.ceil(limits.min), Math.floor(limits.max)].filter(value => Number.isInteger(value) && value >= limits.min && value <= limits.max) : [];
  if (current !== null) available.push(current);
  return [...new Set(available)].sort((a, b) => a - b);
}
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
        ...(profile.fps_range && form.fps && Number(form.fps) !== profile.fps ? { fps: Number(form.fps) } : {}), ...(profile.bitrate_range && form.bitrate && Number(form.bitrate) !== profile.bitrate ? { bitrate: Number(form.bitrate) } : {}) });
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
      <CameraSettingSelect label="Luồng video" value={token} disabled={saving} icon="video" columns={1} description="Chọn luồng để xem và điều chỉnh thông số video." options={settings?.profiles.map((p, index) => ({ value: p.token, label: /^PROFILE[_ -]?\d+$/i.test(p.name) ? `Luồng ${index + 1}` : p.name, description: `${p.width}×${p.height} · ${p.codec === 'H264' ? 'H.264' : p.codec}${p.fps ? ` · ${p.fps} FPS` : ''}` })) ?? []} onChange={next => { const selected = settings?.profiles.find(p => p.token === next); if (selected) { setToken(selected.token); setForm(values(selected)); setError(''); setNotice(''); } }} />
      <div className="camera-video-current"><span>Codec <strong>{profile.codec}</strong></span><span>Độ phân giải <strong>{profile.width}×{profile.height}</strong></span><span>FPS <strong>{profile.fps ?? '—'}</strong></span><span>Bitrate <strong>{profile.bitrate !== null ? `${profile.bitrate} kbps` : '—'}</strong></span></div>
      {!profile.editable && <p className="notice">Luồng này chỉ đọc được thông tin. Camera chưa cung cấp lựa chọn chỉnh sửa tương thích.</p>}
      <fieldset disabled={saving || !profile.editable}>
        <CameraSettingSelect label="Độ phân giải" value={form.resolution} icon="monitor" disabled={saving || !profile.editable} description="Chọn kích thước hình ảnh được camera hỗ trợ." options={resolutionChoices(profile)} onChange={next => setForm({ ...form, resolution: next })} />
        <div className="form-grid">
          <CameraSettingSelect label="Tốc độ khung hình" value={form.fps} icon="play" disabled={saving || !profile.editable || !profile.fps_range} description="FPS cao giúp các chuyển động trong hình mượt hơn." help={profile.fps_range ? 'FPS cao giúp hình chuyển động mượt hơn.' : 'Thiết bị không cung cấp lựa chọn FPS'} options={choices([1, 2, 5, 10, 12, 15, 20, 24, 25, 30, 50, 60], profile.fps_range, profile.fps).map(value => ({ value: String(value), label: `${value} FPS`, description: `${value} khung hình mỗi giây`, current: value === profile.fps }))} onChange={next => setForm({ ...form, fps: next })} />
          <CameraSettingSelect label="Chất lượng luồng" value={form.bitrate} icon="settings" disabled={saving || !profile.editable || !profile.bitrate_range} description="Bitrate cao cho ảnh rõ hơn, dùng thêm mạng và bộ nhớ." help={profile.bitrate_range ? 'Bitrate cao cho ảnh rõ hơn, dùng thêm mạng và bộ nhớ.' : 'Thiết bị không cung cấp lựa chọn bitrate'} options={choices([32, 64, 128, 256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096, 6144, 8192, 12288, 16384, 24576, 32768, 49152, 65536], profile.bitrate_range, profile.bitrate).map(value => ({ value: String(value), label: `${value.toLocaleString('vi-VN')} kbps`, description: `${(value / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} Mbps`, current: value === profile.bitrate }))} onChange={next => setForm({ ...form, bitrate: next })} />
        </div>
      </fieldset>
      <p className="camera-settings-note">Áp dụng trực tiếp vào camera, ảnh hưởng luồng live và các bản ghi mới sử dụng luồng này.</p>
      {notice && <p className="notice" role="status">{notice}</p>}
      <div className="camera-settings-apply"><button className="primary" type="submit" disabled={saving || !profile.editable || !changed}>{saving ? 'Đang áp dụng…' : 'Áp dụng vào camera'}</button></div>
    </form>}
    <div className="camera-settings-tip"><Icon name="monitor" size={22} /><p>Quay quét, preset và zoom nằm trong tab <strong>Xem trước</strong>.</p></div>
  </section>;
}

function resolutionChoices(profile: CameraVideoProfile): SettingOption[] {
  const list = [...profile.resolutions];
  if (profile.width && profile.height && !list.some(r => r.width === profile.width && r.height === profile.height)) list.unshift({ width: profile.width, height: profile.height });
  return list.map(r => ({ value: `${r.width}x${r.height}`, label: r.width === 1920 && r.height === 1080 ? 'Full HD · 1080p' : r.width === 1280 && r.height === 720 ? 'HD · 720p' : `${r.width}×${r.height}`, description: `${r.width}×${r.height} điểm ảnh`, current: r.width === profile.width && r.height === profile.height }));
}
