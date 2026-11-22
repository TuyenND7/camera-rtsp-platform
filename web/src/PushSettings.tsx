import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { operationsApi, operatingTimes, operatingTimezones, type PushPreferences, type PushSnapshot } from './operationsApi';
import './operations.css';
import { isUiPreview } from './preview';

export function pushSupport() {
  if (!window.isSecureContext || location.protocol !== 'https:') return 'Mở link HTTPS để nhận thông báo khi đóng trang.';
  const ios = /iP(?:hone|ad|od)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  if (ios && !window.matchMedia('(display-mode: standalone)').matches && !(navigator as any).standalone) return 'iPhone/iPad: dùng iOS 16.4 trở lên, Chia sẻ → Thêm vào Màn hình chính, rồi mở từ biểu tượng.';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'Trình duyệt hoặc WebView này chưa hỗ trợ thông báo đẩy. Mở link bằng Chrome, Edge, Firefox hoặc Safari.';
  return '';
}
const bytes = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), c => c.charCodeAt(0));
async function fingerprint(subscription: PushSubscription | null) {
  if (!subscription) return '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subscription.endpoint));
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
}
export default function PushSettings() {
  const [data, setData] = useState<PushSnapshot | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [currentFingerprint, setCurrentFingerprint] = useState('');
  const registration = useRef<Promise<ServiceWorkerRegistration> | null>(null), alive = useRef(true), locked = useRef(false);
  const readSequence=useRef(0),reading=useRef(false);
  const unsupported = pushSupport();
  const current = data?.devices.find(d => d.current_session && d.endpoint_fingerprint === currentFingerprint);
  useEffect(() => {
    alive.current = true;reading.current=false;
    const load=()=>{if((location.protocol!=='https:'&&!isUiPreview)||document.hidden||locked.current||reading.current)return;const sequence=++readSequence.current;reading.current=true;void operationsApi.push().then(value=>{if(alive.current&&sequence===readSequence.current)setData(value);}).catch(e=>{if(alive.current&&sequence===readSequence.current)setError(e.message);}).finally(()=>{if(sequence===readSequence.current)reading.current=false;});};
    load();const timer=window.setInterval(load,15000);document.addEventListener('visibilitychange',load);
    if (!unsupported) {
      registration.current = navigator.serviceWorker.register('/push-sw.js', { scope: '/', updateViaCache: 'none' });
      void registration.current.then(r => r.pushManager.getSubscription()).then(fingerprint).then(value => { if (alive.current) setCurrentFingerprint(value); }).catch(() => { if (alive.current) setError('Chưa khởi tạo được thông báo trên trình duyệt.'); });
    }
    return () => { alive.current = false;reading.current=false;readSequence.current++;window.clearInterval(timer);document.removeEventListener('visibilitychange',load); };
  }, []);
  async function run(action: () => Promise<void>) {
    if (locked.current) return; locked.current = true;readSequence.current++;reading.current=false; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Chưa cập nhật được thông báo.'); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  async function subscribe() {
    if (!data || unsupported || locked.current) return;
    // Permission request remains directly attached to the explicit button click.
    const permission = Notification.permission === 'default' ? Notification.requestPermission() : Promise.resolve(Notification.permission);
    await run(async () => {
      if (await permission !== 'granted') throw new Error('Chưa được cấp quyền. Bật thông báo cho website trong cài đặt trình duyệt.');
      const r = await (registration.current ?? navigator.serviceWorker.register('/push-sw.js', { scope: '/', updateViaCache: 'none' }));
      await navigator.serviceWorker.ready;
      let subscription = await r.pushManager.getSubscription();
      if (subscription && !current) { await subscription.unsubscribe(); subscription = null; }
      subscription ??= await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(data.vapid_public_key) });
      const value = await operationsApi.registerPush(subscription.toJSON(), /Mobile|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'Điện thoại / tablet' : 'Máy tính');
      const key = await fingerprint(subscription);
      if (alive.current) { setData(value); setCurrentFingerprint(key); setNotice('Đã bật trên thiết bị này. Đăng nhập lại cần đăng ký lại thông báo.'); }
    });
  }
  const save = (patch: Partial<Omit<PushPreferences,'snooze_until'>>) => void run(async () => { if (data) { const value=await operationsApi.savePushPreferences(patch);if(alive.current)setData(value); } });
  return <section id="push" className="panel settings-section operations-settings" aria-labelledby="push-title">
    <div className="settings-heading"><Icon name="bell" size={20} /><div><h2 id="push-title">Thông báo đẩy</h2></div></div>
    {unsupported && <p className="operations-note">{unsupported}</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
    {notice && <p className="operations-note" role="status">{notice}</p>}
    {data && <>
      <label className="operations-row"><span>Nhận thông báo</span><input type="checkbox" role="switch" checked={data.preferences.enabled} disabled={busy} onChange={e=>save({enabled:e.target.checked})}/></label>
      {!unsupported && <div className="operations-actions"><button type="button" disabled={busy} onClick={()=>current ? void run(async()=>{await operationsApi.deletePush(current.id);const r=await registration.current;await(await r?.pushManager.getSubscription())?.unsubscribe();if(alive.current){setCurrentFingerprint('');setData(await operationsApi.push());}}):void subscribe()}>{current?'Tắt trên thiết bị này':'Bật trên thiết bị này'}</button><button type="button" disabled={busy||!current} onClick={()=>void run(async()=>{await operationsApi.testPush(current!.id);if(alive.current)setNotice('Dịch vụ push đã nhận thông báo thử. Kiểm tra khay thông báo của thiết bị.');})}>Gửi thông báo thử</button></div>}
      {!data.profile_notifications_enabled && <p className="operations-note">Chế độ vận hành hiện đang tắt thông báo.</p>}
      <label className="operations-row"><span>Tạm hoãn</span><select aria-label="Tạm hoãn thông báo đẩy" disabled={busy} value={data.preferences.snooze_until && Date.parse(data.preferences.snooze_until)>Date.now()?'active':'0'} onChange={e=>void run(async()=>{const value=await operationsApi.snoozePush(Number(e.target.value));if(alive.current)setData(value);})}><option value="0">Không tạm hoãn</option>{data.preferences.snooze_until && Date.parse(data.preferences.snooze_until)>Date.now() && <option value="active">Đến {new Date(data.preferences.snooze_until).toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'})}</option>}<option value="15">15 phút</option><option value="60">1 giờ</option><option value="480">8 giờ</option></select></label>
      <label className="operations-row"><span>Giờ yên lặng</span><input type="checkbox" role="switch" checked={data.preferences.quiet_enabled} disabled={busy} onChange={e=>save({quiet_enabled:e.target.checked})}/></label>
      {data.preferences.quiet_enabled && <><label className="operations-row"><span>Múi giờ</span><select aria-label="Múi giờ thông báo" value={data.preferences.timezone} disabled={busy} onChange={e=>save({timezone:e.target.value})}>{operatingTimezones(data.preferences.timezone).map(z=><option key={z}>{z}</option>)}</select></label><div className="operations-time-pair">{(['quiet_start','quiet_end'] as const).map((key,i)=><label key={key}><span>{i?'Đến':'Từ'}</span><select aria-label={i?'Kết thúc giờ yên lặng':'Bắt đầu giờ yên lặng'} value={data.preferences[key]} disabled={busy} onChange={e=>save({[key]:e.target.value})}>{operatingTimes([data.preferences.quiet_start,data.preferences.quiet_end]).map(t=><option key={t}>{t}</option>)}</select></label>)}</div></>}
      {!!data.devices.length && <div className="operations-device-list">{data.devices.map(d=><div className="operations-device" key={d.id}><div><strong>{d.name}{d.id===current?.id?' · Thiết bị này':''}</strong><small>{d.last_error?'Chưa gửi được gần đây':d.last_success_at?`Đã gửi ${new Date(d.last_success_at).toLocaleString('vi-VN')}`:'Chưa gửi thông báo'}</small></div><button type="button" className="icon-button danger-text" disabled={busy} aria-label={`Xóa đăng ký ${d.name}`} onClick={()=>void run(async()=>{await operationsApi.deletePush(d.id);if(alive.current)setData(await operationsApi.push());})}><Icon name="trash" size={18}/></button></div>)}</div>}
      <p className="operations-note">Thông báo thử không phát còi camera. Thông báo cần máy chủ đang chạy và có Internet.</p>
    </>}
  </section>;
}
