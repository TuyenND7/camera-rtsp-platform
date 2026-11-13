import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Camera, DiscoveredDevice, OnvifProbeResult } from '../api';
import DeviceDiscovery from '../DeviceDiscovery';
import CameraPreview from '../CameraPreview';
import CameraSettings from '../CameraSettings';
import Icon from '../Icon';
import { cameraHost, EmptyState, PageHeader, StatusBadge } from '../ui';

type CameraForm = {
  name: string; rtsp_url: string; record: boolean; enabled: boolean;
  codec: 'auto' | 'h264' | 'h265'; ai_enabled: boolean; ai_rtsp_url: string;
  ai_fps: number; ai_confidence: number; ai_labels: string;
  onvif_url: string; onvif_username: string; onvif_password: string; ptz_onvif_url: string;
};
const emptyForm = (): CameraForm => ({ name: '', rtsp_url: '', record: true, enabled: true, codec: 'auto', ai_enabled: false, ai_rtsp_url: '', ai_fps: 2, ai_confidence: 0.5, ai_labels: 'person, car, motorcycle', onvif_url: '', onvif_username: '', onvif_password: '', ptz_onvif_url: '' });

export default function Cameras() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [showDiscovery, setShowDiscovery] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Camera | null>(null);
  const [device, setDevice] = useState<DiscoveredDevice | null>(null);
  const [form, setForm] = useState<CameraForm>(emptyForm());
  const [method, setMethod] = useState<'onvif' | 'rtsp'>('rtsp');
  const [onvifResult, setOnvifResult] = useState<OnvifProbeResult | null>(null);
  const [formError, setFormError] = useState('');
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'connection' | 'preview' | 'settings'>('connection');
  const [applying, setApplying] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);

  async function load() {
    try { const items = await api.listCameras(); if (alive.current) { setCameras(items); setErr(''); } }
    catch (error: any) { if (alive.current) setErr(error.message); }
    finally { if (alive.current) setLoading(false); }
  }
  useEffect(() => { alive.current = true; void load(); const timer = window.setInterval(load, 5000); return () => { alive.current = false; clearInterval(timer); }; }, []);
  useEffect(() => {
    if (!showForm) return;
    dialog.current?.showModal();
    const previous = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [showForm]);

  function open(camera?: Camera, found?: DiscoveredDevice) {
    setTab('connection'); setApplying(false); setEditing(camera ?? null); setDevice(found ?? null); setFormError(''); setOnvifResult(null);
    const next = camera ? { ...emptyForm(), name: camera.name, rtsp_url: camera.rtsp_url, record: camera.record, enabled: camera.enabled, codec: camera.codec ?? 'auto', ai_enabled: camera.ai_enabled ?? false, ai_rtsp_url: camera.ai_rtsp_url ?? '', ai_fps: camera.ai_fps ?? 2, ai_confidence: camera.ai_confidence ?? 0.5, ai_labels: camera.ai_labels?.join(', ') ?? 'person, car, motorcycle', ptz_onvif_url: camera.onvif_url ?? '' } : { ...emptyForm(), name: found && !found.name.startsWith('Thiết bị ') ? found.name : '', onvif_url: found?.onvif_url ?? '' };
    setForm(next); setMethod(found?.onvif_url ? 'onvif' : 'rtsp'); setShowDiscovery(false); setShowForm(true);
  }

  function changeOnvif(field: 'onvif_url' | 'onvif_username' | 'onvif_password', value: string) {
    setForm((current) => ({ ...current, [field]: value, rtsp_url: '' })); setOnvifResult(null); setFormError('');
  }

  async function probe() {
    setProbing(true); setFormError(''); setOnvifResult(null);
    try {
      const result = await api.probeOnvif({ url: form.onvif_url, username: form.onvif_username, password: form.onvif_password });
      if (!alive.current) return;
      setOnvifResult(result);
      setForm((current) => ({ ...current, name: current.name || result.device.model || device?.name || `Camera ${cameraHost(current.onvif_url)}`, rtsp_url: addCredentials(result.suggested_main_uri, current), ai_rtsp_url: result.suggested_sub_uri ? addCredentials(result.suggested_sub_uri, current) : current.ai_rtsp_url, codec: result.profiles[0]?.codec === 'h265' ? 'h265' : 'auto', ptz_onvif_url: current.onvif_url }));
    } catch (error: any) { if (alive.current) setFormError(error.message); }
    finally { if (alive.current) setProbing(false); }
  }

  const connectionChanged = !!editing && (form.rtsp_url.trim() !== editing.rtsp_url || form.ptz_onvif_url.trim() !== (editing.onvif_url ?? ''));
  const duplicate = form.rtsp_url ? cameras.find((camera) => camera.id !== editing?.id && streamKey(camera.rtsp_url) === streamKey(form.rtsp_url)) : undefined;

  async function save(event: React.FormEvent) {
    event.preventDefault(); setFormError('');
    if (!form.name.trim() || !form.rtsp_url.trim()) { setFormError('Nhập tên và địa chỉ RTSP, hoặc lấy luồng video qua ONVIF.'); return; }
    try { if (!['rtsp:', 'rtsps:'].includes(new URL(form.rtsp_url).protocol)) throw new Error(); }
    catch { setFormError('Địa chỉ video phải bắt đầu bằng rtsp:// hoặc rtsps://.'); return; }
    if (duplicate) { setFormError(`Luồng video này đã được thêm: ${duplicate.name}.`); return; }
    setSaving(true);
    try {
      const data = { name: form.name.trim(), rtsp_url: form.rtsp_url.trim(), record: form.record, enabled: form.enabled, codec: form.codec, ai_enabled: form.ai_enabled, ai_rtsp_url: form.ai_rtsp_url.trim(), ai_fps: form.ai_fps, ai_confidence: form.ai_confidence, ai_labels: form.ai_labels.split(',').map((label) => label.trim()).filter(Boolean), onvif_url: form.ptz_onvif_url.trim() };
      if (editing) await api.updateCamera(editing.id, data); else await api.createCamera(data);
      if (alive.current) { setShowForm(false); void load(); }
    } catch (error: any) { if (alive.current) setFormError(error.message); }
    finally { if (alive.current) setSaving(false); }
  }

  async function remove(camera: Camera) {
    if (!confirm(`Xóa camera "${camera.name}" khỏi hệ thống?`)) return;
    try { await api.deleteCamera(camera.id); void load(); } catch (error: any) { setErr(error.message); }
  }

  const filtered = cameras.filter((camera) => `${camera.name} ${cameraHost(camera.rtsp_url)}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (!status || (status === 'offline' ? camera.status !== 'online' : camera.status === status)));

  return <section className="devices-page">
    <PageHeader title="Thiết bị" actions={<><button type="button" onClick={() => open()}><Icon name="plus" size={16} />Thêm thủ công</button><button type="button" className="primary" onClick={() => setShowDiscovery(true)}><Icon name="search" size={17} />Dò thiết bị</button></>} />
    {err && <div className="notice error" role="alert">{err}</div>}
    <section className="panel device-table-panel"><div className="table-toolbar"><label className="search-input"><Icon name="search" size={17} /><input placeholder="Tìm tên hoặc địa chỉ IP" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Tìm thiết bị" /></label><select aria-label="Lọc trạng thái" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Tất cả trạng thái</option><option value="online">Trực tuyến</option><option value="offline">Chưa kết nối</option></select><span className="muted">{cameras.length} thiết bị</span></div>
      <div className="table-scroll"><table><thead><tr><th>Thiết bị</th><th>Địa chỉ</th><th>Trạng thái</th><th>Ghi hình</th><th className="align-right">Thao tác</th></tr></thead><tbody>{filtered.map((camera) => <tr key={camera.id}><td><div className="device-cell"><span className="device-icon"><Icon name="camera" size={21} /></span><span><strong>{camera.name}</strong><small>{camera.codec === 'auto' ? 'Tự nhận diện codec' : camera.codec === 'h265' ? 'H.265' : 'H.264'}{camera.ai_enabled ? ' · AI' : ''}</small></span></div></td><td><code className="ip-address">{cameraHost(camera.rtsp_url)}</code></td><td><StatusBadge status={camera.status} /></td><td><span className={`inline-status ${camera.record ? 'positive' : ''}`}><i className={`status-dot ${camera.record ? 'online' : 'stopped'}`} />{camera.record ? 'Bật' : 'Tắt'}</span></td><td><div className="row-actions"><Link className="icon-button" to={`/live?camera=${camera.id}`} title="Xem trực tiếp" aria-label={`Xem trực tiếp ${camera.name}`}><Icon name="monitor" size={17} /></Link><Link className="icon-button" to={`/playback/${camera.id}`} title="Xem lại" aria-label={`Xem lại ${camera.name}`}><Icon name="clock" size={17} /></Link><button className="icon-button" type="button" onClick={() => open(camera)} title="Sửa thiết bị" aria-label={`Sửa ${camera.name}`}><Icon name="edit" size={17} /></button><button className="icon-button danger-text" type="button" onClick={() => void remove(camera)} title="Xóa thiết bị" aria-label={`Xóa ${camera.name}`}><Icon name="trash" size={17} /></button></div></td></tr>)}</tbody></table></div>
      {loading ? <div className="loading-state">Đang tải thiết bị…</div> : !filtered.length && <EmptyState title={cameras.length ? 'Không tìm thấy thiết bị' : 'Chưa có thiết bị'} action={!cameras.length && <button type="button" className="primary" onClick={() => setShowDiscovery(true)}><Icon name="search" size={17} />Dò thiết bị</button>}>{cameras.length ? 'Thử tên hoặc địa chỉ IP khác.' : 'Dò camera và NVR trong mạng để bắt đầu.'}</EmptyState>}
    </section>

    {showDiscovery && <DeviceDiscovery onClose={() => setShowDiscovery(false)} onSelect={(found) => open(undefined, found)} />}
    {showForm && <dialog ref={dialog} className={`device-dialog compact-device-dialog${editing ? ' device-editor-dialog' : ''}`} aria-labelledby="device-form-title" onCancel={(event) => { if (saving || probing || applying) event.preventDefault(); else setShowForm(false); }}>
      <header className="dialog-heading"><div><h2 id="device-form-title">{editing ? 'Sửa thiết bị' : 'Thêm thiết bị'}</h2>{editing && <p>{editing.name}</p>}{device && <p>{device.ip}{device.rtsp_port ? ` · RTSP ${device.rtsp_port}` : ''}</p>}</div><button type="button" className="icon-button" onClick={() => setShowForm(false)} aria-label="Đóng cấu hình" disabled={saving || probing || applying}><Icon name="close" size={20} /></button></header>
      {editing && <div className="form-tabs device-editor-tabs" role="tablist" aria-label="Cấu hình thiết bị">{([{ id: 'connection', label: 'Kết nối', icon: 'camera' }, { id: 'preview', label: 'Xem trước', icon: 'monitor' }, { id: 'settings', label: 'Cài đặt', icon: 'settings' }] as const).map(item => <button type="button" role="tab" id={`device-tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`device-panel-${item.id}`} className={tab === item.id ? 'active' : ''} disabled={saving || probing || applying || (connectionChanged && item.id !== 'connection')} key={item.id} onClick={() => setTab(item.id)}><Icon name={item.icon} size={18} />{item.label}</button>)}</div>}
      <form onSubmit={save} hidden={tab !== 'connection'} id="device-panel-connection" role={editing ? 'tabpanel' : undefined} aria-labelledby={editing ? 'device-tab-connection' : undefined}>
        <div className="dialog-body">{formError && <div className="notice error" role="alert">{formError}</div>}{connectionChanged && <p className="notice">Lưu thay đổi kết nối trước khi xem trước hoặc cài đặt camera.</p>}
          {!device && <div className="form-method-switch" role="group" aria-label="Phương thức kết nối"><button type="button" className={method === 'rtsp' ? 'active' : ''} onClick={() => setMethod('rtsp')}>RTSP</button><button type="button" className={method === 'onvif' ? 'active' : ''} onClick={() => setMethod('onvif')}>ONVIF</button></div>}
          {method === 'onvif' && <div className="simple-onvif">{!device && <label>Địa chỉ ONVIF<input value={form.onvif_url} onChange={(event) => changeOnvif('onvif_url', event.target.value)} placeholder="http://192.168.0.100/onvif/device_service" /></label>}<div className="form-grid"><label>Tài khoản thiết bị<input autoComplete="off" value={form.onvif_username} onChange={(event) => changeOnvif('onvif_username', event.target.value)} placeholder="Tài khoản camera / NVR" /></label><label>Mật khẩu thiết bị<input type="password" autoComplete="new-password" value={form.onvif_password} onChange={(event) => changeOnvif('onvif_password', event.target.value)} placeholder="Mật khẩu camera / NVR" /></label></div><button type="button" onClick={() => void probe()} disabled={probing || !form.onvif_url.trim() || !form.onvif_username.trim()}><Icon name="video" size={16} />{probing ? 'Đang lấy luồng video…' : 'Lấy luồng video'}</button></div>}
          {onvifResult && <label>Luồng video<select value={onvifResult.profiles.find((profile) => addCredentials(profile.stream_uri, form) === form.rtsp_url)?.token ?? ''} onChange={(event) => { const profile = onvifResult.profiles.find((item) => item.token === event.target.value); if (profile) setForm({ ...form, rtsp_url: addCredentials(profile.stream_uri, form), codec: profile.codec === 'h265' ? 'h265' : 'auto' }); }}><option value="" disabled>Chọn luồng video</option>{onvifResult.profiles.map((profile) => <option key={profile.token} value={profile.token}>{profile.name}{profile.width ? ` · ${profile.width}×${profile.height}` : ''}{cameras.some((camera) => camera.id !== editing?.id && streamKey(camera.rtsp_url) === streamKey(profile.stream_uri)) ? ' · Đã thêm' : ''}</option>)}</select></label>}
          <label>Tên thiết bị<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Ví dụ: Cửa chính, NVR – Kênh 01" required /></label>
          {method === 'rtsp' && <label>Địa chỉ RTSP<input value={form.rtsp_url} onChange={(event) => setForm({ ...form, rtsp_url: event.target.value })} placeholder={`rtsp://user:pass@${device?.ip ?? '192.168.0.100'}:${device?.rtsp_port ?? 554}/...`} required /></label>}
          {duplicate && <p className="duplicate-stream" role="status"><Icon name="check" size={15} />Luồng này đã có trong {duplicate.name}. Chọn luồng khác để thêm.</p>}
          <label className="simple-check"><input type="checkbox" checked={form.record} onChange={(event) => setForm({ ...form, record: event.target.checked })} />Ghi hình liên tục</label>
          <details className="advanced-fields"><summary>Nâng cao<Icon name="chevronDown" size={16} /></summary><div className="advanced-content"><label>Định dạng video<select value={form.codec} onChange={(event) => setForm({ ...form, codec: event.target.value as CameraForm['codec'] })}><option value="auto">Tự động</option><option value="h264">H.264</option><option value="h265">H.265</option></select></label>{method === 'onvif' && <label>Địa chỉ ONVIF<input value={form.onvif_url} onChange={(event) => changeOnvif('onvif_url', event.target.value)} /></label>}<label>ONVIF cho PTZ<input value={form.ptz_onvif_url} onChange={(event) => setForm({ ...form, ptz_onvif_url: event.target.value })} placeholder="Tự động theo địa chỉ thiết bị" /></label><label className="simple-check"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />Bật thiết bị</label><label className="simple-check"><input type="checkbox" checked={form.ai_enabled} onChange={(event) => setForm({ ...form, ai_enabled: event.target.checked })} />Nhận dạng AI</label>{form.ai_enabled && <><label>RTSP luồng phụ<input value={form.ai_rtsp_url} onChange={(event) => setForm({ ...form, ai_rtsp_url: event.target.value })} placeholder="Bỏ trống để dùng live" /></label><div className="form-grid"><label>FPS AI<input type="number" min="0.1" max="10" step="0.1" value={form.ai_fps} onChange={(event) => setForm({ ...form, ai_fps: Number(event.target.value) })} /></label><label>Ngưỡng tin cậy<input type="number" min="0" max="1" step="0.05" value={form.ai_confidence} onChange={(event) => setForm({ ...form, ai_confidence: Number(event.target.value) })} /></label></div><label>Nhãn nhận dạng<input value={form.ai_labels} onChange={(event) => setForm({ ...form, ai_labels: event.target.value })} /></label></>}</div></details>
        </div><footer className="dialog-footer"><button type="button" onClick={() => setShowForm(false)} disabled={saving || probing}>Hủy</button><button type="submit" className="primary" disabled={saving || probing || !!duplicate || (method === 'onvif' && !onvifResult)}>{saving ? 'Đang lưu…' : editing ? 'Lưu' : 'Thêm'}</button></footer>
      </form>
      {editing && tab !== 'connection' && <div className="device-editor-content" role="tabpanel" id={`device-panel-${tab}`} aria-labelledby={`device-tab-${tab}`}>{tab === 'preview' ? <CameraPreview key={editing.id} camera={cameras.find(item => item.id === editing.id) ?? editing} /> : <CameraSettings key={editing.id} camera={cameras.find(item => item.id === editing.id) ?? editing} onBusy={setApplying} />}</div>}
    </dialog>}
  </section>;
}

function addCredentials(uri: string, form: CameraForm) { const url = new URL(uri); url.username = form.onvif_username; url.password = form.onvif_password; return url.toString(); }
function streamKey(value: string) {
  try { const url = new URL(value); url.username = ''; url.password = ''; if (url.port === '554') url.port = ''; url.searchParams.sort(); return `${url.protocol}//${url.host}${url.pathname || '/'}${url.search}`; }
  catch { return value; }
}
