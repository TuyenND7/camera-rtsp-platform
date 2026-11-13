import { useContext, useEffect, useState } from 'react';
import { api, type ServerSettings, type SettingsInfo, type StorageStatus } from '../api';
import Icon from '../Icon';
import { formatBytes, PageHeader, SessionContext } from '../ui';
import { TEXT_SIZES, useTheme } from '../theme';
import CameraSettingSelect from '../CameraSettingSelect';
import { alarmDurations, alarmDurationLabel } from '../alarm';
import ViewingDeviceSettings from '../ViewingDeviceSettings';

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

  useEffect(() => {
    let stopped = false;
    if (admin) void api.getSettings().then(value => {
      if (!stopped) { setInfo(value); setForm(value.settings); }
    }).catch(err => { if (!stopped) setError(err.message); }).finally(() => { if (!stopped) setLoading(false); });
    void api.storageStatus().then(value => { if (!stopped) setStorage(value); }).catch(() => undefined);
    void api.health().then(value => { if (!stopped) setConnection(value.ok); }).catch(() => { if (!stopped) setConnection(false); });
    return () => { stopped = true; };
  }, [admin]);

  function change<K extends keyof ServerSettings>(key: K, value: ServerSettings[K]) {
    setForm(current => current ? { ...current, [key]: value } : current);
    setNotice(''); setError(''); setCopied(false);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!form) return;
    if (form.cleanup_target_percent >= form.cleanup_threshold_percent) { setError('Mức dung lượng sau khi dọn phải thấp hơn ngưỡng bắt đầu dọn.'); return; }
    setSaving(true); setError(''); setNotice('');
    try {
      const result = await api.saveSettings(form);
      setForm(result.settings); setInfo(current => current ? { ...current, settings: result.settings } : current);
      setNotice('Đã lưu cấu hình máy chủ.');
      window.dispatchEvent(new Event('camera-station.settings-updated'));
      void api.storageStatus().then(setStorage).catch(() => undefined);
    } catch (err: any) { setError(err.message); }
    finally { setSaving(false); }
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
  return <section className="settings-page">
    <PageHeader title="Cài đặt" />
    <section className="panel settings-section">
      <header className="settings-heading"><Icon name="sun" size={22} /><div><h2>Giao diện</h2></div></header>
      <div className="theme-options" role="group" aria-label="Chế độ giao diện">
        {(['light', 'dark'] as const).map(value => <button type="button" key={value} className={`theme-option${theme === value ? ' active' : ''}`} onClick={() => setTheme(value)} aria-pressed={theme === value}><span className={`theme-swatch ${value}`}><i /><i /><i /></span><span className="theme-option-label"><Icon name={value === 'light' ? 'sun' : 'moon'} size={18} />{value === 'light' ? 'Sáng' : 'Tối'}</span>{theme === value && <Icon name="check" size={18} />}</button>)}
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
        <p className="text-size-preview" aria-live="polite">Phòng khách · Sân trước — chữ rõ hơn, dễ đọc hơn.</p>
      </div>
    </section>

    <ViewingDeviceSettings />
    <form onSubmit={save} className="settings-form">
      <section className="panel settings-section">
        <header className="settings-heading"><Icon name="server" size={22} /><div><h2>Máy chủ</h2></div><span className={`status-badge ${connection === true ? 'online' : connection === false ? 'error' : 'connecting'}`}><i className={`status-dot ${connection === true ? 'online' : connection === false ? 'error' : 'connecting'}`} />{connection === null ? 'Đang kiểm tra' : connection ? 'Trực tuyến' : 'Mất kết nối'}</span></header>
        {admin && form && <label>Địa chỉ web để chia sẻ<div className="settings-address"><input type="url" value={form.public_base_url} onChange={event => change('public_base_url', event.target.value)} placeholder={window.location.origin} maxLength={2048} /><div className="settings-address-actions"><button type="button" onClick={() => void copyAddress()}>{copied ? 'Đã sao chép' : 'Sao chép link'}</button>{connectionButton}</div></div></label>}
        {!admin && connectionButton}
      </section>

      {admin && form && <section className="panel settings-section alarm-settings-section">
        <header className="settings-heading"><Icon name="bell" size={22} /><div><h2>Báo động</h2></div></header>
        <CameraSettingSelect label="Thời lượng báo động" value={String(form.alarm_duration_seconds ?? 30)} options={alarmDurations.map(seconds => ({ value: String(seconds), label: alarmDurationLabel(seconds), description: seconds === 0 ? 'Giữ còi cho đến khi nhấn Dừng còi' : 'Tự dừng khi hết thời gian' }))} onChange={value => change('alarm_duration_seconds', Number(value))} disabled={saving} description="Chọn thời gian phát còi cho lần báo động tiếp theo." icon="bell" />
      </section>}
      {admin && <section className="panel settings-section storage-settings-section">
        <header className="settings-heading"><Icon name="database" size={22} /><div><h2>Lưu trữ & ghi hình</h2></div>{storage && <span className="subtle-badge">Đã dùng {storage.used_percent}%</span>}</header>
        {loading && <p className="muted" role="status">Đang tải cấu hình…</p>}
        {form && <>
          <div className="settings-fields">
            <label>Tên ổ lưu trữ<input value={form.storage_label} onChange={event => change('storage_label', event.target.value)} required maxLength={100} /></label>
            <label>Thời gian giữ tối đa (giờ)<input type="number" min={0} max={87600} step={1} value={form.record_retention_hours} onChange={event => change('record_retention_hours', Number(event.target.value))} required /><small>0 = giữ đến khi cần dọn theo dung lượng.</small></label>
            <label>Bắt đầu dọn khi đầy (%)<input type="number" min={1} max={99} step={1} value={form.cleanup_threshold_percent} onChange={event => change('cleanup_threshold_percent', Number(event.target.value))} required /></label>
            <label>Dọn về mức sử dụng (%)<input type="number" min={0} max={98} step={1} value={form.cleanup_target_percent} onChange={event => change('cleanup_target_percent', Number(event.target.value))} required /></label>
            <label>Chu kỳ kiểm tra (phút)<input type="number" min={1} max={1440} step={1} value={form.cleanup_interval_minutes} onChange={event => change('cleanup_interval_minutes', Number(event.target.value))} required /></label>
            <div className="settings-readonly"><span>Múi giờ ghi hình</span><strong>{info?.record_timezone}</strong></div>
          </div>
          <div className="storage-location"><span>Thư mục dữ liệu đang dùng</span><code>{info?.storage_root}</code>{storage && <small>Còn {formatBytes(storage.free_bytes)} / {formatBytes(storage.total_bytes)}</small>}</div>
        </>}
      </section>}
      {!admin && <p className="muted">Chỉ quản trị viên có quyền thay đổi cấu hình máy chủ.</p>}
      {error && <div className="notice error" role="alert">{error}</div>}
      {notice && <div className="notice success" role="status">{notice}</div>}
      {admin && <div className="settings-save">{dirty && <span>Có thay đổi chưa lưu</span>}<button className="primary" type="submit" disabled={saving || loading || !form || !dirty}><Icon name="check" size={18} />{saving ? 'Đang lưu…' : 'Lưu cấu hình'}</button></div>}
    </form>
  </section>;
}
