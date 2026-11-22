import { useEffect,useRef,useState } from 'react';
import { Link } from 'react-router-dom';
import { systemApi,type HealthSnapshot,type PerformanceSnapshot,type PerformanceSettings } from './systemApi';
import { formatBytes } from './ui';
import Icon from './Icon';
import './system-settings.css';

const stateLabel={ready:'Đang phát',recording:'Đang ghi',stalled:'Gián đoạn',waiting:'Đang kiểm tra',disabled:'Đã tắt'};
export default function SystemHealthSettings(){
  const [health,setHealth]=useState<HealthSnapshot|null>(null),[performance,setPerformance]=useState<PerformanceSnapshot|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const alive=useRef(false),lock=useRef(false),controller=useRef<AbortController>(),timer=useRef<number>(),sequence=useRef(0);
  useEffect(()=>{
    let disposed=false;
    alive.current=true;sequence.current++;
    const load=async()=>{
      if(disposed)return;
      if(!document.hidden&&!lock.current){
        const request=++sequence.current,abort=new AbortController();controller.current=abort;
        try{const [h,p]=await Promise.all([systemApi.health(abort.signal),systemApi.performance(abort.signal)]);if(alive.current&&request===sequence.current){setHealth(h);setPerformance(p);setError('');}}
        catch{if(alive.current&&request===sequence.current&&!abort.signal.aborted)setError('Chưa đọc được trạng thái máy chủ.');}
      }
      if(!disposed&&alive.current)timer.current=window.setTimeout(()=>void load(),10000);
    };void load();
    return()=>{disposed=true;sequence.current++;alive.current=false;controller.current?.abort();window.clearTimeout(timer.current);};
  },[]);
  async function action(run:()=>Promise<void>){
    if(lock.current)return;lock.current=true;sequence.current++;controller.current?.abort();setBusy(true);setError('');setNotice('');
    try{await run();}catch(err){if(alive.current)setError(err instanceof Error?err.message:'Chưa thực hiện được.');}
    finally{lock.current=false;if(alive.current)setBusy(false);}
  }
  async function change(patch:Partial<PerformanceSettings>){
    if(!performance)return;
    await action(async()=>{const next=await systemApi.savePerformance({...performance.settings,...patch},performance.revision);if(alive.current){setPerformance(next);setNotice(next.pending_streams.length?'Đã lưu. Có luồng cần kết nối lại để áp dụng.':'Đã áp dụng.');}});
  }
  const stale=health?Date.now()-(health.received_at??Date.now())+(health.checked_age_ms??0)>30000:true;
  return <section className="system-settings-content" id="health">
    <div className="system-section-heading"><h3>Trạng thái ghi hình</h3><button type="button" disabled={busy} onClick={()=>void action(async()=>{const value=await systemApi.refreshHealth();if(alive.current)setHealth(value);})} aria-label="Làm mới trạng thái máy chủ"><Icon name="refresh" size={18}/></button></div>
    {error&&<p className="notice error" role="alert">{error}</p>}
    {!health?<p className="muted">Đang đọc trạng thái…</p>:<>
      <div className="system-metrics"><div><span>CPU</span><strong>{health.cpu_percent===null?'—':`${health.cpu_percent}%`}</strong></div><div><span>RAM</span><strong>{health.memory_used_percent}%</strong></div><div><span>Nhiệt độ</span><strong>{health.temperature_c===null?'—':`${health.temperature_c}°C`}</strong></div><div><span>Ổ lưu trữ</span><strong>{health.storage?`${health.storage.used_percent}%`:'—'}</strong></div></div>
      <p className="system-small-note">{stale?'Số liệu chưa được cập nhật.':health.warming_up?'Đang kiểm tra sau khi khởi động.':!health.monitoring_enabled?'Đang tắt cảnh báo sức khỏe hệ thống.':`Cập nhật ${new Date(health.at).toLocaleTimeString('vi-VN')}`}{health.storage?` · Còn ${formatBytes(health.storage.free_bytes)}`:''}</p>
      {health.error&&<p className="notice error">{health.error}</p>}
      <div className="system-camera-list">{health.cameras.map(camera=><details key={camera.id} className="system-camera-row"><summary><strong>{camera.name}</strong><span className={camera.video==='stalled'?'danger-text':''}>Live: {stateLabel[camera.video]}</span><span className={camera.recording==='stalled'?'danger-text':''}>{stateLabel[camera.recording]}</span><Icon name="chevronDown" size={15}/></summary><div><p>Đoạn ghi gần nhất: {camera.recording_end_at?new Date(camera.recording_end_at).toLocaleString('vi-VN'):'Chưa có'}</p>{camera.gaps.length?<ul className="system-gap-list">{camera.gaps.slice(-8).map(gap=><li key={gap.start_at}><span>{new Date(gap.start_at).toLocaleString('vi-VN')} · Thiếu {Math.round(gap.duration_s)} giây</span><Link to={`/playback/${camera.id}?at=${encodeURIComponent(new Date(Date.parse(gap.start_at)-10000).toISOString())}`}>Xem lại</Link></li>)}</ul>:<p>Chưa phát hiện khoảng trống giữa các đoạn đang kiểm tra.</p>}<Link className="button" to={`/playback/${camera.id}`}>Mở Playback</Link></div></details>)}</div>
      {!!health.incidents.length&&<div className="system-incidents" role="status">{health.incidents.map(incident=><p key={incident.id}><strong>{health.cameras.find(c=>c.id===incident.camera_id)?.name??'Máy chủ'}</strong> · {incident.message}</p>)}</div>}
    </>}
    {performance&&<>
      <h3 className="system-performance-title">Tài nguyên và độ ồn</h3>
      <label className="system-setting-row"><span>Chế độ</span><select value={performance.settings.mode} disabled={busy} onChange={event=>void change({mode:event.target.value as PerformanceSettings['mode']})}><option value="quiet">Ít ồn · 720p</option><option value="balanced">Cân bằng · 1080p</option><option value="full">Đầy đủ · gốc</option></select></label>
      <label className="system-setting-row"><span>Mã hóa video</span><select value={performance.settings.encoder} disabled={busy} onChange={event=>void change({encoder:event.target.value as PerformanceSettings['encoder']})}><option value="software">CPU</option><option value="auto">Tự động</option><option value="nvenc" disabled={!performance.capabilities.nvenc.available}>NVIDIA GPU</option><option value="vaapi" disabled={!performance.capabilities.vaapi.available}>VAAPI GPU</option></select></label>
      <label className="system-setting-row system-setting-toggle"><span>Giảm AI khi khung hình yên tĩnh</span><input type="checkbox" role="switch" checked={performance.settings.adaptive_ai} disabled={busy} onChange={event=>void change({adaptive_ai:event.target.checked})}/></label>
      <label className="system-setting-row system-setting-toggle"><span>Cảnh báo lỗi ghi hình/máy chủ</span><input type="checkbox" role="switch" checked={performance.settings.monitoring_enabled} disabled={busy} onChange={event=>void change({monitoring_enabled:event.target.checked})}/></label>
      <p className="system-small-note">Giới hạn áp dụng cho luồng cần mã hóa; bản ghi gốc giữ nguyên. AI tối đa {performance.budget.ai_max_fps} hình/giây. Độ ồn còn phụ thuộc phần cứng.</p>
      <div className="system-performance-actions"><button type="button" disabled={busy||performance.checking} onClick={()=>void action(async()=>{const next=await systemApi.probe();if(alive.current)setPerformance(next);})}>{performance.checking?'Đang kiểm tra…':'Kiểm tra GPU'}</button>{!!performance.pending_streams.length&&<button type="button" disabled={busy} onClick={()=>{if(!window.confirm('Kết nối lại các luồng cần cập nhật? Ghi hình có thể gián đoạn ngắn.'))return;void action(async()=>{await systemApi.apply();const next=await systemApi.performance();if(alive.current){setPerformance(next);setNotice('Đang kết nối lại với cấu hình mới.');}});}}>Áp dụng cho {performance.pending_streams.length} luồng</button>}</div>
      <p className="system-small-note">CPU/RAM đo trong môi trường chạy máy chủ; nhiệt độ chỉ hiện khi hệ thống cung cấp.</p>
    </>}
    {notice&&<p role="status" className="system-small-note">{notice}</p>}
  </section>;
}
