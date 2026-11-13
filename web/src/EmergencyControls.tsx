import { useContext, useEffect, useRef, useState } from 'react';
import { api, Camera, DeviceControls, TalkCapability } from './api';
import Icon from './Icon';
import type useCameraTalk from './useCameraTalk';
import { SessionContext } from './ui';
import EmergencyCameraPicker from './EmergencyCameraPicker';

type Talk = ReturnType<typeof useCameraTalk>;
type Mode = 'idle' | 'starting' | 'stopping';
const duration = 30;

/** Bounded fan-out reuses the authenticated per-camera controls and their native watchdog. */
async function commands<T>(ids: number[], command: (id: number) => Promise<T>) {
  const results: Array<{ id: number; result: PromiseSettledResult<T> }> = [];
  for (let offset = 0; offset < ids.length; offset += 2) {
    const batch = ids.slice(offset, offset + 2), values = await Promise.allSettled(batch.map(command));
    values.forEach((result, index) => results.push({ id: batch[index], result }));
  }
  return results;
}

export default function EmergencyControls({ cameras, talk, compact = false }: { cameras: Camera[]; talk: Talk; compact?: boolean }) {
  const user = useContext(SessionContext), admin = user?.role === 'admin';
  const storageKey = `camera-station.emergency-cameras.${user?.id ?? 'anonymous'}`;
  const [selection, setSelection] = useState<number[] | null>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
      return Array.isArray(value) && value.every(id => Number.isSafeInteger(id) && id > 0) ? [...new Set<number>(value)] : null;
    } catch { return null; }
  });
  const [pickerOpen, setPickerOpen] = useState(false), [statusDismissed, setStatusDismissed] = useState(false);
  const [states, setStates] = useState<Record<number, DeviceControls>>({});
  const [capabilities, setCapabilities] = useState<Record<number, TalkCapability>>({});
  const [loading, setLoading] = useState(true), [mode, setMode] = useState<Mode>('idle');
  const [message, setMessage] = useState(''), [failed, setFailed] = useState(false);
  const [uncertain, setUncertain] = useState<number[]>([]), [now, setNow] = useState(Date.now());
  const mounted = useRef(true), starting = useRef<{ cancelled: boolean; attempted: number[] } | null>(null);
  const stopping = useRef<Promise<void> | null>(null), reading = useRef(false);
  const revision = useRef(0);
  const selectedIds = cameras.filter(camera => selection === null || selection.includes(camera.id)).map(camera => camera.id);
  const current = useRef({ states, uncertain, cameras, selectedIds }); current.current = { states, uncertain, cameras, selectedIds };
  const cameraKey = cameras.map(camera => `${camera.id}:${camera.enabled}:${camera.status === 'online'}:${camera.rtsp_url}`).join('|');
  const enabled = cameras.filter(camera => selectedIds.includes(camera.id) && camera.enabled), online = enabled.filter(camera => camera.status === 'online');
  const alarmTargets = online.filter(camera => states[camera.id]?.alarm_supported);
  const micTargets = online.filter(camera => capabilities[camera.id]?.supported);
  const activeIds = () => [...new Set([...Object.values(current.current.states).filter(state => current.current.selectedIds.includes(state.camera_id) && (state.ends_at || state.alarm_active === true)).map(state => state.camera_id), ...current.current.uncertain])];
  const alarmIds = activeIds(), alarmOn = alarmIds.length > 0;
  const broadcast = talk.broadcast && talk.phase !== 'idle';
  const secure = window.isSecureContext;
  const locked = mode !== 'idle' || alarmOn || talk.phase !== 'idle';
  const scopeLabel = selection === null ? 'tất cả camera' : `${selectedIds.length} camera đã chọn`;

  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(selection)); } catch {} }, [storageKey, selection]);
  useEffect(() => {
    setStatusDismissed(false);
    if (!broadcast && !failed && (message || talk.message)) {
      const timer = window.setTimeout(() => setStatusDismissed(true), 6000);
      return () => window.clearTimeout(timer);
    }
  }, [message, talk.message, broadcast, failed]);

  async function readAlarms() {
    if (reading.current || starting.current || stopping.current) return;
    const ids = activeIds(); if (!ids.length) return;
    reading.current = true; const stamp = revision.current;
    try {
      const result = await commands(ids, id => api.deviceControls(id));
      if (!mounted.current || stamp !== revision.current) return;
      for (const item of result) if (item.result.status === 'fulfilled') {
        const state = item.result.value;
        // Offline is not proof that an earlier alarm stopped. Keep the stop action available.
        if (!state.available) continue;
        setStates(value => ({ ...value, [item.id]: state }));
        setUncertain(value => value.filter(id => id !== item.id));
      }
    } finally { reading.current = false; }
  }

  useEffect(() => {
    mounted.current = true;
    const timer = window.setInterval(() => { setNow(Date.now()); void readAlarms(); }, 1000);
    return () => { mounted.current = false; window.clearInterval(timer); if (starting.current) starting.current.cancelled = true; };
  }, []);

  useEffect(() => {
    if (!admin) return;
    let cancelled = false;
    const list = cameras.filter(camera => camera.enabled && camera.status === 'online');
    setLoading(true); setCapabilities({}); const stamp = revision.current;
    async function load() {
      const controlResults = commands(list.map(camera => camera.id), id => api.deviceControls(id));
      const capabilities: Record<number, TalkCapability> = {};
      for (let offset = 0; offset < list.length && !cancelled; offset += 16) {
        try { for (const item of await api.talkCapabilities(list.slice(offset, offset + 16).map(camera => camera.id))) capabilities[item.camera_id] = item; }
        catch { /* A failed probe must not be treated as ready. */ }
      }
      const controls = await controlResults;
      if (cancelled) return;
      setCapabilities(capabilities);
      setStates(value => {
        const next = { ...value };
        for (const item of controls) if (stamp === revision.current && item.result.status === 'fulfilled') next[item.id] = item.result.value;
        return next;
      });
      setLoading(false);
    }
    void load(); return () => { cancelled = true; };
  }, [cameraKey, admin]);

  function names(ids: number[]) { return ids.map(id => current.current.cameras.find(camera => camera.id === id)?.name ?? `Camera ${id}`).join(', '); }

  function stopAlarms(extra: number[] = []): Promise<void> {
    if (stopping.current) return stopping.current;
    const ids = [...new Set([...activeIds(), ...extra])];
    if (!ids.length) return Promise.resolve();
    revision.current++; setMode('stopping');
    const pending = (async () => {
      const results = await commands(ids, id => api.setDeviceControl(id, 'alarm', false, duration));
      const failures: number[] = [];
      for (const item of results) {
        if (item.result.status === 'rejected') { failures.push(item.id); continue; }
        if (mounted.current) setStates(value => ({ ...value, [item.id]: item.result.status === 'fulfilled' ? item.result.value : value[item.id] }));
      }
      if (mounted.current) {
        setUncertain(value => [...new Set([...value.filter(id => !ids.includes(id)), ...failures])]);
        setFailed(!!failures.length); setMessage(failures.length ? `Chưa dừng được: ${names(failures)}. Nhấn Dừng báo động để thử lại.` : `Đã gửi lệnh dừng báo động tới ${ids.length} camera.`);
      }
      if (failures.length) throw new Error(`Chưa dừng được còi: ${names(failures)}. Dừng báo động rồi thử lại mic.`);
    })();
    stopping.current = pending;
    void pending.finally(() => { stopping.current = null; if (mounted.current) setMode('idle'); }).catch(() => undefined);
    return pending;
  }

  async function alarm() {
    if (starting.current) { starting.current.cancelled = true; setMessage('Đang hủy và dừng các lệnh báo động…'); return; }
    if (stopping.current) return;
    if (alarmOn) { await stopAlarms().catch(() => undefined); return; }
    const ids = alarmTargets.map(camera => camera.id); if (!ids.length || !secure) return;
    const request = { cancelled: false, attempted: [] as number[] }; starting.current = request;
    revision.current++; setMode('starting'); setFailed(false); setMessage('Đang gửi báo động tới các camera đã chọn và sẵn sàng…');
    await talk.stop();
    const failures: number[] = [], sent: number[] = [];
    for (let offset = 0; offset < ids.length && !request.cancelled; offset += 2) {
      const batch = ids.slice(offset, offset + 2); request.attempted.push(...batch);
      const results = await commands(batch, id => api.setDeviceControl(id, 'alarm', true, duration));
      for (const item of results) {
        if (item.result.status === 'rejected') { failures.push(item.id); continue; }
        sent.push(item.id);
        if (mounted.current) {
          const state = item.result.value;
          setStates(value => ({ ...value, [item.id]: state }));
          if (!state.ends_at) setUncertain(value => [...new Set([...value, item.id])]);
        }
      }
    }
    starting.current = null;
    if (request.cancelled) { if (mounted.current) setMode('idle'); await stopAlarms(request.attempted).catch(() => undefined); return; }
    if (mounted.current) {
      const skipped = selectedIds.filter(id => !ids.includes(id));
      setMode('idle'); setFailed(!!failures.length || !!skipped.length);
      setMessage(`Đã gửi báo động ${sent.length}/${selectedIds.length} camera đã chọn · tự dừng sau ${duration} giây.${skipped.length ? ` Chưa sẵn sàng: ${names(skipped)}.` : ''}${failures.length ? ` Chưa gửi được: ${names(failures)}.` : ''}`);
    }
  }

  if (!admin) return null;
  const deadlines = Object.values(states).flatMap(state => alarmIds.includes(state.camera_id) && state.ends_at ? [state.ends_at] : []);
  const remaining = deadlines.length ? Math.max(0, Math.ceil((Math.max(...deadlines) - now) / 1000)) : null;
  return <section className={`emergency-controls${compact ? ' compact' : ''}`} aria-labelledby="emergency-title">
    <div className="emergency-description"><h2 id="emergency-title"><button type="button" className="emergency-selector" onClick={() => setPickerOpen(true)} aria-label={`Chọn camera khẩn cấp, hiện chọn ${scopeLabel}`} aria-haspopup="dialog" aria-expanded={pickerOpen} title={`Chọn camera · Còi: ${alarmTargets.length}/${selectedIds.length} · Mic: ${micTargets.length}/${selectedIds.length}`}><Icon name="shield" size={20} /><span className="emergency-selector-label">Khẩn cấp</span><span className="emergency-scope-count">{selection === null ? 'Tất cả' : selectedIds.length}</span><Icon name="chevronDown" size={13} /></button></h2><span>{loading ? 'Đang kiểm tra camera…' : `Còi: ${alarmTargets.length}/${selectedIds.length} · Mic: ${micTargets.length}/${selectedIds.length} camera`}</span></div>
    <div className="emergency-actions">
      <button type="button" className={`emergency-alarm${alarmOn || mode !== 'idle' ? ' active' : ''}`} disabled={!secure || mode === 'stopping' || (!alarmOn && mode === 'idle' && (loading || !alarmTargets.length)) || talk.blocked} onClick={() => void alarm()} aria-pressed={alarmOn || mode !== 'idle'} aria-label={`${alarmOn ? 'Dừng' : 'Bật'} báo động ${scopeLabel}`}>
        <Icon name="bell" size={21} />{compact ? mode === 'stopping' ? 'Đang dừng…' : mode === 'starting' ? 'Hủy còi' : alarmOn ? `Dừng còi${remaining !== null && remaining > 0 ? ` · ${remaining}s` : ''}` : 'Báo động' : mode === 'stopping' ? 'Đang dừng báo động…' : mode === 'starting' ? 'Hủy / dừng báo động' : alarmOn ? `Dừng báo động${remaining !== null && remaining > 0 ? ` · ${remaining}s` : ''}` : 'Báo động'}
      </button>
      <button type="button" className={`emergency-mic${broadcast ? ' active' : ''}`} disabled={talk.blocked || (!broadcast && (!secure || loading || !micTargets.length || micTargets.length > 16 || mode !== 'idle'))} onClick={() => talk.toggleAll(micTargets.map(camera => camera.id), () => stopAlarms())} aria-pressed={broadcast} aria-label={broadcast ? talk.phase === 'preparing' ? 'Hủy kết nối mic' : 'Kết thúc đàm thoại khẩn cấp' : `Nói tới ${scopeLabel}`}>
        <Icon name="microphone" size={21} />{compact ? broadcast ? talk.phase === 'preparing' ? 'Hủy mic' : 'Dừng nói' : 'Nói' : broadcast ? talk.phase === 'preparing' ? 'Hủy kết nối mic' : 'Kết thúc đàm thoại' : `Nói tới ${scopeLabel}`}
      </button>
    </div>
    {!statusDismissed && (message || broadcast || (!broadcast && talk.broadcast && talk.message) || !secure || micTargets.length > 16) && <div className={`emergency-status${failed ? ' error' : ''}`} role="status">
      <span>{!secure ? 'Mở web bằng HTTPS để dùng báo động và mic.' : broadcast ? talk.phase === 'preparing' ? 'Đang mở mic và kết nối các camera…' : `Đang gửi giọng nói tới ${talk.cameraIds.length} camera · nhấn lại để kết thúc · im lặng 5 giây sẽ tự dừng.` : talk.broadcast && talk.message ? talk.message : micTargets.length > 16 ? 'Đàm thoại hỗ trợ tối đa 16 camera cùng lúc.' : message}</span>
      <button type="button" className="emergency-status-close" onClick={() => setStatusDismissed(true)} aria-label="Ẩn thông báo khẩn cấp"><Icon name="close" size={18} /></button>
      {broadcast && <span className="emergency-level" aria-label="Mức âm thanh mic" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(talk.level * 100)}><span style={{ width: `${talk.level * 100}%` }} /></span>}
    </div>}
    {pickerOpen && <EmergencyCameraPicker cameras={cameras} selection={selection} states={states} capabilities={capabilities} locked={locked} onApply={ids => { setSelection(ids); setPickerOpen(false); setMessage(''); setFailed(false); setStatusDismissed(true); }} onClose={() => setPickerOpen(false)} />}
  </section>;
}
