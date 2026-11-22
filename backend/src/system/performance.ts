import fs from 'fs';
import { execFile } from 'child_process';
import { pool } from '../db';

export type Encoder = 'software' | 'auto' | 'nvenc' | 'vaapi';
export type PerformanceMode = 'balanced' | 'quiet' | 'full';
export interface PerformanceSettings { mode: PerformanceMode; encoder: Encoder; adaptive_ai: boolean; monitoring_enabled: boolean }
export interface EncoderBudget {
  encoder: Exclude<Encoder,'auto'>; threads: number; width: number; fps: number; ai_max_fps: number;
  preset: string | null; share_encoder: boolean; adaptive_ai: boolean; idle_seconds: number;
}
type Capability = { available: boolean; reason: string };
export const performanceDefaults: PerformanceSettings = { mode:'balanced',encoder:'software',adaptive_ai:false,monitoring_enabled:true };
let settings = { ...performanceDefaults }, revision = 0;
let capabilities: Record<'nvenc'|'vaapi',Capability> = {
  nvenc:{available:false,reason:'Chưa kiểm tra phần cứng.'}, vaapi:{available:false,reason:'Chưa kiểm tra phần cứng.'},
};
let probeInFlight: Promise<void> | null = null;
let saveQueue: Promise<unknown> = Promise.resolve();
let onBudget: ((budget: EncoderBudget) => void) | undefined;

export function validPerformance(value: unknown): value is PerformanceSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as PerformanceSettings;
  return Object.keys(v).length === 4 && ['balanced','quiet','full'].includes(v.mode) &&
    ['software','auto','nvenc','vaapi'].includes(v.encoder) && typeof v.adaptive_ai === 'boolean' && typeof v.monitoring_enabled === 'boolean';
}
export function encoderBudget(value = settings, available = capabilities): EncoderBudget {
  const requested = value.encoder === 'auto' ? available.nvenc.available ? 'nvenc' : available.vaapi.available ? 'vaapi' : 'software' : value.encoder;
  const encoder = requested !== 'software' && !available[requested].available ? 'software' : requested;
  const limits = value.mode === 'quiet' ? { threads:2,width:1280,fps:10,ai_max_fps:1,preset:'ultrafast' }
    : value.mode === 'balanced' ? { threads:4,width:1920,fps:15,ai_max_fps:2,preset:'veryfast' }
    : { threads:0,width:0,fps:0,ai_max_fps:10,preset:null };
  return { encoder,...limits,share_encoder:true,adaptive_ai:value.adaptive_ai,idle_seconds:5 };
}
export function encodingSignature(budget=encoderBudget()):string {
  return JSON.stringify({encoder:budget.encoder,threads:budget.threads,width:budget.width,fps:budget.fps,preset:budget.preset,share_encoder:budget.share_encoder});
}
export function performanceState() { return { settings:{...settings},revision,budget:encoderBudget(),capabilities:JSON.parse(JSON.stringify(capabilities)),checking:!!probeInFlight }; }
export function currentPerformance(): PerformanceSettings { return { ...settings }; }
export function setBudgetListener(listener: (budget: EncoderBudget) => void): void { onBudget=listener; listener(encoderBudget()); }

export async function loadPerformance(): Promise<void> {
  const run=saveQueue.then(async()=>{
    const {rows} = await pool.query('SELECT value,revision FROM system_preferences WHERE id=1');
    if (rows[0] && validPerformance(rows[0].value)) { settings=rows[0].value;revision=rows[0].revision; }
    onBudget?.(encoderBudget());
  });
  saveQueue=run.catch(()=>undefined);await run;
}
export async function savePerformance(value: PerformanceSettings, expected: number, userId: number) {
  const run = saveQueue.then(async () => {
    if (!validPerformance(value)) throw new Error('invalid_settings');
    if (value.encoder !== 'software' && value.encoder !== 'auto' && !capabilities[value.encoder].available) throw new Error('encoder_unavailable');
    if (expected !== revision) throw new Error('revision_conflict');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(731924,1)');
      const old = await client.query('SELECT revision FROM system_preferences WHERE id=1 FOR UPDATE');
      if ((old.rows[0]?.revision ?? 0) !== expected) throw new Error('revision_conflict');
      const next=expected+1;
      await client.query(`INSERT INTO system_preferences(id,value,revision,updated_by) VALUES(1,$1::jsonb,$2,$3)
        ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value,revision=EXCLUDED.revision,updated_by=EXCLUDED.updated_by,updated_at=now()`,[JSON.stringify(value),next,userId]);
      await client.query(`INSERT INTO system_runtime(id,value) VALUES(1,$1::jsonb)
        ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,[JSON.stringify(encoderBudget(value))]);
      await client.query('COMMIT');
      settings={...value};revision=next;onBudget?.(encoderBudget());
      return performanceState();
    } catch(err) { await client.query('ROLLBACK');throw err; }
    finally { client.release(); }
  });
  saveQueue=run.catch(()=>undefined);return run;
}

async function canEncode(encoder: 'nvenc'|'vaapi'): Promise<Capability> {
  if (process.platform !== 'linux') return {available:false,reason:'Bộ mã hóa này cần thiết bị GPU trong máy chủ Linux/Docker.'};
  const device=encoder==='nvenc'?'/dev/nvidia0':'/dev/dri/renderD128';
  const devices=encoder==='nvenc'?[device,'/dev/dxg']:[device];
  const visible=process.env.NVIDIA_VISIBLE_DEVICES;
  const declared=encoder==='nvenc'&&!!visible&&!['none','void'].includes(visible);
  if (!declared&&!(await Promise.all(devices.map(d=>fs.promises.access(d).then(()=>true,()=>false)))).some(Boolean)) return {available:false,reason:'Chưa có thiết bị GPU được cấp cho container.'};
  const args=['-hide_banner','-v','error',...(encoder==='vaapi'?['-vaapi_device',device]:[]),'-f','lavfi','-i','color=size=64x64:rate=1','-frames:v','1','-an',
    ...(encoder==='vaapi'?['-vf','format=nv12,hwupload','-c:v','h264_vaapi']:['-c:v','h264_nvenc']),'-f','null','-'];
  return new Promise(resolve=>execFile('ffmpeg',args,{timeout:8000,maxBuffer:16384},err=>resolve({available:!err,reason:err?'GPU hoặc FFmpeg chưa sẵn sàng cho bộ mã hóa này.':'Đã kiểm tra mã hóa mẫu thành công.'})));
}
async function publishBudget(): Promise<void> {
  const run=saveQueue.then(async()=>{
    const budget=encoderBudget();
    await pool.query(`INSERT INTO system_runtime(id,value) VALUES(1,$1::jsonb) ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,[JSON.stringify(budget)]);
    onBudget?.(budget);
  });
  saveQueue=run.catch(()=>undefined);await run;
}
export function probeEncoders(): Promise<void> {
  if (probeInFlight) return probeInFlight;
  probeInFlight=(async()=>{
    const [nvenc,vaapi]=await Promise.all([canEncode('nvenc'),canEncode('vaapi')]);
    capabilities={nvenc,vaapi};await publishBudget();
  })().finally(()=>{probeInFlight=null;});
  return probeInFlight;
}
export function encoderFailed(encoder: string): void {
  if (encoder !== 'nvenc' && encoder !== 'vaapi') return;
  capabilities[encoder]={available:false,reason:'Mã hóa phần cứng vừa thất bại; đang dùng phần mềm để giữ luồng.'};
  void publishBudget().catch(()=>undefined);
}
export async function startPerformance(): Promise<{stop():void}> {
  await loadPerformance();await publishBudget();
  void probeEncoders().catch(()=>undefined);
  const timer=setInterval(()=>void probeEncoders().catch(()=>undefined),600000);timer.unref();
  return {stop:()=>clearInterval(timer)};
}
