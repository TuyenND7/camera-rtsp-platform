import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProfileSettings, ProfileSnapshot, PushSnapshot } from '../src/operationsApi';

/** Development-only UI state. Never registers/sends a push or touches hardware. */
export function createOperationsPreview() {
  let settings: ProfileSettings = { timezone:'Asia/Ho_Chi_Minh',control:'manual',manual_mode:'manual',fallback_mode:'manual',profiles:{home:{notifications_enabled:true,cameras:{}},away:{notifications_enabled:true,cameras:{}},night:{notifications_enabled:true,cameras:{}}},schedules:[] };
  let revision=1;
  let push:PushSnapshot={vapid_public_key:'ui-preview-no-real-key',profile_notifications_enabled:true,preferences:{enabled:true,timezone:'Asia/Ho_Chi_Minh',quiet_enabled:false,quiet_start:'22:00',quiet_end:'07:00',snooze_until:null},devices:[{id:'00000000-0000-4000-8000-000000000001',name:'Thiết bị mẫu',current_session:false,endpoint_fingerprint:'preview',expires_at:new Date(Date.now()+86400000).toISOString(),created_at:new Date().toISOString(),last_success_at:null,last_error:null}]};
  const snapshot=():ProfileSnapshot=>({settings,revision,cameras:[{id:1,name:'Phòng khách · ONVIF mẫu'},{id:2,name:'Sân trước · chỉ RTSP'},{id:3,name:'Cổng chính · mất kết nối'}],runtime:{mode:settings.control==='manual'?settings.manual_mode:settings.fallback_mode,source:settings.control==='manual'?'manual':'fallback',camera_overrides:settings.control==='manual'&&settings.manual_mode!=='manual'?settings.profiles[settings.manual_mode].cameras:{},notifications_enabled:settings.manual_mode==='manual'||settings.profiles[settings.manual_mode].notifications_enabled,settings_revision:revision,updated_at:new Date().toISOString()}});
  const json=(res:ServerResponse,value:unknown,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(value));};
  const body=async(req:IncomingMessage)=>{let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>16384)throw new Error('preview body too large');}return text?JSON.parse(text):{};};
  return async(req:IncomingMessage,res:ServerResponse,pathname:string,method:string):Promise<boolean>=>{
    if(!pathname.startsWith('/api/operations/'))return false;
    if(pathname==='/api/operations/profiles'){
      if(method==='PUT'){const data=await body(req);if(data.revision!==revision){json(res,{error:'Cấu hình đã thay đổi trên thiết bị khác. Đọc lại trước khi lưu.'},409);return true;}settings=data.settings;revision++;}
      json(res,snapshot());return true;
    }
    if(pathname==='/api/operations/profiles/mode'&&method==='POST'){const data=await body(req);settings={...settings,control:'manual',manual_mode:data.mode};revision++;json(res,snapshot());return true;}
    if(pathname==='/api/operations/push'){json(res,push);return true;}
    if(pathname==='/api/operations/push/preferences'&&method==='PUT'){push={...push,preferences:{...push.preferences,...await body(req)}};json(res,push);return true;}
    if(pathname==='/api/operations/push/snooze'&&method==='POST'){const data=await body(req);push.preferences.snooze_until=data.minutes?new Date(Date.now()+Number(data.minutes)*60000).toISOString():null;json(res,push);return true;}
    if(pathname.startsWith('/api/operations/push/devices/')&&method==='DELETE'){push.devices=push.devices.filter(d=>d.id!==pathname.split('/').pop());json(res,{ok:true});return true;}
    if(pathname==='/api/operations/push/test'&&method==='POST'){req.resume();json(res,{accepted:true,preview:true});return true;}
    req.resume();json(res,{error:'Bản xem trước không đăng ký hoặc gửi push thật.'},409);return true;
  };
}
