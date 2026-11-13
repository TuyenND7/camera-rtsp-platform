import { useEffect } from 'react';
import Icon from './Icon';
import { useDevice } from './device';

export default function ViewingDeviceSettings() {
  const device = useDevice();
  useEffect(() => { device.refresh(); const timer = window.setInterval(device.refresh, 3000); return () => clearInterval(timer); }, []);
  return <section className="panel settings-section viewing-device-settings">
    <header className="settings-heading"><Icon name="monitor" size={22} /><div><h2>Thiết bị đang xem</h2><p>Âm lượng và màn hình của thiết bị này, lưu riêng với cấu hình máy chủ.</p></div></header>
    <div className="viewing-device-fields">
      <label><span>{device.native?.volume_supported ? 'Âm lượng thiết bị' : 'Âm lượng video'}<output>{device.volume}%</output></span><input type="range" min={0} max={100} step={1} value={device.volume} onChange={event => void device.setVolume(Number(event.target.value)).catch(() => undefined)} aria-label="Âm lượng phát trên thiết bị" /><small>Điều chỉnh âm thanh phát ở đây; loa của camera được cấu hình riêng trong Thiết bị.</small></label>
      <label><span>{device.native ? 'Độ sáng màn hình' : 'Độ sáng nội dung'}<output>{device.brightness}%</output></span><input type="range" min={device.native ? 1 : 10} max={100} step={1} value={device.brightness} onChange={event => void device.setBrightness(Number(event.target.value)).catch(() => undefined)} aria-label="Độ sáng màn hình đang xem" /><small>{device.native ? device.native.brightness_percent < 0 ? 'Đang theo độ sáng hệ thống.' : 'Chỉ đổi đèn nền khi app đang mở.' : 'Trình duyệt làm tối nội dung. App Android hỗ trợ chỉnh đèn nền thật.'}</small><button type="button" onClick={() => void device.resetBrightness().catch(() => undefined)}>{device.native ? 'Theo độ sáng hệ thống' : 'Khôi phục độ sáng'}</button></label>
    </div>
    <div className="screen-sleep-setting"><div><h3>Tắt hiển thị</h3><p>Phủ đen màn hình; chạm đúp để mở lại. {device.native ? 'App hạ đèn nền xuống tối thiểu, không khóa máy.' : 'Không tắt nguồn màn hình của thiết bị.'} Mic tự kết thúc; ghi hình trên máy chủ vẫn chạy.</p></div><button type="button" onClick={() => void device.sleep().catch(() => undefined)}><Icon name="moon" size={19} />Tắt hiển thị</button></div>
    {device.error && <p className="camera-control-error" role="alert">{device.error}</p>}
  </section>;
}
