import type { IncomingMessage,ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Camera } from '../src/api';
import type { EvidenceClip,EvidenceReview,ActivityGroup } from '../src/evidenceApi';

/** Local UI fixtures only: no filesystem exports, database, hardware or network calls. */
export function evidencePreview(cameras:()=>Camera[]){
  const jobs=new Map<string,EvidenceClip>(),reviews=new Map<string,EvidenceReview>();
  const first=cameras()[0],now=Date.now();
  const initial:EvidenceClip={id:randomUUID(),kind:'protected',camera_id:first?.id??1,camera_name:first?.name??'Camera mẫu',title:'Clip UI mẫu',start_at:new Date(now-90_000).toISOString(),end_at:new Date(now-60_000).toISOString(),status:'ready',progress:100,duration_seconds:28,size_bytes:2_500_000,gaps:[{start_at:new Date(now-80_000).toISOString(),end_at:new Date(now-78_000).toISOString(),seconds:2}],error:null,event_id:'1',notice_id:null,created_at:new Date(now).toISOString(),expires_at:null,download_url:'/__ui-preview__/sample.mp4'};jobs.set(initial.id,initial);
  const send=(res:ServerResponse,value:unknown,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(value));};
  const body=async(req:IncomingMessage)=>{let value='';for await(const chunk of req){value+=chunk;if(Buffer.byteLength(value)>16*1024)throw Error('body');}return value?JSON.parse(value):{};};
  const refresh=(job:EvidenceClip)=>{if(['preparing','queued','processing'].includes(job.status)&&Date.now()-Date.parse(job.created_at)>1000){job.status='ready';job.progress=100;job.size_bytes=2_500_000;job.duration_seconds=(Date.parse(job.end_at)-Date.parse(job.start_at))/1000;job.download_url='/__ui-preview__/sample.mp4';}return job;};
  return async(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean>=>{
    if(!url.pathname.startsWith('/api/evidence/'))return false;
    const route=url.pathname.slice('/api/evidence'.length),method=req.method??'GET';
    try{
      if(route==='/clips'&&method==='GET'){send(res,{items:[...jobs.values()].filter(job=>job.kind==='protected').map(refresh),quota:{used_bytes:2_500_000,reserved_bytes:0,max_bytes:10*1024**3,free_bytes:100*1024**3,min_free_bytes:512*1024**2},next_before:null});return true;}
      if((route==='/clips'||route==='/preview')&&method==='POST'){
        const data=await body(req),cam=cameras().find(camera=>camera.id===data.camera_id)??first,at=Date.now()-60_000;
        const job:EvidenceClip={...initial,id:randomUUID(),kind:route==='/preview'?'preview':'protected',camera_id:cam.id,camera_name:cam.name,title:data.title??'',start_at:data.start_at??new Date(at-4000).toISOString(),end_at:data.end_at??new Date(at+4000).toISOString(),status:'preparing',progress:0,gaps:[],size_bytes:0,duration_seconds:null,created_at:new Date().toISOString(),expires_at:route==='/preview'?new Date(Date.now()+300_000).toISOString():null,download_url:null};jobs.set(job.id,job);send(res,job,202);return true;
      }
      const clip=/^\/clips\/([^/]+)(?:\/(cancel))?$/.exec(route);
      if(clip){const job=jobs.get(clip[1]);if(!job){send(res,{error:'Không tìm thấy clip mẫu.'},404);return true;}if(method==='DELETE'){const data=await body(req);if(data.confirm!==true){send(res,{error:'Xác nhận xóa clip.'},400);return true;}jobs.delete(job.id);send(res,{ok:true});return true;}if(clip[2]==='cancel'&&method==='POST'){job.status='cancelled';job.error='Đã hủy tạo clip.';send(res,{ok:true});return true;}send(res,refresh(job));return true;}
      if(route==='/reviews'&&method==='GET'){const type=url.searchParams.get('target_type'),ids=(url.searchParams.get('ids')??'').split(',');send(res,ids.flatMap(id=>reviews.has(`${type}:${id}`)?[reviews.get(`${type}:${id}`)]:[]));return true;}
      const review=/^\/reviews\/(event|notice)\/([0-9]+)$/.exec(route);
      if(review&&method==='PUT'){const data=await body(req);if(!['unreviewed','reviewed','important','false_positive'].includes(data.status)||typeof data.note!=='string'||data.note.length>500){send(res,{error:'Đánh giá mẫu không hợp lệ.'},400);return true;}const value:EvidenceReview={target_type:review[1] as 'event'|'notice',target_id:review[2],status:data.status,note:data.note,updated_at:new Date().toISOString(),updated_by:'UI Demo'};reviews.set(`${review[1]}:${review[2]}`,value);send(res,value);return true;}
      if(route==='/activities'){
        const groups:ActivityGroup[]=cameras().filter(camera=>camera.ai_enabled&&(!url.searchParams.get('camera_id')||camera.id===Number(url.searchParams.get('camera_id')))).map(camera=>({id:`${camera.id}:sample`,camera_id:camera.id,camera_name:camera.name,from:new Date(now-75_000).toISOString(),to:new Date(now-60_000).toISOString(),objects:[],items:[1,2].map((id)=>({target_type:'event',target_id:String(id),detected_at:new Date(now-(id===1?75_000:60_000)).toISOString(),label:'person',kind:null,track_id:`c${camera.id}-abcdef123456-${id}`,track_number:id,thumbnail_url:'/__ui-preview__/scene.svg'}))}));for(const group of groups)group.objects=group.items;send(res,{items:groups,window_seconds:Number(url.searchParams.get('window_seconds')??60),truncated:false});return true;
      }
      send(res,{error:'Thao tác mẫu không hỗ trợ.'},404);return true;
    }catch{send(res,{error:'Dữ liệu mẫu không hợp lệ.'},400);return true;}
  };
}
