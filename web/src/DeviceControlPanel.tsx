import { useEffect, useRef, useState } from 'react';
import { api, Camera, DeviceControls } from './api';
import Icon from './Icon';
import { Link } from 'react-router-dom';
import AlarmConfirmDialog from './AlarmConfirmDialog';
import { alarmDurationLabel, alarmIsActive, currentAlarmDuration } from './alarm';

export default function DeviceControlPanel({ cameras, onClose }: { cameras: Camera[]; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [states, setStates] = useState<Record<number, DeviceControls>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<Record<number, 'alarm' | 'light'>>({});
  const [pending, setPending] = useState<Record<number, { action: 'alarm' | 'light'; enabled: boolean; started: number }>>({});
  const [loading, setLoading] = useState(true);
  const [seconds, setSeconds] = useState<number | null>(null);
  const [approval, setApproval] = useState<{ camera: Camera; seconds: number } | null>(null);
  const [checkingId, setCheckingId] = useState<number | null>(null), approving = useRef(false);
  const [now, setNow] = useState(Date.now());
  const current = useRef({ states, busy, pending, cameras }); current.current = { states, busy, pending, cameras };
  const mounted = useRef(true), reading = useRef(false);
  const cameraKey = cameras.map(camera => `${camera.id}:${camera.enabled}:${camera.status === 'online'}`).join('|');

  async function load(activeOnly = false) {
    if (reading.current) return;
    reading.current = true;
    try {
      const list = current.current.cameras;
      const chosen = activeOnly ? list.filter(camera => alarmIsActive(current.current.states[camera.id]) || current.current.pending[camera.id]) : list;
      for (let start = 0; start < chosen.length; start += 2) {
        await Promise.all(chosen.slice(start, start + 2).map(async camera => {
          if (current.current.busy[camera.id]) return;
          try {
            const state = await api.deviceControls(camera.id);
            if (!mounted.current) return;
            setStates(value => ({ ...value, [camera.id]: state }));
            setErrors(value => { const next = { ...value }; delete next[camera.id]; return next; });
            setPending(value => { const next = { ...value }, request = next[camera.id]; if (request && (request.action === 'alarm' ? state.alarm_active : state.light_enabled) === request.enabled) delete next[camera.id]; return next; });
          } catch (error) { if (mounted.current) setErrors(value => ({ ...value, [camera.id]: error instanceof Error ? error.message : 'Chưa đọc được trạng thái camera.' })); }
        }));
      }
    } finally { reading.current = false; if (mounted.current) setLoading(false); }
  }
  useEffect(() => {
    mounted.current = true; dialog.current?.showModal();
    void currentAlarmDuration().then(value => { if (mounted.current) setSeconds(value); }).catch(() => undefined);
    const clock = window.setInterval(() => setNow(Date.now()), 500);
    const poll = window.setInterval(() => { void load(true); }, 3000);
    return () => { mounted.current = false; window.clearInterval(clock); window.clearInterval(poll); dialog.current?.close(); };
  }, []);
  useEffect(() => { setLoading(true); void load(); }, [cameraKey]);

  async function requestAlarm(camera: Camera) {
    if (approving.current) return;
    approving.current = true; setCheckingId(camera.id);
    try { const seconds = await currentAlarmDuration(); if (mounted.current) { setSeconds(seconds); setApproval({ camera: { ...camera }, seconds }); } }
    catch (error) { if (mounted.current) setErrors(value => ({ ...value, [camera.id]: error instanceof Error ? error.message : 'Chưa đọc được thời lượng báo động.' })); }
    finally { approving.current = false; if (mounted.current) setCheckingId(null); }
  }
  async function change(camera: Camera, action: 'alarm' | 'light', enabled: boolean, duration?: number) {
    if (enabled && !current.current.cameras.some(item => item.id === camera.id && item.enabled && item.status === 'online' && item.rtsp_url === camera.rtsp_url)) { setErrors(value => ({ ...value, [camera.id]: 'Camera đã thay đổi hoặc mất kết nối.' })); return; }
    if (busy[camera.id]) return;
    setBusy(value => ({ ...value, [camera.id]: action }));
    setErrors(value => { const next = { ...value }; delete next[camera.id]; return next; });
    try {
      const state = await api.setDeviceControl(camera.id, action, enabled, duration);
      if (!mounted.current) return;
      setStates(value => ({ ...value, [camera.id]: state }));
      if (action === 'alarm') window.dispatchEvent(new CustomEvent('camera-station.alarm-updated', { detail: state }));
      setPending(value => {
        const next = { ...value };
        if (action === 'light' && state.confirmed === false) next[camera.id] = { action, enabled, started: Date.now() }; else delete next[camera.id];
        return next;
      });
    } catch (error) { if (mounted.current) setErrors(value => ({ ...value, [camera.id]: error instanceof Error ? error.message : 'Chưa điều khiển được camera.' })); }
    finally { if (mounted.current) setBusy(value => { const next = { ...value }; delete next[camera.id]; return next; }); }
  }

  return <dialog ref={dialog} className="device-dialog camera-control-dialog" aria-labelledby="control-title" onCancel={onClose}>
    <header className="dialog-heading"><div><h2 id="control-title"><Icon name="bell" size={23} />Còi và đèn camera</h2><p>Điều khiển trực tiếp từng thiết bị</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Đóng điều khiển còi và đèn"><Icon name="close" /></button></header>
    <div className="camera-control-toolbar"><span>Thời lượng: {seconds === null ? 'Đang đọc…' : alarmDurationLabel(seconds)} · <Link to="/settings" onClick={onClose}>Cài đặt</Link></span><button type="button" className="icon-button" disabled={loading || reading.current} onClick={() => { setLoading(true); void load(); }} aria-label="Làm mới trạng thái còi và đèn"><Icon name="refresh" /></button></div>
    <div className="camera-control-list">{cameras.map(camera => {
      const state = states[camera.id], processing = busy[camera.id];
      const online = camera.enabled && camera.status === 'online';
      const active = alarmIsActive(state);
      const remaining = state?.ends_at ? Math.max(0, Math.ceil((state.ends_at - now) / 1000)) : null;
      const message = processing ? 'Đang gửi lệnh tới camera…' : pending[camera.id] ? 'Đã gửi lệnh, đang chờ camera xác nhận…' : (active ? remaining === 0 ? 'Đang chờ xác nhận còi đã tắt…' : state?.alarm_active !== true ? `Đã gửi lệnh bật còi${remaining !== null ? ` · còn ${remaining} giây` : ''}` : `Còi đang bật${remaining !== null ? ` · còn ${remaining} giây` : ''}` : !online ? 'Camera chưa trực tuyến' : state?.available ? 'Sẵn sàng điều khiển' : state?.reason || (loading ? 'Đang kiểm tra thiết bị…' : 'Chưa đọc được trạng thái'));
      return <section className={`camera-control-item${active ? ' alarm-active' : ''}`} key={camera.id}>
        <div className="camera-control-name"><Icon name="camera" size={23} /><div><strong>{camera.name}</strong><small role="status">{message}</small></div>{state?.alarm_active === true && <span className="alarm-pulse" aria-label="Còi đang bật" />}</div>
        <div className="camera-control-buttons"><button type="button" className={`camera-alarm-toggle${active ? ' active' : ''}`} disabled={!!processing || checkingId === camera.id || (!active && (!online || !state?.alarm_supported || state.talking))} onClick={() => active ? void change(camera, 'alarm', false) : void requestAlarm(camera)} aria-label={`${active ? 'Dừng' : 'Bật'} còi ${camera.name}`}><Icon name="bell" size={20} />{processing === 'alarm' || checkingId === camera.id ? 'Đang xử lý…' : active ? 'Dừng còi' : 'Bật còi'}</button><button type="button" className={`camera-light-toggle${state?.light_enabled ? ' active' : ''}`} disabled={!!processing || !online || !state?.light_supported} onClick={() => void change(camera, 'light', state?.light_enabled !== true)} aria-pressed={state?.light_enabled === true} aria-label={`${state?.light_enabled ? 'Tắt' : 'Bật'} đèn trắng ${camera.name}`}><Icon name="sun" size={21} />{processing === 'light' ? 'Đang xử lý…' : state?.light_enabled ? 'Tắt đèn' : 'Bật đèn'}</button></div>
        {active && state?.alarm_until_stopped && <p className="muted">Còi chờ người dùng nhấn Dừng còi, không hẹn giờ tự tắt.</p>}
        {errors[camera.id] && <p className="camera-control-error" role="alert">{errors[camera.id]}</p>}
        {state?.available && (!state.alarm_supported || !state.light_supported) && <p className="muted">{!state.alarm_supported && 'Chưa xác nhận chức năng còi trên thiết bị này. '}{!state.light_supported && 'Thiết bị chưa cung cấp điều khiển đèn trắng.'}</p>}
      </section>;
    })}</div>
    <p className="camera-control-note">Còi dùng âm báo sẵn có của camera. Đèn trắng giữ trạng thái bật/tắt bạn đã chọn.</p>
    {approval && <AlarmConfirmDialog cameras={[approval.camera]} seconds={approval.seconds} onClose={() => setApproval(null)} onConfirm={() => { setApproval(null); void change(approval.camera, 'alarm', true, approval.seconds); }} />}
  </dialog>;
}
