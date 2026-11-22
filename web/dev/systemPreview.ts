import type { IncomingMessage,ServerResponse } from 'node:http';
import type { HealthSnapshot,PerformanceSnapshot } from '../src/systemApi';
export function createSystemPreview(){
  let performance:PerformanceSnapshot={settings:{mode:'balanced',encoder:'software',adaptive_ai:false,monitoring_enabled:true},revision:0,pending_streams:[],checking:false,budget:{encoder:'software',threads:4,width:1920,fps:15,ai_max_fps:2},capabilities:{nvenc:{available:false,reason:'GPU mẫu chưa cấp cho container.'},vaapi:{available:false,reason:'GPU mẫu chưa cấp cho container.'}}};
  const json=(res:ServerResponse,value:unknown,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(value));};
  const health=():HealthSnapshot=>({at:new Date().toISOString(),monitoring_enabled:performance.settings.monitoring_enabled,warming_up:false,cpus:8,cpu_percent:24,memory_used_percent:36,backend_rss_mb:84,temperature_c:null,storage:{used_percent:48,free_bytes:200*1024**3,writable:true},incidents:[],cameras:[1,2,3].map(id=>({id,name:id===1?'Phòng khách':id===2?'Sân trước':'Cổng chính',enabled:true,record:true,status:id===3?'error':'online',video:id===3?'stalled':'ready',recording:id===3?'stalled':'recording',playlist_age_ms:id===3?60000:1000,recording_end_at:new Date(Date.now()-(id===3?120000:40000)).toISOString(),gaps:id===2?[{start_at:new Date(Date.now()-600000).toISOString(),end_at:new Date(Date.now()-540000).toISOString(),duration_s:60,reason:'missing_recording'}]:[]}))});
  return async(req:IncomingMessage,res:ServerResponse,pathname:string,method:string)=>{
    if(!pathname.startsWith('/api/system/'))return false;
    if(pathname==='/api/system/health'||pathname==='/api/system/health/refresh'){req.resume();json(res,health());return true;}
    if(pathname==='/api/system/health/incidents'){json(res,[]);return true;}
    if(pathname==='/api/system/performance'){
      if(method==='PUT'){
        let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>16384){json(res,{error:'Request too large'},413);return true;}}
        const b=JSON.parse(raw);if(b.revision!==performance.revision){json(res,{error:'Cấu hình đã thay đổi.'},409);return true;}
        performance={...performance,settings:b.settings,revision:performance.revision+1,pending_streams:[1],budget:b.settings.mode==='quiet'?{encoder:'software',threads:2,width:1280,fps:10,ai_max_fps:1}:b.settings.mode==='full'?{encoder:'software',threads:0,width:0,fps:0,ai_max_fps:10}:{encoder:'software',threads:4,width:1920,fps:15,ai_max_fps:2}};
      }
      json(res,performance);return true;
    }
    if(pathname==='/api/system/performance/apply'){req.resume();performance.pending_streams=[];json(res,{ok:true,restarted:[1]});return true;}
    if(pathname==='/api/system/performance/probe'){req.resume();json(res,performance);return true;}
    if(pathname==='/api/system/recording-gaps'){json(res,{gaps:[],segments:3});return true;}
    json(res,{error:'Unknown preview operation'},404);return true;
  };
}
