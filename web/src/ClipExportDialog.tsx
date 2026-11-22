import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Camera } from './api';
import { evidenceApi, clipStatusLabels, type EvidenceClip } from './evidenceApi';
import Icon from './Icon';
import { lockBodyScroll } from './bodyScroll';
import { formatBytes } from './ui';
import './evidence.css';

function localInput(at: number): string {
  const date = new Date(at), n = (value: number) => String(value).padStart(2,'0');
  return `${date.getFullYear()}-${n(date.getMonth()+1)}-${n(date.getDate())}T${n(date.getHours())}:${n(date.getMinutes())}:${n(date.getSeconds())}`;
}
export default function ClipExportDialog({ cameraId, cameraName, at = Date.now()-60_000, eventId, noticeId, onClose }: {
  cameraId?: number; cameraName?: string; at?: string | number; eventId?: string; noticeId?: string; onClose: () => void;
}) {
  const instant = typeof at === 'string' ? Date.parse(at) : at, dialog = useRef<HTMLDialogElement>(null), id = useId();
  const [camera,setCamera] = useState(cameraId ?? 0), [cameras,setCameras] = useState<Camera[]>([]);
  const [start,setStart] = useState(localInput(instant-10_000)), [end,setEnd] = useState(localInput(instant+20_000)), [title,setTitle] = useState('');
  const [job,setJob] = useState<EvidenceClip | null>(null), [busy,setBusy] = useState(false), [error,setError] = useState('');
  const key = useRef(crypto.randomUUID()), alive = useRef(true), submitting = useRef(false);
  useEffect(() => {
    const previous = document.activeElement; dialog.current?.showModal(); const unlock = lockBodyScroll(); alive.current = true;
    void api.listCameras().then(values => { if(alive.current){ setCameras(values);if(!cameraId)setCamera(values[0]?.id ?? 0); } }).catch(() => undefined);
    return () => { alive.current=false;dialog.current?.close();unlock();if(previous instanceof HTMLElement&&previous.isConnected)previous.focus({ preventScroll:true }); };
  },[]);
  useEffect(() => { key.current=crypto.randomUUID(); },[camera,start,end,title]);
  useEffect(() => {
    if(!job || !['preparing','queued','processing'].includes(job.status))return;
    let active=true,timer:number|undefined,controller:AbortController|undefined;
    const poll=async()=>{controller=new AbortController();try{const next=await evidenceApi.clip(job.id,controller.signal);if(active){setJob(next);setError('');}}catch(error){if(active&&!controller.signal.aborted)setError(error instanceof Error?error.message:'Chưa cập nhật được clip.');}if(active)timer=window.setTimeout(()=>void poll(),2000);};
    timer=window.setTimeout(()=>void poll(),1000);return()=>{active=false;controller?.abort();window.clearTimeout(timer);};
  },[job?.id,job?.status]);
  async function create(){
    if(submitting.current)return;
    const a=Date.parse(start),b=Date.parse(end);
    if(!camera||!Number.isFinite(a)||!Number.isFinite(b)||b-a<500||b-a>1800_000){setError('Chọn camera và khoảng thời gian tối đa 30 phút.');return;}
    submitting.current=true;setBusy(true);setError('');
    try{const result=await evidenceApi.create({ camera_id:camera,start_at:new Date(a).toISOString(),end_at:new Date(b).toISOString(),title,idempotency_key:key.current,
      ...(camera===cameraId&&instant>=a&&instant<b?{ event_id:eventId,notice_id:noticeId }: {}) });if(alive.current)setJob(result);}
    catch(error){if(alive.current)setError(error instanceof Error?error.message:'Chưa tạo được clip.');}
    finally{submitting.current=false;if(alive.current)setBusy(false);}
  }
  const pending=job&&['preparing','queued','processing'].includes(job.status);
  return <dialog ref={dialog} className="device-dialog clip-export-dialog" aria-labelledby={`${id}-title`} onCancel={event=>{event.preventDefault();if(!busy)onClose();}}>
    <header className="dialog-heading"><div><h2 id={`${id}-title`}>Giữ clip chứng cứ</h2><p>{cameras.find(item=>item.id===camera)?.name ?? (camera===cameraId?cameraName:undefined) ?? 'MP4 · H.264'} · tối đa 30 phút</p></div><button type="button" className="icon-button" disabled={busy} onClick={onClose} aria-label="Đóng giữ clip"><Icon name="close"/></button></header>
    <div className="evidence-dialog-body">{error&&<p className="form-error" role="alert">{error}</p>}
      {!job?<><label>Camera<select value={camera} disabled={busy} onChange={event=>setCamera(Number(event.target.value))}>{!cameras.some(item=>item.id===camera)&&<option value={camera}>{cameraName ?? 'Chọn camera'}</option>}{cameras.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><div className="evidence-time-fields"><label>Từ<input type="datetime-local" step="1" value={start} disabled={busy} onChange={event=>setStart(event.target.value)}/></label><label>Đến<input type="datetime-local" step="1" value={end} disabled={busy} onChange={event=>setEnd(event.target.value)}/></label></div><label>Tên clip<input value={title} maxLength={100} disabled={busy} onChange={event=>setTitle(event.target.value)} placeholder="Không bắt buộc"/></label><div className="evidence-preset-row">{[10,30,60,300].map(seconds=><button type="button" key={seconds} disabled={busy} onClick={()=>{setStart(localInput(instant-seconds*1000/3));setEnd(localInput(instant+seconds*2000/3));}}>{seconds<60?`${seconds}s`:`${seconds/60} phút`}</button>)}</div><p className="evidence-hint">Chỉ dùng bản ghi đã hoàn tất. Clip sẵn sàng sẽ được giữ riêng cho tới khi bạn xóa.</p></>:<section className="evidence-job-result"><strong>{clipStatusLabels[job.status]}</strong>{pending&&<progress max="100" value={job.progress} aria-label="Tiến trình tạo clip"/>}<span>{new Date(job.start_at).toLocaleString('vi-VN')} → {new Date(job.end_at).toLocaleString('vi-VN')}</span>{job.status==='ready'&&<><p>{job.duration_seconds?.toFixed(1)} giây · {formatBytes(job.size_bytes)}</p><a className="button" href={job.download_url ?? undefined} download><Icon name="folder" size={17}/>Tải MP4</a></>}{job.error&&<p className="form-error">{job.error}</p>}{!!job.gaps.length&&<details className="evidence-gap-details"><summary>Thiếu {job.gaps.reduce((sum,gap)=>sum+gap.seconds,0).toFixed(1)} giây trong khoảng chọn</summary>{job.gaps.map((gap,index)=><p key={index}>{new Date(gap.start_at).toLocaleTimeString('vi-VN')} → {new Date(gap.end_at).toLocaleTimeString('vi-VN')} · {gap.seconds}s</p>)}</details>}{pending&&<p className="evidence-hint">Có thể đóng cửa sổ; máy chủ tiếp tục xử lý.</p>}</section>}
    </div><footer className="dialog-footer"><Link className="button" to="/clips" onClick={onClose}>Kho clip</Link>{pending&&<button type="button" disabled={busy} onClick={()=>{setBusy(true);void evidenceApi.cancel(job!.id).then(()=>evidenceApi.clip(job!.id)).then(value=>{if(alive.current)setJob(value);}).catch(error=>{if(alive.current)setError(error.message);}).finally(()=>{if(alive.current)setBusy(false);});}}>Hủy tác vụ</button>}{!job&&<button type="button" className="primary" disabled={busy||!camera} onClick={()=>void create()}>{busy?'Đang chuẩn bị…':'Giữ clip'}</button>}{job&&!pending&&<button type="button" onClick={()=>{setJob(null);setError('');key.current=crypto.randomUUID();}}>Clip khác</button>}</footer>
  </dialog>;
}
