import { useEffect, useRef, useState } from 'react';
import { api, Camera, CameraDeviceSettings as Snapshot, DeviceSettingKey } from './api';
import Icon, { IconName } from './Icon';
import CameraSettingSelect from './CameraSettingSelect';

type Field = { key: DeviceSettingKey; label: string; icon: IconName; description: string; labels?: Record<number, string> };
const toggle = { 0: 'Tắt', 1: 'Bật' };
const groups: Array<{ name: string; icon: IconName; fields: Field[] }> = [
  { name: 'Hình ảnh và nhìn đêm', icon: 'moon', fields: [
    { key: 'night_vision', label: 'Chế độ nhìn đêm', icon: 'moon', description: 'Chọn chế độ ban đêm như trong TDSEE.', labels: { 0: 'Đen trắng', 2: 'Có màu', 3: 'Thông minh' } },
    { key: 'infrared', label: 'Hồng ngoại', icon: 'moon', description: 'Tự động chuyển theo ánh sáng hoặc giữ hồng ngoại bật/tắt.', labels: { 0: 'Luôn tắt', 1: 'Luôn bật', 2: 'Tự động' } },
    { key: 'image_flip', label: 'Hướng đặt camera', icon: 'monitor', description: 'Lật hình khi camera được lắp úp trên trần.', labels: { 0: 'Đặt đứng', 1: 'Lắp ngược · lật 180°' } },
    { key: 'anti_flicker', label: 'Chống nhấp nháy', icon: 'sun', description: 'Chọn theo tần số điện lưới. Việt Nam sử dụng 50 Hz.', labels: { 50: '50 Hz · Việt Nam', 60: '60 Hz' } },
    { key: 'indicator', label: 'Đèn trạng thái', icon: 'sun', description: 'Đèn báo trạng thái trên thân camera, độc lập với đèn chiếu sáng.', labels: toggle },
  ] },
  { name: 'Riêng tư', icon: 'shield', fields: [
    { key: 'privacy', label: 'Chế độ riêng tư', icon: 'shield', description: 'Bật để che hình camera. Live và các bản ghi mới có thể mất hình khi chế độ này bật.', labels: { 0: 'Tắt · xem hình bình thường', 1: 'Bật · che hình camera' } },
  ] },
  { name: 'Phát hiện và báo động', icon: 'bell', fields: [
    { key: 'motion_detection', label: 'Phát hiện chuyển động', icon: 'bell', description: 'Bật/tắt phát hiện trên chính camera.', labels: toggle },
    { key: 'motion_sensitivity', label: 'Độ nhạy phát hiện', icon: 'settings', description: 'Độ nhạy cao sẽ phát hiện nhiều chuyển động nhỏ hơn.', labels: { 1: 'Thấp', 2: 'Trung bình', 3: 'Cao' } },
    { key: 'tdsee_notifications', label: 'Thông báo TDSEE', icon: 'bell', description: 'Điều khiển thông báo của ứng dụng hãng, độc lập với website này.', labels: toggle },
    { key: 'alarm_sound', label: 'Còi khi phát hiện', icon: 'volume', description: 'Cho phép camera tự phát còi khi báo động phát hiện được bật.', labels: toggle },
    { key: 'alarm_light', label: 'Đèn khi phát hiện', icon: 'sun', description: 'Cho phép camera bật đèn khi báo động phát hiện được bật.', labels: toggle },
  ] },
  { name: 'Âm thanh và đàm thoại', icon: 'volume', fields: [
    { key: 'intercom', label: 'Chế độ đàm thoại', icon: 'microphone', description: 'Thay đổi chế độ giao tiếp mà camera sử dụng.', labels: { 1: 'Một chiều · luân phiên nói/nghe', 2: 'Hai chiều · nói và nghe' } },
    { key: 'microphone_volume', label: 'Âm lượng micro camera', icon: 'microphone', description: 'Mức thu âm từ môi trường xung quanh camera.' },
    { key: 'speaker_volume', label: 'Âm lượng loa camera', icon: 'volume', description: 'Mức âm thanh phát ra loa của camera.' },
  ] },
  { name: 'Thẻ nhớ trong camera', icon: 'database', fields: [
    { key: 'sd_recording', label: 'Ghi vào thẻ nhớ', icon: 'database', description: 'Thiết lập thẻ SD trong camera, độc lập với ghi hình trên máy chủ.', labels: { 0: 'Không ghi', 1: 'Ghi khi báo động', 2: 'Ghi liên tục cả ngày' } },
  ] },
];
const cardStatus: Record<number, string> = { 0: 'Chưa lắp thẻ nhớ', 1: 'Thẻ nhớ sẵn sàng', 2: 'Thẻ chưa định dạng', 3: 'Đang định dạng' };

export default function CameraDeviceSettings({ camera, onBusy }: { camera: Camera; onBusy: (busy: boolean) => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [draft, setDraft] = useState<Snapshot['values']>({});
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const alive = useRef(true);
  async function load() {
    setLoading(true); setError(''); setNotice('');
    try { const result = await api.cameraDeviceSettings(camera.id); if (alive.current) { setSnapshot(result); setDraft(result.values); } }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Chưa đọc được cài đặt từ camera.'); }
    finally { if (alive.current) setLoading(false); }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [camera.id]);
  const changes = Object.fromEntries(Object.entries(draft).filter(([key, value]) => value !== snapshot?.values[key as DeviceSettingKey])) as Snapshot['values'];
  const changed = Object.keys(changes).length;
  async function apply(event: React.FormEvent) {
    event.preventDefault(); if (!snapshot || !changed || saving) return;
    setSaving(true); onBusy(true); setError(''); setNotice('');
    try {
      const result = await api.setCameraDeviceSettings(camera.id, snapshot.revision, changes);
      if (alive.current) { setSnapshot(result); setDraft(result.values); setNotice(result.confirmed ? 'Camera đã xác nhận các cài đặt mới.' : 'Đã gửi lệnh nhưng chưa xác nhận đủ cài đặt. Đọc lại trước khi thử tiếp.'); }
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Chưa lưu được cài đặt.'); }
    finally { if (alive.current) setSaving(false); onBusy(false); }
  }
  return <section className="camera-device-settings" aria-label="Cài đặt camera TDSEE">
    <div className="camera-settings-heading"><div><h3>Cài đặt camera</h3><p>Các tính năng thiết bị đang hỗ trợ</p></div><button type="button" onClick={() => void load()} disabled={loading || saving}><Icon name="refresh" size={18} />Đọc lại</button></div>
    {loading && <p className="loading-state" role="status">Đang đọc cài đặt từ camera…</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
    {!loading && snapshot && <form onSubmit={apply}>
      {groups.map((group, index) => {
        const fields = group.fields.filter(field => snapshot.values[field.key] !== undefined);
        if (!fields.length) return null;
        return <details className="camera-setting-group" key={group.name} open={index === 0}>
          <summary><Icon name={group.icon} size={22} /><strong>{group.name}</strong><span>{fields.length} mục</span><Icon name="chevronDown" size={18} /></summary>
          <div className="camera-setting-group-content">
            {group.name === 'Thẻ nhớ trong camera' && <div className="camera-sd-status"><Icon name="database" size={25} /><div><strong>{cardStatus[snapshot.info.StorageStatus ?? -1] ?? 'Chưa rõ trạng thái thẻ nhớ'}</strong>{snapshot.info.StorageTotalCapacity ? <small>Còn {(snapshot.info.StorageRemainCapacity ?? 0).toLocaleString('vi-VN')} / {snapshot.info.StorageTotalCapacity.toLocaleString('vi-VN')} MB</small> : <small>Ghi hình trên máy chủ vẫn được cấu hình riêng.</small>}</div></div>}
            <div className="form-grid">{fields.map(field => {
              const current = snapshot.values[field.key]!, selected = draft[field.key] ?? current;
              let available = snapshot.options[field.key] ?? [];
              if (field.key.endsWith('_volume')) available = available.filter(value => [0, 25, 50, 75, 100, current].includes(value));
              return <CameraSettingSelect key={field.key} label={field.label} value={String(selected)} icon={field.icon} description={field.description} disabled={saving || (field.key === 'sd_recording' && snapshot.info.StorageStatus !== 1)} help={field.key === 'privacy' ? field.description : undefined} options={available.map(value => ({ value: String(value), label: field.labels?.[value] ?? `${value}%`, current: current === value }))} onChange={value => { setDraft(values => ({ ...values, [field.key]: Number(value) })); setNotice(''); }} />;
            })}</div>
          </div>
        </details>;
      })}
      {notice && <p className="notice" role="status">{notice}</p>}
      <div className="camera-settings-apply"><span className="muted">{changed ? `${changed} thay đổi chưa áp dụng` : 'Cài đặt hiện tại của camera'}</span><button type="submit" className="primary" disabled={saving || !changed}>{saving ? 'Đang áp dụng…' : 'Áp dụng cài đặt camera'}</button></div>
    </form>}
    {snapshot && <div className="camera-device-information"><span>Firmware <strong>{snapshot.info.firmware ?? 'Chưa rõ'}</strong></span><span>Múi giờ <strong>{snapshot.info.timezone ? `UTC${snapshot.info.timezone}` : 'Chưa rõ'}</strong></span><span>Tín hiệu Wi-Fi <strong>{snapshot.info.SignalStrength !== undefined ? `${snapshot.info.SignalStrength} dBm` : 'Chưa rõ'}</strong></span></div>}
  </section>;
}
