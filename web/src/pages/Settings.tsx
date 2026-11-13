import { useContext, useEffect, useRef, useState } from 'react';
import { api, type ServerSettings, type SettingsInfo, type StorageStatus } from '../api';
import Icon from '../Icon';
import { formatBytes, PageHeader, SessionContext } from '../ui';
import { TEXT_SIZES, useTheme } from '../theme';
import CameraSettingSelect from '../CameraSettingSelect';
import { alarmDurations, alarmDurationLabel } from '../alarm';
import ViewingDeviceSettings from '../ViewingDeviceSettings';

function numericOptions(current: number, values: number[], label: (value: number) => string) {
  return [...new Set([...values, current])].sort((a, b) => a - b).map(value => ({ value: String(value), label: label(value) }));
}
function applyOnEnter(event: React.KeyboardEvent<HTMLInputElement>) {
  if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
}
function normalizeSettings(value: ServerSettings): ServerSettings {
  const result = { ...value, storage_label: value.storage_label.trim(), public_base_url: value.public_base_url.trim() };
  if (!result.storage_label || result.storage_label.length > 100) throw new Error('Tên ổ lưu trữ cần từ 1 đến 100 ký tự.');
  if (result.public_base_url) {
    try {
      const url = new URL(result.public_base_url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || result.public_base_url.length > 2048) throw new Error();
      result.public_base_url = url.origin;
    } catch { throw new Error('Địa chỉ máy chủ phải là HTTP/HTTPS, không chứa tài khoản hay mật khẩu.'); }
  }
  if (result.cleanup_target_percent >= result.cleanup_threshold_percent) throw new Error('Mức dung lượng sau khi dọn phải thấp hơn ngưỡng bắt đầu dọn.');
  return result;
}
function mergeApplied(current: ServerSettings, submitted: ServerSettings, applied: ServerSettings): ServerSettings {
  return Object.fromEntries(Object.keys(applied).map(name => {
    const key = name as keyof ServerSettings;
    return [key, current[key] === submitted[key] ? applied[key] : current[key]];
  })) as unknown as ServerSettings;
}

export default function Settings() {
  const user = useContext(SessionContext);
  const admin = user?.role === 'admin';
  const { theme, setTheme, textSize, setTextSize } = useTheme();
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [form, setForm] = useState<ServerSettings | null>(null);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [loading, setLoading] = useState(admin);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [connection, setConnection] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState(false);
  const mounted = useRef(false), desired = useRef<ServerSettings | null>(null), applied = useRef<ServerSettings | null>(null);
  const saveQueue = useRef(Promise.resolve()), pendingSaves = useRef(0), editVersion = useRef(0);

  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    if (admin) void api.getSettings().then(value => {
      if (!stopped) { setInfo(value); setForm(value.settings); desired.current = value.settings; applied.current = value.settings; }
    }).catch(err => { if (!stopped) setError(err.message); }).finally(() => { if (!stopped) setLoading(false); });
    void api.storageStatus().then(value => { if (!stopped) setStorage(value); }).catch(() => undefined);
    void api.health().then(value => { if (!stopped) setConnection(value.ok); }).catch(() => { if (!stopped) setConnection(false); });
    return () => { stopped = true; mounted.current = false; };
  }, [admin]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 2000);
    return () => clearTimeout(timer);
  }, [notice]);

  function draftChange<K extends keyof ServerSettings>(key: K, value: ServerSettings[K]) {
    editVersion.current++;
    setForm(current => current ? { ...current, [key]: value } : current);
    setNotice(''); setError(''); setCopied(false);
  }

  function change<K extends keyof ServerSettings>(key: K, value: ServerSettings[K]) {
    if (!desired.current) return;
    try {
      const next = normalizeSettings({ ...desired.current, [key]: value });
      draftChange(key, next[key]);
      enqueueSave(next);
    } catch (err: any) { setError(err.message); }
  }

  function enqueueSave(next: ServerSettings) {
    desired.current = next;
    if (!pendingSaves.current && JSON.stringify(next) === JSON.stringify(applied.current)) return;
    pendingSaves.current++; setSaving(true); setError(''); setNotice('');
    const submitted = { ...next };
    const version = editVersion.current;
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        if (JSON.stringify(submitted) === JSON.stringify(applied.current)) return;
        const result = await api.saveSettings(submitted);
        applied.current = result.settings;
        if (desired.current) desired.current = mergeApplied(desired.current, submitted, result.settings);
        if (mounted.current) {
          setInfo(current => current ? { ...current, settings: result.settings } : current);
          setForm(current => current ? mergeApplied(current, submitted, result.settings) : current);
          if (editVersion.current === version) { setError(''); setNotice('Đã áp dụng'); }
        }
        window.dispatchEvent(new Event('camera-station.settings-updated'));
        void api.storageStatus().then(value => { if (mounted.current) setStorage(value); }).catch(() => undefined);
      } catch (err: any) { if (mounted.current) setError(err.message); }
      finally { pendingSaves.current--; if (mounted.current) setSaving(pendingSaves.current > 0); }
    });
  }

  async function check() {
    setChecking(true);
    try { setConnection((await api.health()).ok); }
    catch { setConnection(false); }
    finally { setChecking(false); }
  }

  async function copyAddress() {
    let address;
    try {
      const url = new URL(form?.public_base_url.trim() || window.location.origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
      address = `${url.origin}/live`;
    } catch { setError('Nhập địa chỉ máy chủ HTTP/HTTPS hợp lệ để sao chép.'); return; }
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(address);
      else {
        const input = document.createElement('textarea'); input.value = address; input.style.position = 'fixed'; input.style.opacity = '0';
        document.body.appendChild(input); input.select();
        try { if (!document.execCommand('copy')) throw new Error(); } finally { input.remove(); }
      }
      setCopied(true);
    } catch { setError('Chưa sao chép được. Bạn có thể chọn và sao chép địa chỉ trong ô nhập.'); }
  }

  const dirty = form && info && JSON.stringify(form) !== JSON.stringify(info.settings);
  const connectionButton = <button type="button" onClick={() => void check()} disabled={checking}><Icon name="refresh" size={16} />{checking ? 'Đang kiểm tra…' : 'Kiểm tra kết nối'}</button>;
  return <section className="settings-page" data-settings-unsaved={dirty || saving ? 'true' : undefined}>
    <PageHeader title="Cài đặt" />
    <section className="panel settings-section appearance-settings">
      <div className="theme-setting">
        <header className="settings-heading"><Icon name="sun" size={22} /><div><h2>Giao diện</h2></div></header>
        <div className="theme-options" role="group" aria-label="Chế độ giao diện">
          {(['light', 'dark'] as const).map(value => <button type="button" key={value} className={`theme-option${theme === value ? ' active' : ''}`} onClick={() => setTheme(value)} aria-pressed={theme === value}><span className={`theme-swatch ${value}`}><i /><i /><i /></span><span className="theme-option-label"><Icon name={value === 'light' ? 'sun' : 'moon'} size={18} />{value === 'light' ? 'Sáng' : 'Tối'}</span>{theme === value && <Icon name="check" size={18} />}</button>)}
        </div>
      </div>
      <div className="text-size-setting">
        <h3 id="text-size-title">Cỡ chữ</h3>
        <div className="text-size-options" role="group" aria-labelledby="text-size-title">
          {TEXT_SIZES.map(option => <button type="button" key={option.value} className={`text-size-option${textSize === option.value ? ' active' : ''}`} data-text-size-option={option.value} aria-pressed={textSize === option.value} aria-label={`Cỡ chữ ${option.label}, ${option.value}%`} onClick={() => setTextSize(option.value)}>
            <span className="text-size-sample" style={{ fontSize: `${18 * option.value / 100}px` }} aria-hidden="true">Aa</span>
            <strong>{option.label}</strong><small>{option.value}%</small>
            {textSize === option.value && <Icon name="check" size={18} />}
          </button>)}
        </div>
      </div>
    </section>

    <ViewingDeviceSettings />
    <form onSubmit={event => { event.preventDefault(); if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); }} className="settings-form">
      <section className="panel settings-section">
        <header className="settings-heading"><Icon name="server" size={22} /><div><h2>Máy chủ</h2></div><span className={`status-badge ${connection === true ? 'online' : connection === false ? 'error' : 'connecting'}`}><i className={`status-dot ${connection === true ? 'online' : connection === false ? 'error' : 'connecting'}`} />{connection === null ? 'Đang kiểm tra' : connection ? 'Trực tuyến' : 'Mất kết nối'}</span></header>
        {admin && form && <label>Địa chỉ web để chia sẻ<div className="settings-address"><input type="url" value={form.public_base_url} onChange={event => draftChange('public_base_url', event.target.value)} onBlur={event => change('public_base_url', event.target.value)} onKeyDown={applyOnEnter} placeholder={window.location.origin} maxLength={2048} /><div className="settings-address-actions"><button type="button" onClick={() => void copyAddress()}>{copied ? 'Đã sao chép' : 'Sao chép link'}</button>{connectionButton}</div></div></label>}
        {!admin && connectionButton}
      </section>

      {admin && form && <section className="panel settings-section alarm-settings-section">
        <header className="settings-heading"><Icon name="bell" size={22} /><div><h2>Báo động</h2></div></header>
        <CameraSettingSelect label="Thời lượng báo động" value={String(form.alarm_duration_seconds ?? 30)} options={alarmDurations.map(seconds => ({ value: String(seconds), label: alarmDurationLabel(seconds) }))} onChange={value => change('alarm_duration_seconds', Number(value))} description="Chọn thời lượng phát còi." icon="bell" />
      </section>}
      {admin && <section className="panel settings-section storage-settings-section">
        <header className="settings-heading"><Icon name="database" size={22} /><div><h2>Lưu trữ & ghi hình</h2></div>{storage && <span className="subtle-badge">Đã dùng {storage.used_percent}%</span>}</header>
        {loading && <p className="muted" role="status">Đang tải cấu hình…</p>}
        {form && <>
          <div className="settings-fields">
            <label>Tên ổ lưu trữ<input value={form.storage_label} onChange={event => draftChange('storage_label', event.target.value)} onBlur={event => change('storage_label', event.target.value)} onKeyDown={applyOnEnter} required maxLength={100} /></label>
            <CameraSettingSelect label="Thời gian giữ bản ghi" value={String(form.record_retention_hours)} options={numericOptions(form.record_retention_hours, [0, 6, 12, 24, 48, 72, 168, 336, 720, 1440, 2160, 8760], hours => hours === 0 ? 'Theo dung lượng' : hours % 24 === 0 ? `${hours / 24} ngày` : `${hours} giờ`)} onChange={value => change('record_retention_hours', Number(value))} description="Chọn thời gian giữ bản ghi tối đa." icon="clock" />
            <CameraSettingSelect label="Bắt đầu dọn khi đầy" value={String(form.cleanup_threshold_percent)} options={numericOptions(form.cleanup_threshold_percent, [60, 70, 75, 80, 85, 90, 95, 98, 99], value => `${value}%`).map(option => ({ ...option, disabled: Number(option.value) <= form.cleanup_target_percent }))} onChange={value => change('cleanup_threshold_percent', Number(value))} description="Chọn ngưỡng bắt đầu dọn bản ghi cũ." icon="database" />
            <CameraSettingSelect label="Dọn về mức sử dụng" value={String(form.cleanup_target_percent)} options={numericOptions(form.cleanup_target_percent, [0, 10, 25, 50, 60, 70, 75, 80, 85, 90, 95, 98], value => `${value}%`).map(option => ({ ...option, disabled: Number(option.value) >= form.cleanup_threshold_percent }))} onChange={value => change('cleanup_target_percent', Number(value))} description="Chọn mức thấp hơn ngưỡng bắt đầu dọn." icon="database" />
            <CameraSettingSelect label="Chu kỳ kiểm tra" value={String(form.cleanup_interval_minutes)} options={numericOptions(form.cleanup_interval_minutes, [1, 2, 5, 10, 15, 30, 60, 120, 360, 720, 1440], minutes => minutes % 60 === 0 ? `${minutes / 60} giờ` : `${minutes} phút`)} onChange={value => change('cleanup_interval_minutes', Number(value))} description="Chọn khoảng thời gian giữa hai lần kiểm tra." icon="refresh" />
            <div className="settings-readonly"><span>Múi giờ ghi hình</span><strong>{info?.record_timezone}</strong></div>
          </div>
          <div className="storage-location"><span>Thư mục dữ liệu đang dùng</span><code>{info?.storage_root}</code>{storage && <small>Còn {formatBytes(storage.free_bytes)} / {formatBytes(storage.total_bytes)}</small>}</div>
        </>}
      </section>}
      {!admin && <p className="muted">Chỉ quản trị viên có quyền thay đổi cấu hình máy chủ.</p>}
      {error && <div className="notice error" role="alert">{error}{!saving && desired.current && JSON.stringify(desired.current) !== JSON.stringify(applied.current) && <button type="button" onClick={() => { if (desired.current) enqueueSave(desired.current); }}>Thử lại</button>}</div>}
      {(saving || notice) && <p className="settings-save-status" role="status">{saving ? 'Đang áp dụng…' : notice}</p>}
    </form>
  </section>;
}
