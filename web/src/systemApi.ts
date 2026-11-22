import { featureRequest } from './api';
export interface PerformanceSettings {mode:'balanced'|'quiet'|'full';encoder:'software'|'auto'|'nvenc'|'vaapi';adaptive_ai:boolean;monitoring_enabled:boolean}
export interface PerformanceSnapshot {settings:PerformanceSettings;revision:number;pending_streams:number[];checking:boolean;budget:{encoder:string;threads:number;width:number;fps:number;ai_max_fps:number};capabilities:Record<'nvenc'|'vaapi',{available:boolean;reason:string}>}
export interface HealthCamera {id:number;name:string;enabled:boolean;record:boolean;status:string;video:'ready'|'stalled'|'waiting'|'disabled';recording:'recording'|'stalled'|'waiting'|'disabled';playlist_age_ms:number|null;recording_end_at:string|null;gaps:Array<{start_at:string;end_at:string;duration_s:number;reason:string}>}
export interface HealthSnapshot {at:string;monitoring_enabled:boolean;warming_up:boolean;cpus:number;cpu_percent:number|null;memory_used_percent:number;backend_rss_mb:number;temperature_c:number|null;storage:{used_percent:number;free_bytes:number;writable:boolean}|null;cameras:HealthCamera[];incidents:Array<{id:string;camera_id:number;kind:string;message:string;opened_at:string}>;error?:string;server_time?:number;received_at?:number;checked_age_ms?:number}
const clock=(value:HealthSnapshot):HealthSnapshot=>({...value,received_at:Date.now(),checked_age_ms:value.server_time===undefined?0:Math.max(0,value.server_time-Date.parse(value.at))});
export const systemApi={
  health:(signal?:AbortSignal)=>featureRequest<HealthSnapshot>('/system/health',{signal}).then(clock),
  refreshHealth:()=>featureRequest<HealthSnapshot>('/system/health/refresh',{method:'POST'}).then(clock),
  performance:(signal?:AbortSignal)=>featureRequest<PerformanceSnapshot>('/system/performance',{signal}),
  savePerformance:(settings:PerformanceSettings,revision:number)=>featureRequest<PerformanceSnapshot>('/system/performance',{method:'PUT',body:JSON.stringify({settings,revision})}),
  probe:()=>featureRequest<PerformanceSnapshot>('/system/performance/probe',{method:'POST'}),
  apply:()=>featureRequest<{ok:boolean;restarted:number[]}>('/system/performance/apply',{method:'POST',body:JSON.stringify({confirm:true})}),
};
