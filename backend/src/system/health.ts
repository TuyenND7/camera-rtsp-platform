import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { pool } from '../db';
import { config } from '../config';
import { streamManager } from '../stream/manager';
import { currentPerformance, performanceState } from './performance';
import { coverageGaps, readCoverage, recordDay, previousDay, RecordingGap } from './coverage';

export type HealthKind='camera_offline'|'video_stalled'|'recording_stopped'|'storage_error'|'resource_overload';
type Camera={id:number;name:string;enabled:boolean;record:boolean;status:string};
export type CameraHealth={id:number;name:string;enabled:boolean;record:boolean;status:string;video:'ready'|'stalled'|'waiting'|'disabled';recording:'recording'|'stalled'|'waiting'|'disabled';playlist_age_ms:number|null;recording_end_at:string|null;gaps:RecordingGap[];runtime:ReturnType<typeof streamManager.health>[number]|null;record_error:boolean};
export interface HealthSnapshot { at:string;monitoring_enabled:boolean;warming_up:boolean;cpus:number;cpu_percent:number|null;memory_used_percent:number;backend_rss_mb:number;temperature_c:number|null;storage:{used_percent:number;free_bytes:number;writable:boolean}|null;cameras:CameraHealth[];incidents:Array<{id:string;camera_id:number;kind:HealthKind;message:string;opened_at:string}>;performance:ReturnType<typeof performanceState>;error?:string }

export function evaluateCameraHealth(camera:Camera,now:number,playlistAge:number|null,recordingEnd:number|null,warm:boolean,recordWarm=false,frameAge:number|null=null) {
  const disabled=!camera.enabled;
  const framesMoving=frameAge===null||frameAge<=Math.max(15000,config.hlsSegmentSeconds*5000);
  const video:CameraHealth['video']=disabled?'disabled':framesMoving&&playlistAge!==null&&playlistAge<=Math.max(12000,config.hlsSegmentSeconds*5000)&&camera.status==='online'?'ready':warm?'waiting':'stalled';
  const recent=recordingEnd!==null&&now-recordingEnd<=Math.max(45000,config.recordSegmentSeconds*2000+15000);
  const recording:CameraHealth['recording']=disabled||!camera.record?'disabled':recent?(camera.status==='online'?'recording':'waiting'):warm||recordWarm?'waiting':'stalled';
  return {video,recording};
}
function cpuTimes(){return os.cpus().map(c=>({idle:c.times.idle,total:Object.values(c.times).reduce((a,b)=>a+b,0)}));}
async function availableMemory():Promise<number>{
  if(process.platform==='linux')try{const text=await fs.promises.readFile('/proc/meminfo','utf8');const value=Number(text.match(/^MemAvailable:\s*(\d+)/m)?.[1]);if(Number.isFinite(value))return value*1024;}catch{/* use OS fallback */}
  return os.freemem();
}
async function temperature():Promise<number|null>{
  if(process.platform!=='linux')return null;
  try{
    const zones=(await fs.promises.readdir('/sys/class/thermal')).filter(n=>/^thermal_zone\d+$/.test(n)).slice(0,8);
    const values=await Promise.all(zones.map(n=>fs.promises.readFile(`/sys/class/thermal/${n}/temp`,'utf8').then(v=>Number(v)/1000,()=>NaN)));
    const valid=values.filter(v=>Number.isFinite(v)&&v>=-20&&v<=140);return valid.length?Math.max(...valid):null;
  }catch{return null;}
}
export class HealthMonitor {
  private timer?:NodeJS.Timeout;
  private busy=false;
  private stopped=false;
  private boot=Date.now();
  private cpu=cpuTimes();
  private firstBad=new Map<string,number>();
  private open=new Map<string,HealthSnapshot['incidents'][number]>();
  private lastDiskCheck=0;
  private writable=true;
  private lastMaintenance=0;
  private coverageVersions=new Map<number,string>();
  private enabledSince=new Map<number,number>();
  private recordSince=new Map<number,number>();
  constructor(private warmupMs=45000){}
  private value:HealthSnapshot={at:new Date().toISOString(),monitoring_enabled:true,warming_up:true,cpus:os.availableParallelism(),cpu_percent:null,memory_used_percent:0,backend_rss_mb:0,temperature_c:null,storage:null,cameras:[],incidents:[],performance:performanceState()};
  snapshot():HealthSnapshot{return JSON.parse(JSON.stringify({...this.value,incidents:[...this.open.values()],performance:performanceState()}));}
  async start():Promise<{stop():void}>{
    const {rows}=await pool.query('SELECT id,camera_id,kind,message,opened_at FROM camera_health_incidents WHERE recovered_at IS NULL');
    for(const row of rows)this.open.set(`${row.camera_id}:${row.kind}`,{...row,opened_at:new Date(row.opened_at).toISOString()});
    this.stopped=false;this.boot=Date.now();await this.scan();
    this.timer=setInterval(()=>void this.scan(),5000);this.timer.unref();
    return {stop:()=>{this.stopped=true;if(this.timer)clearInterval(this.timer);}};
  }
  private async condition(cameraId:number,kind:HealthKind,bad:boolean,message:string,delay:number,now:number):Promise<void>{
    const key=`${cameraId}:${kind}`;
    if(!bad){this.firstBad.delete(key);const active=this.open.get(key);if(active){await pool.query('UPDATE camera_health_incidents SET recovered_at=$1 WHERE id=$2',[new Date(now),active.id]);this.open.delete(key);}return;}
    const since=this.firstBad.get(key)??now;this.firstBad.set(key,since);
    if(this.open.has(key)||now-since<delay||this.stopped)return;
    const client=await pool.connect();
    try{
      // All notification producers use the same transaction lock: ID cursors must
      // never pass a lower ID that has been allocated but not committed yet.
      await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(731923,2)');
      const found=await client.query('SELECT id,camera_id,kind,message,opened_at FROM camera_health_incidents WHERE camera_id=$1 AND kind=$2 AND recovered_at IS NULL',[cameraId,kind]);
      let row=found.rows[0];
      if(!row){
        const id=randomUUID(),at=new Date(now);
        const notice=await client.query(`INSERT INTO surveillance_notifications(camera_id,kind,zone_id,track_id,label,detected_at,metrics,message)
          VALUES($1,$2,'system',$3,'system',$4,'{}'::jsonb,$5) RETURNING id`,[cameraId,kind,`health-${id}`,at,message]);
        await client.query('INSERT INTO camera_health_incidents(id,camera_id,kind,message,opened_at,notification_id) VALUES($1,$2,$3,$4,$5,$6)',[id,cameraId,kind,message,at,notice.rows[0].id]);
        row={id,camera_id:cameraId,kind,message,opened_at:at};
      }
      await client.query('COMMIT');this.open.set(key,{...row,opened_at:new Date(row.opened_at).toISOString()});
    }catch(err){await client.query('ROLLBACK');throw err;}finally{client.release();}
  }
  private async disk(now:number){
    try{
      const stat=await fs.promises.statfs(config.storageRoot),total=Number(stat.blocks)*Number(stat.bsize),free=Number(stat.bavail)*Number(stat.bsize);
      if(!this.writable||now-this.lastDiskCheck>=60000){
        const file=path.join(config.storageRoot,`.health-check-${randomUUID()}`);
        try{await fs.promises.writeFile(file,'1',{flag:'wx',mode:0o600});this.writable=true;}catch{this.writable=false;}
        finally{await fs.promises.unlink(file).catch(()=>undefined);}this.lastDiskCheck=now;
      }
      return {used_percent:total?Math.round((total-free)/total*1000)/10:0,free_bytes:free,writable:this.writable};
    }catch{this.writable=false;return null;}
  }
  async scan():Promise<void>{
    if(this.busy||this.stopped)return;this.busy=true;
    try{
      const now=Date.now(),warming=now-this.boot<this.warmupMs,settings=currentPerformance();
      const [{rows},disk,temp,freeMemory]=await Promise.all([pool.query<Camera>('SELECT id,name,enabled,record,status FROM cameras ORDER BY id'),this.disk(now),temperature(),availableMemory()]);
      const times=cpuTimes();let total=0,idle=0;
      times.forEach((c,i)=>{if(this.cpu[i]){total+=c.total-this.cpu[i].total;idle+=c.idle-this.cpu[i].idle;}});this.cpu=times;
      const cpu=total>0?Math.max(0,Math.min(100,Math.round((1-idle/total)*1000)/10)):null;
      const memory=os.totalmem()?Math.round((1-freeMemory/os.totalmem())*1000)/10:0;
      const runtime=new Map(streamManager.health().map(w=>[w.camera_id,w]));
      const day=recordDay(now),cameras:CameraHealth[]=[];
      // Bound bind-mount I/O and database work regardless of the number of cameras.
      for(let index=0;index<rows.length;index+=4){
        const chunk=await Promise.all(rows.slice(index,index+4).map(async c=>{
          if(c.enabled&&!this.enabledSince.has(c.id))this.enabledSince.set(c.id,now);
          if(!c.enabled)this.enabledSince.delete(c.id);
          if(c.enabled&&c.record&&!this.recordSince.has(c.id))this.recordSince.set(c.id,now);
          if(!c.enabled||!c.record)this.recordSince.delete(c.id);
          const cameraWarm=warming||now-(this.enabledSince.get(c.id)??now)<30000;
          const recordWarm=now-(this.recordSince.get(c.id)??now)<Math.max(45000,config.recordSegmentSeconds*2000+30000);
          let age:number|null=null,end:number|null=null,gaps:RecordingGap[]=[],recordError=false;
          const liveFile=path.join(config.storageRoot,'live',String(c.id),'index.m3u8');
          try{const stat=await fs.promises.lstat(liveFile);if(stat.isFile()&&!stat.isSymbolicLink())age=Math.max(0,now-stat.mtimeMs);}catch{/* missing Live */}
          if(c.record&&c.enabled){
            try{
              const coverage=await Promise.all([readCoverage(c.id,previousDay(day)),readCoverage(c.id,day)]);
              const segments=coverage.flatMap(v=>v.segments).filter(s=>s.end_ms<=now+5000).sort((a,b)=>a.start_ms-b.start_ms);
              end=segments.length?segments[segments.length-1].end_ms:null;gaps=coverageGaps(segments).slice(-50);
              const version=`${day}:${segments.length}:${end}`;
              if(this.coverageVersions.get(c.id)!==version){
                for(const gap of gaps)await pool.query('INSERT INTO recording_gaps(camera_id,start_at,end_at,reason) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[c.id,gap.start_at,gap.end_at,gap.reason]);
                this.coverageVersions.set(c.id,version);
              }
            }catch{recordError=true;}
          }
          const stream=runtime.get(c.id)??null;
          return {...c,...evaluateCameraHealth(c,now,age,end,cameraWarm,recordWarm,stream?.last_frame_change_age_ms??null),playlist_age_ms:age,recording_end_at:end?new Date(end).toISOString():null,gaps,runtime:stream,record_error:recordError};
        }));cameras.push(...chunk);
      }
      this.value={at:new Date(now).toISOString(),monitoring_enabled:settings.monitoring_enabled,warming_up:warming,cpus:os.availableParallelism(),cpu_percent:cpu,memory_used_percent:memory,
        backend_rss_mb:Math.round(process.memoryUsage().rss/1048576),temperature_c:temp,storage:disk,cameras,incidents:[...this.open.values()],performance:performanceState()};
      if(settings.monitoring_enabled&&!warming){
        for(const c of cameras){
          await this.condition(c.id,'camera_offline',c.enabled&&c.status!=='online'&&c.video!=='waiting','Camera không nhận được hình. Kiểm tra nguồn, mạng hoặc kết nối lại.',15000,now);
          await this.condition(c.id,'video_stalled',c.enabled&&c.status==='online'&&c.video==='stalled','Camera còn kết nối nhưng video hoặc playlist Live không tiến triển.',15000,now);
          await this.condition(c.id,'recording_stopped',c.enabled&&c.record&&c.recording==='stalled','Đoạn ghi hình mới chưa được hoàn thành đúng hạn.',15000,now);
          await this.condition(c.id,'storage_error',c.enabled&&c.record&&(c.record_error||!disk||!disk.writable||disk.free_bytes<128*1024*1024),'Không đọc/ghi được nơi lưu recording hoặc ổ gần hết dung lượng.',15000,now);
        }
        // Host incidents need a stable FK anchor even if a camera is disabled.
        const context=rows[0];
        for(const incident of [...this.open.values()])if(incident.kind==='resource_overload'&&incident.camera_id!==context?.id){
          await this.condition(incident.camera_id,'resource_overload',false,'',0,now);
        }
        if(context){
          await this.condition(context.id,'resource_overload',(cpu!==null&&cpu>=95)||memory>=96||(temp!==null&&temp>=85),'Tài nguyên máy chủ ở mức cao kéo dài. Kiểm tra tải hoặc chọn chế độ ít ồn.',60000,now);
        }
      }
      const ids=new Set(rows.map(c=>c.id));for(const [key,value] of this.open)if(!ids.has(value.camera_id))this.open.delete(key);
      for(const map of [this.enabledSince,this.recordSince,this.coverageVersions])for(const id of map.keys())if(!ids.has(id))map.delete(id);
      if(now-this.lastMaintenance>3600000){
        await pool.query("DELETE FROM camera_health_incidents WHERE recovered_at<now()-interval '30 days'");
        await pool.query("DELETE FROM recording_gaps WHERE end_at<now()-interval '30 days'");this.lastMaintenance=now;
      }
    }catch(err){this.value={...this.value,error:'Chưa đọc được đầy đủ trạng thái máy chủ.'};console.warn('[system] health check deferred:',(err as NodeJS.ErrnoException).code??'unavailable');}
    finally{this.busy=false;}
  }
}
export const systemHealth=new HealthMonitor();
