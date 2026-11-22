import fs from 'fs';
import path from 'path';
import { config } from '../config';

export interface CoverageSegment { file:string;start_ms:number;end_ms:number;duration_s:number }
export interface RecordingGap { start_at:string;end_at:string;duration_s:number;reason:string }
export function validRecordDay(day:string):boolean {
  if(!/^\d{8}$/.test(day))return false;
  const at=Date.UTC(Number(day.slice(0,4)),Number(day.slice(4,6))-1,Number(day.slice(6,8)));
  return new Date(at).toISOString().slice(0,10).replace(/-/g,'')===day;
}
export function recordDay(at=Date.now()):string {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:config.recordTimezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(at));
  return ['year','month','day'].map(type=>parts.find(p=>p.type===type)?.value??'').join('');
}
export function previousDay(day:string):string {
  return new Date(Date.UTC(Number(day.slice(0,4)),Number(day.slice(4,6))-1,Number(day.slice(6,8)))-86400000).toISOString().slice(0,10).replace(/-/g,'');
}
export function parseRecordingCoverage(text:string):CoverageSegment[] {
  let duration=0;
  const result=new Map<string,CoverageSegment>();
  for(const line of text.split(/\r?\n/)) {
    const ext=/^#EXTINF:([\d.]+)/.exec(line);
    if(ext){duration=Number(ext[1]);continue;}
    const match=/^rec_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.ts$/.exec(line.trim());
    if(!line||line.startsWith('#'))continue;
    if(!match||!Number.isFinite(duration)||duration<=0||duration>3600){duration=0;continue;}
    const parts=match.slice(1).map(Number);
    const start=Date.UTC(parts[0],parts[1]-1,parts[2],parts[3],parts[4],parts[5]);
    const iso=new Date(start).toISOString().replace(/[-:TZ.]/g,'');
    if(iso.slice(0,14)!==match.slice(1).join('')){duration=0;continue;}
    result.set(line.trim(),{file:line.trim(),start_ms:start,end_ms:start+duration*1000,duration_s:duration});
    duration=0;
    if(result.size>20000)break;
  }
  return [...result.values()].sort((a,b)=>a.start_ms-b.start_ms);
}
export function coverageGaps(segments:CoverageSegment[],toleranceMs=2000):RecordingGap[] {
  const result:RecordingGap[]=[];let end:number|undefined;
  for(const s of [...segments].sort((a,b)=>a.start_ms-b.start_ms)) {
    if(end!==undefined&&s.start_ms-end>toleranceMs)result.push({start_at:new Date(end).toISOString(),end_at:new Date(s.start_ms).toISOString(),duration_s:Math.round((s.start_ms-end)/1000),reason:'missing_recording'});
    end=Math.max(end??0,s.end_ms);
  }
  return result;
}
export async function readCoverage(cameraId:number,day:string):Promise<{segments:CoverageSegment[];index_age_ms:number|null}> {
  if(!Number.isInteger(cameraId)||cameraId<1||!validRecordDay(day))throw new Error('invalid_recording');
  const file=path.join(config.storageRoot,'rec',String(cameraId),day,'index.m3u8');
  try {
    const stat=await fs.promises.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024*1024)throw new Error('invalid_recording');
    return {segments:parseRecordingCoverage(await fs.promises.readFile(file,'utf8')),index_age_ms:Math.max(0,Date.now()-stat.mtimeMs)};
  } catch(err) {
    if((err as NodeJS.ErrnoException).code==='ENOENT')return {segments:[],index_age_ms:null};
    throw err;
  }
}
