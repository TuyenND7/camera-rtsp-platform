import { useEffect, useState } from 'react';
import Icon from './Icon';
import { useDevice } from './device';

export default function ViewingDeviceSettings() {
  const device = useDevice();
  const [changingBrightness, setChangingBrightness] = useState(false);
  const followsSystem = !!device.native && device.native.brightness_percent < 0;
  async function toggleSystemBrightness() {
    setChangingBrightness(true);
    try { if (followsSystem) await device.setBrightness(device.brightness); else await device.resetBrightness(); }
    catch { /* The device provider displays the error. */ }
    finally { setChangingBrightness(false); }
  }
  useEffect(() => { device.refresh(); const timer = window.setInterval(device.refresh, 3000); return () => clearInterval(timer); }, []);
  return <section className="panel settings-section viewing-device-settings">
    <header className="settings-heading viewing-device-heading"><Icon name="monitor" size={22} /><div><h2>Thiết bị đang xem</h2></div>{device.native && <label className="device-system-toggle"><span>Theo độ sáng hệ thống</span><button type="button" className="device-system-switch" role="switch" aria-label="Theo độ sáng hệ thống" aria-checked={followsSystem} disabled={changingBrightness} onClick={() => void toggleSystemBrightness()}><span aria-hidden="true" /></button></label>}</header>
    <div className="viewing-device-fields">
      <label><span>{device.native?.volume_supported ? 'Âm lượng thiết bị' : 'Âm lượng video'}<output>{device.volume}%</output></span><input type="range" min={0} max={100} step={1} value={device.volume} onChange={event => void device.setVolume(Number(event.target.value)).catch(() => undefined)} aria-label="Âm lượng phát trên thiết bị" /></label>
      <label><span>{device.native ? 'Độ sáng màn hình' : 'Độ sáng nội dung'}<output>{device.brightness}%</output></span><input type="range" min={device.native ? 1 : 10} max={100} step={1} value={device.brightness} disabled={followsSystem || changingBrightness} onChange={event => void device.setBrightness(Number(event.target.value)).catch(() => undefined)} aria-label="Độ sáng màn hình đang xem" />{!device.native && <button type="button" onClick={() => void device.resetBrightness().catch(() => undefined)}>Khôi phục độ sáng</button>}</label>
    </div>
    {device.error && <p className="camera-control-error" role="alert">{device.error}</p>}
  </section>;
}
