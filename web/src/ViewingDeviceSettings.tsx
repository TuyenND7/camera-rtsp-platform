import { useEffect } from 'react';
import Icon from './Icon';
import { useDevice } from './device';

export default function ViewingDeviceSettings() {
  const device = useDevice();
  useEffect(() => { device.refresh(); const timer = window.setInterval(device.refresh, 3000); return () => clearInterval(timer); }, []);
  return <section className="panel settings-section viewing-device-settings">
    <header className="settings-heading"><Icon name="monitor" size={22} /><div><h2>Thiết bị đang xem</h2></div></header>
    <div className="viewing-device-fields">
      <label><span>{device.native?.volume_supported ? 'Âm lượng thiết bị' : 'Âm lượng video'}<output>{device.volume}%</output></span><input type="range" min={0} max={100} step={1} value={device.volume} onChange={event => void device.setVolume(Number(event.target.value)).catch(() => undefined)} aria-label="Âm lượng phát trên thiết bị" /></label>
      <label><span>{device.native ? 'Độ sáng màn hình' : 'Độ sáng nội dung'}<output>{device.brightness}%</output></span><input type="range" min={device.native ? 1 : 10} max={100} step={1} value={device.brightness} onChange={event => void device.setBrightness(Number(event.target.value)).catch(() => undefined)} aria-label="Độ sáng màn hình đang xem" /><button type="button" onClick={() => void device.resetBrightness().catch(() => undefined)}>{device.native ? 'Theo độ sáng hệ thống' : 'Khôi phục độ sáng'}</button></label>
    </div>
    <div className="screen-sleep-setting"><div><h3>Tắt hiển thị</h3><p>Chạm đúp để mở lại.</p></div><button type="button" onClick={() => void device.sleep().catch(() => undefined)}><Icon name="moon" size={19} />Tắt hiển thị</button></div>
    {device.error && <p className="camera-control-error" role="alert">{device.error}</p>}
  </section>;
}
