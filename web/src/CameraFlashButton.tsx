import { useEffect, useRef, useState } from 'react';
import { api, DeviceControls } from './api';
import Icon from './Icon';

/** Only query the SDK while tile controls are visible; no background polling for the grid. */
export default function CameraFlashButton({ cameraId, name, online, visible, onNotice }: { cameraId: number; name: string; online: boolean; visible: boolean; onNotice: (message: string) => void }) {
  const [state, setState] = useState<DeviceControls | null>(null), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
  const generation = useRef(0), mounted = useRef(true), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { generation.current++; sending.current = false; setState(null); setBusy(false); setLoading(false); }, [cameraId]);
  useEffect(() => {
    if (!visible || !online || sending.current) return;
    let cancelled = false; const current = generation.current;
    setLoading(true);
    api.deviceControls(cameraId).then(result => { if (!cancelled && mounted.current && current === generation.current) setState(result); }).catch(() => {
      if (!cancelled && mounted.current && current === generation.current) setState(null);
    }).finally(() => { if (!cancelled && mounted.current && current === generation.current) setLoading(false); });
    return () => { cancelled = true; };
  }, [cameraId, visible, online]);
  async function toggle() {
    if (sending.current || !state?.light_supported || typeof state.light_enabled !== 'boolean') return;
    sending.current = true; setBusy(true); const current = generation.current;
    const enabled = !state.light_enabled;
    try {
      const result = await api.setDeviceControl(cameraId, 'light', enabled);
      if (!mounted.current || current !== generation.current) return;
      setState(result);
      onNotice(result.confirmed === true ? `Đèn flash đã ${enabled ? 'bật' : 'tắt'}` : 'Đã gửi lệnh đèn flash, chạm lại ô để kiểm tra trạng thái.');
    } catch (error) { if (mounted.current && current === generation.current) onNotice(error instanceof Error ? error.message : 'Chưa điều khiển được đèn flash.'); }
    finally { if (current === generation.current) { sending.current = false; if (mounted.current) setBusy(false); } }
  }
  const known = state?.light_supported === true && typeof state.light_enabled === 'boolean', on = state?.light_enabled === true;
  const label = !online ? `Đèn flash ${name} chưa sẵn sàng` : loading ? `Đang kiểm tra đèn flash ${name}` : known ? `${on ? 'Tắt' : 'Bật'} đèn flash ${name}` : `Đèn flash ${name} chưa khả dụng`;
  return <button type="button" className={`mi-camera-control camera-flash-button${on ? ' active' : ''}`} disabled={!online || loading || busy || !known} onClick={() => void toggle()} aria-pressed={on} aria-busy={loading || busy} aria-label={label} title={label}><Icon name={loading || busy ? 'refresh' : 'sun'} size={20} /></button>;
}
