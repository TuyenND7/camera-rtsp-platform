import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { operationsApi, operatingTimes, operatingTimezones, profileNames, type ProfileMode, type ProfileFlag, type ProfileSettings, type ProfileSnapshot, type WeeklyProfile } from './operationsApi';
import './operations.css';

const flagNames: Record<ProfileFlag, string> = { intrusion_enabled: 'Xâm nhập vùng', loitering_enabled: 'Lảng vảng', pacing_enabled: 'Đi qua lại', unfamiliar_enabled: 'Khuôn mặt chưa đăng ký', popup_enabled: 'Popup trên web' };
const dayNames = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const emptySchedule = (): WeeklyProfile => ({ id: `schedule-${globalThis.crypto?.randomUUID?.().slice(0, 8)??Math.random().toString(36).slice(2,10)}`, days: [1,2,3,4,5,6,0], start: '22:00', end: '07:00', mode: 'night' });
const changed = () => window.dispatchEvent(new Event('camera-station.profiles-updated'));

export function OperatingModeSelector({ compact = false }: { compact?: boolean }) {
  const [value, setValue] = useState<ProfileSnapshot | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active=useRef(true),locked=useRef(false),sequence=useRef(0),readJob=useRef(0);
  useEffect(()=>{active.current=true;readJob.current=0;const load=()=>{if(document.hidden||locked.current||readJob.current)return;const request=++sequence.current;readJob.current=request;void operationsApi.profiles().then(v=>{if(active.current&&request===sequence.current){setValue(v);setError('');}}).catch(()=>{if(active.current&&request===sequence.current)setError('Chưa đọc được chế độ.');}).finally(()=>{if(readJob.current===request)readJob.current=0;});};load();const timer=setInterval(load,15000);window.addEventListener('camera-station.profiles-updated',load);return()=>{active.current=false;sequence.current++;readJob.current=0;clearInterval(timer);window.removeEventListener('camera-station.profiles-updated',load);};},[]);
  return <label className={`operating-mode-selector${compact?' compact':''}`}><Icon name="shield" size={17}/><select aria-label="Chế độ vận hành" disabled={!value||busy} value={value?.settings.control==='schedule'?'schedule':value?.runtime.mode??'manual'} onChange={event=>{const mode=event.target.value as ProfileMode;if(locked.current)return;locked.current=true;const request=++sequence.current;readJob.current=0;setBusy(true);void operationsApi.selectMode(mode).then(v=>{if(active.current&&request===sequence.current){setValue(v);setError('');changed();}}).catch(e=>{if(active.current&&request===sequence.current)setError(e.message);}).finally(()=>{locked.current=false;if(active.current&&request===sequence.current)setBusy(false);});}}>{value?.settings.control==='schedule'&&<option value="schedule">Theo lịch · {profileNames[value.runtime.mode]}</option>}{Object.entries(profileNames).map(([mode,name])=><option key={mode} value={mode}>{name}</option>)}</select>{error&&<span role="alert" className="form-error">{error}</span>}</label>;
}

export default function OperatingProfilesSettings() {
  const [data,setData]=useState<ProfileSnapshot|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [reading,setReading]=useState(false);
  const [profile,setProfile]=useState<'home'|'away'|'night'>('away'),[camera,setCamera]=useState('');
  const [draft,setDraft]=useState<WeeklyProfile|null>(null),[editingId,setEditingId]=useState('');
  const active=useRef(true),locked=useRef(false),readSequence=useRef(0),readJob=useRef(0),draftRef=useRef(draft);draftRef.current=draft;
  async function refresh(){
    if(locked.current||readJob.current||draftRef.current)return;const sequence=++readSequence.current;readJob.current=sequence;setReading(true);
    try{const value=await operationsApi.profiles();if(active.current&&sequence===readSequence.current){setData(value);setCamera(current=>value.cameras.some(c=>String(c.id)===current)?current:String(value.cameras[0]?.id??''));setError('');}}
    catch(e){if(active.current&&sequence===readSequence.current)setError(e instanceof Error?e.message:'Chưa đọc được chế độ.');}
    finally{if(readJob.current===sequence){readJob.current=0;if(active.current)setReading(false);}}
  }
  useEffect(()=>{active.current=true;readJob.current=0;void refresh();const load=()=>{if(!document.hidden)void refresh();};const timer=setInterval(load,15000);document.addEventListener('visibilitychange',load);window.addEventListener('camera-station.profiles-updated',load);return()=>{active.current=false;readSequence.current++;readJob.current=0;clearInterval(timer);document.removeEventListener('visibilitychange',load);window.removeEventListener('camera-station.profiles-updated',load);};},[]);
  async function save(settings:ProfileSettings) {
    if(!data||locked.current)return;locked.current=true;readSequence.current++;readJob.current=0;setReading(false);setBusy(true);setError('');setNotice('');
    try{const result=await operationsApi.saveProfiles(data.revision,settings);if(active.current){setData(result);setNotice('Đã áp dụng.');changed();return true;}}
    catch(e){if(active.current)setError(e instanceof Error?e.message:'Chưa lưu được chế độ.');}
    finally{locked.current=false;if(active.current)setBusy(false);}return false;
  }
  function flag(key:ProfileFlag,value:string) {
    if(!data||!camera)return;const cameras={...data.settings.profiles[profile].cameras},overrides={...(cameras[camera]??{})};
    if(value==='default')delete overrides[key];else overrides[key]=value==='on';
    if(Object.keys(overrides).length)cameras[camera]=overrides;else delete cameras[camera];
    void save({...data.settings,profiles:{...data.settings.profiles,[profile]:{...data.settings.profiles[profile],cameras}}});
  }
  async function applySchedule() {
    if(!data||!draft)return;
    const schedules=editingId?data.settings.schedules.map(s=>s.id===editingId?draft:s):[...data.settings.schedules,draft];
    if(await save({...data.settings,schedules})){setDraft(null);setEditingId('');}
  }
  return <section id="profiles" className="panel settings-section operations-settings" aria-labelledby="profiles-title">
    <header className="settings-heading"><Icon name="shield" size={20}/><div><h2 id="profiles-title">Chế độ vận hành</h2></div><button type="button" className="icon-button" disabled={busy||reading||!!draft} aria-label="Đọc lại chế độ vận hành" onClick={()=>void refresh()}><Icon name="refresh" size={18}/></button></header>
    {error&&<p className="notice error" role="alert">{error}</p>}
    {data&&<>
      <label className="operations-row"><span>Đang dùng</span><select aria-label="Chọn chế độ vận hành" value={data.settings.control==='schedule'?'schedule':data.runtime.mode} disabled={busy||!!draft} onChange={event=>{if(!locked.current){locked.current=true;readSequence.current++;readJob.current=0;setReading(false);setBusy(true);void operationsApi.selectMode(event.target.value as ProfileMode).then(v=>{if(active.current){setData(v);setError('');changed();}}).catch(e=>{if(active.current)setError(e.message);}).finally(()=>{locked.current=false;if(active.current)setBusy(false);});}}}>{data.settings.control==='schedule'&&<option value="schedule">Theo lịch · {profileNames[data.runtime.mode]}</option>}{Object.entries(profileNames).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      <details className="operations-details"><summary>Tùy chỉnh từng chế độ<Icon name="chevronDown" size={16}/></summary><div>
        <label className="operations-row"><span>Chế độ</span><select aria-label="Chế độ cần tùy chỉnh" value={profile} disabled={busy} onChange={e=>setProfile(e.target.value as typeof profile)}>{(['home','away','night']as const).map(p=><option key={p} value={p}>{profileNames[p]}</option>)}</select></label>
        <label className="operations-row"><span>Cho phép thông báo</span><input type="checkbox" role="switch" checked={data.settings.profiles[profile].notifications_enabled} disabled={busy} onChange={e=>void save({...data.settings,profiles:{...data.settings.profiles,[profile]:{...data.settings.profiles[profile],notifications_enabled:e.target.checked}}})}/></label>
        <label className="operations-row"><span>Camera</span><select aria-label="Camera theo chế độ" value={camera} disabled={busy||!data.cameras.length} onChange={e=>setCamera(e.target.value)}>{!data.cameras.length&&<option value="">Chưa có camera</option>}{data.cameras.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        {!!camera&&(Object.keys(flagNames)as ProfileFlag[]).map(key=><label className="operations-row" key={key}><span>{flagNames[key]}</span><select aria-label={`${flagNames[key]} trong chế độ ${profileNames[profile]}`} value={data.settings.profiles[profile].cameras[camera]?.[key]===undefined?'default':data.settings.profiles[profile].cameras[camera][key]?'on':'off'} disabled={busy} onChange={e=>flag(key,e.target.value)}><option value="default">Theo camera</option><option value="on">Bật</option><option value="off">Tắt</option></select></label>)}
      </div></details>
      <label className="operations-row"><span>Tự chuyển theo lịch</span><input type="checkbox" role="switch" checked={data.settings.control==='schedule'} disabled={busy||!!draft} onChange={e=>void save({...data.settings,control:e.target.checked?'schedule':'manual'})}/></label>
      <label className="operations-row"><span>Múi giờ</span><select aria-label="Múi giờ lịch vận hành" value={data.settings.timezone} disabled={busy||!!draft} onChange={e=>void save({...data.settings,timezone:e.target.value})}>{operatingTimezones(data.settings.timezone).map(z=><option key={z}>{z}</option>)}</select></label>
      {data.settings.control==='schedule'&&<label className="operations-row"><span>Ngoài lịch</span><select aria-label="Chế độ ngoài lịch" value={data.settings.fallback_mode} disabled={busy||!!draft} onChange={e=>void save({...data.settings,fallback_mode:e.target.value as ProfileMode})}>{Object.entries(profileNames).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>}
      <div className="operations-schedules">{data.settings.schedules.map(s=><article key={s.id}><div><strong>{profileNames[s.mode]} · {s.start}–{s.end}</strong><small>{s.days.map(d=>dayNames[d]).join(', ')}{s.end<s.start?' · Qua nửa đêm':''}</small></div><button type="button" className="icon-button" disabled={busy||!!draft} aria-label={`Sửa lịch ${s.start}`} onClick={()=>{setDraft({...s,days:[...s.days]});setEditingId(s.id);}}><Icon name="edit" size={18}/></button><button type="button" className="icon-button danger-text" disabled={busy||!!draft} aria-label={`Xóa lịch ${s.start}`} onClick={()=>void save({...data.settings,schedules:data.settings.schedules.filter(old=>old.id!==s.id)})}><Icon name="trash" size={18}/></button></article>)}</div>
      {draft?<div className="operations-schedule-editor" data-settings-unsaved="true"><div className="operations-days" role="group" aria-label="Ngày áp dụng">{[1,2,3,4,5,6,0].map(d=><button type="button" key={d} aria-pressed={draft.days.includes(d)} disabled={busy} onClick={()=>setDraft({...draft,days:draft.days.includes(d)?draft.days.filter(x=>x!==d):[...draft.days,d]})}>{dayNames[d]}</button>)}</div><div className="operations-time-pair">{(['start','end']as const).map((key,i)=><label key={key}><span>{i?'Kết thúc':'Bắt đầu'}</span><select aria-label={i?'Giờ kết thúc lịch':'Giờ bắt đầu lịch'} value={draft[key]} disabled={busy} onChange={e=>setDraft({...draft,[key]:e.target.value})}>{operatingTimes([draft.start,draft.end]).map(t=><option key={t}>{t}</option>)}</select></label>)}</div><label className="operations-row"><span>Chế độ</span><select aria-label="Chế độ trong lịch" value={draft.mode} disabled={busy} onChange={e=>setDraft({...draft,mode:e.target.value as WeeklyProfile['mode']})}>{(['home','away','night']as const).map(p=><option key={p} value={p}>{profileNames[p]}</option>)}</select></label><div className="operations-actions"><button type="button" disabled={busy} onClick={()=>{setDraft(null);setEditingId('');}}>Hủy</button><button type="button" className="primary" disabled={busy||!draft.days.length||draft.start===draft.end} onClick={()=>void applySchedule()}>{editingId?'Áp dụng lịch':'Thêm lịch'}</button></div></div>:<button type="button" disabled={busy||data.settings.schedules.length>=28} onClick={()=>{setDraft(emptySchedule());setEditingId('');}}><Icon name="plus" size={17}/>Thêm lịch</button>}
      <p className="operations-note">Qua nửa đêm tính theo ngày bắt đầu. Lịch theo giờ địa phương, gồm cả lần lặp khi đổi giờ mùa hè. Ghi hình vẫn liên tục.</p>
    </>}
    {(busy||notice)&&<p className="operations-note" role="status">{busy?'Đang áp dụng…':notice}</p>}
  </section>;
}
