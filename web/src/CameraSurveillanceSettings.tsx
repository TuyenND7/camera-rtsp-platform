import { useEffect, useRef, useState } from 'react';
import { api, type Camera, type SurveillanceConfig, type SurveillanceZone } from './api';
import Icon from './Icon';
import RegionEditor from './RegionEditor';
import { regionDraftChanged } from './regionGeometry';
import './surveillance-settings.css';

type ToggleKey = 'zones_enabled' | 'intrusion_enabled' | 'loitering_enabled' | 'pacing_enabled' | 'unfamiliar_enabled' | 'manual_pin_enabled' | 'auto_pin_enabled' | 'popup_enabled';

export default function CameraSurveillanceSettings({ camera, onBusy, disabled = false }: {
  camera: Camera; onBusy: (value: boolean) => void; disabled?: boolean;
}) {
  const [settings, setSettings] = useState<SurveillanceConfig | null>(null), [draftZones, setDraftZones] = useState<SurveillanceZone[]>([]);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [editingRegion, setEditingRegion] = useState(false);
  const generation = useRef(0), alive = useRef(false), locked = useRef(false), onBusyRef = useRef(onBusy);
  onBusyRef.current = onBusy;
  const dirty = !!settings && regionDraftChanged(settings.zones, draftZones);
  const busy = disabled || loading || saving;
  const optionsDisabled = busy || dirty;
  const personEnabled = camera.ai_labels?.includes('person') ?? true;

  useEffect(() => { onBusyRef.current(loading || saving || dirty); }, [loading, saving, dirty]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current++; onBusyRef.current(false); };
  }, []);
  useEffect(() => {
    setSettings(null); setDraftZones([]); setEditingRegion(false);
    void load();
  }, [camera.id]);

  async function load() {
    const request = ++generation.current;
    locked.current = true; setLoading(true); setError(''); setNotice('');
    try {
      const result = await api.surveillanceSettings(camera.id);
      if (alive.current && generation.current === request) { setSettings(result); setDraftZones(result.zones); }
    } catch (error) {
      if (alive.current && generation.current === request) setError(error instanceof Error ? error.message : 'Chưa đọc được cài đặt giám sát.');
    } finally {
      if (alive.current && generation.current === request) { locked.current = false; setLoading(false); }
    }
  }
  async function change(patch: Partial<SurveillanceConfig>) {
    if (!settings || locked.current || disabled) return;
    const next = { ...settings, ...patch }, request = ++generation.current;
    locked.current = true; setSaving(true); setError(''); setNotice('');
    try {
      const result = await api.updateSurveillanceSettings(camera.id, next);
      if (alive.current && generation.current === request) {
        setSettings(result); setDraftZones(result.zones); setNotice('Đã áp dụng.');
        window.dispatchEvent(new Event('camera-station.surveillance-updated'));
      }
    } catch (error) {
      if (alive.current && generation.current === request) setError(error instanceof Error ? error.message : 'Chưa lưu được cài đặt giám sát.');
    } finally {
      if (alive.current && generation.current === request) { locked.current = false; setSaving(false); }
    }
  }
  function toggle(key: ToggleKey, checked: boolean) {
    if (key === 'zones_enabled' && checked && !settings?.zones.length) {
      setError('Vẽ và áp dụng ít nhất một vùng trước khi bật giới hạn nhận dạng.'); return;
    }
    void change({ [key]: checked });
  }
  function switchRow(key: ToggleKey, title: string, unavailable = false) {
    return <label className="surveillance-switch-row"><span>{title}</span><input type="checkbox" role="switch" checked={settings?.[key] ?? false} disabled={optionsDisabled || (unavailable && !settings?.[key])} onChange={event => toggle(key, event.target.checked)} /></label>;
  }

  return <section className="camera-surveillance-settings" aria-label="Vùng nhận dạng và giám sát" data-settings-unsaved={dirty ? true : undefined}>
    <div className="camera-settings-heading"><div><h3>Vùng nhận dạng và giám sát</h3></div><button type="button" disabled={busy || dirty} onClick={() => void load()} aria-label="Đọc lại cấu hình giám sát"><Icon name="refresh" size={17} /></button></div>
    {loading && <p className="surveillance-hint" role="status">Đang đọc cấu hình…</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
    {!loading && settings && <>
      <div className="surveillance-group">
        {switchRow('zones_enabled', 'Chỉ nhận dạng trong vùng đã vẽ')}
        <div className="surveillance-region-summary"><span>{settings.zones.length ? `${settings.zones.length} vùng nhận dạng` : 'Toàn bộ khung hình'}</span><button type="button" disabled={busy || dirty} onClick={() => setEditingRegion(value => !value)} aria-expanded={editingRegion}><Icon name={editingRegion ? 'chevronDown' : 'edit'} size={17} />{editingRegion ? 'Thu gọn' : 'Chỉnh vùng'}</button></div>
        {editingRegion && <RegionEditor key={camera.id} camera={camera} zones={draftZones} onChange={zones => { setDraftZones(zones); setNotice(''); setError(''); }} disabled={busy} />}
        {dirty && <div className="region-apply-row"><span>{!draftZones.length && settings.zones_enabled ? 'Xóa vùng cuối sẽ tắt giới hạn vùng.' : 'Vùng chưa được áp dụng.'}</span><div><button type="button" disabled={busy} onClick={() => { setDraftZones(settings.zones); setError(''); }}>Hủy chỉnh sửa</button><button type="button" className="primary" disabled={busy} onClick={() => void change({ zones: draftZones, ...(!draftZones.length ? { zones_enabled: false } : {}) })}>{saving ? 'Đang áp dụng…' : 'Áp dụng vùng'}</button></div></div>}
      </div>
      <div className="surveillance-group">
        <h4>Cảnh báo khi có người</h4>
        {!personEnabled && <p className="surveillance-hint">Chọn đối tượng Người để dùng cảnh báo.</p>}
        {switchRow('intrusion_enabled', 'Xâm nhập vùng', !personEnabled)}
        {settings.intrusion_enabled && <label className="surveillance-select-row"><span>Hiện diện tối thiểu</span><select aria-label="Thời gian xác nhận xâm nhập" disabled={optionsDisabled} value={settings.intrusion_seconds} onChange={event => void change({ intrusion_seconds: Number(event.target.value) })}>{[2, 3, 5, 10].map(value => <option key={value} value={value}>{value} giây</option>)}</select></label>}
        {switchRow('loitering_enabled', 'Lảng vảng kéo dài', !personEnabled)}
        {settings.loitering_enabled && <label className="surveillance-select-row"><span>Thời gian lảng vảng</span><select aria-label="Thời gian lảng vảng" disabled={optionsDisabled} value={settings.loitering_seconds} onChange={event => void change({ loitering_seconds: Number(event.target.value) })}>{[15, 30, 60, 120, 300].map(value => <option key={value} value={value}>{value < 60 ? `${value} giây` : `${value / 60} phút`}</option>)}</select></label>}
        {switchRow('pacing_enabled', 'Đi qua lại nhiều lần', !personEnabled)}
        {settings.pacing_enabled && <div className="surveillance-select-pair"><label className="surveillance-select-row"><span>Số lần đổi hướng</span><select aria-label="Số lần đổi hướng" disabled={optionsDisabled} value={settings.pacing_reversals} onChange={event => void change({ pacing_reversals: Number(event.target.value) })}>{[3, 4, 5].map(value => <option key={value} value={value}>{value} lần</option>)}</select></label><label className="surveillance-select-row"><span>Trong khoảng</span><select aria-label="Khoảng theo dõi đi qua lại" disabled={optionsDisabled} value={settings.pacing_window_seconds} onChange={event => void change({ pacing_window_seconds: Number(event.target.value) })}>{[30, 60, 120].map(value => <option key={value} value={value}>{value < 60 ? `${value} giây` : `${value / 60} phút`}</option>)}</select></label></div>}
        {switchRow('unfamiliar_enabled', 'Khuôn mặt chưa đăng ký', !camera.ai_identity_enabled || !personEnabled)}
        {settings.unfamiliar_enabled && <p className="surveillance-hint">Đối chiếu khuôn mặt đủ rõ với người đã đăng ký.</p>}
        {!camera.ai_identity_enabled && <p className="surveillance-hint">Bật định danh khuôn mặt trước.</p>}
      </div>
      <div className="surveillance-group">
        <h4>Ghim và thông báo</h4>
        {switchRow('manual_pin_enabled', 'Cho phép ghim thủ công trên Live')}
        {switchRow('auto_pin_enabled', 'Tự ghim đối tượng có cảnh báo')}
        {switchRow('popup_enabled', 'Hiện popup khi có cảnh báo mới')}
      </div>
      <p className="surveillance-hint">Còi chỉ bật sau khi bạn xác nhận.</p>
    </>}
    {notice && <p className="surveillance-save-status" role="status">{notice}</p>}
  </section>;
}
