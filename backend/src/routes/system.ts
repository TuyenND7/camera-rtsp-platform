import { Router } from 'express';
import { pool } from '../db';
import { AuthedRequest, requireAdmin, requireAuth } from '../middleware/auth';
import { systemHealth } from '../system/health';
import { coverageGaps, readCoverage, previousDay, validRecordDay } from '../system/coverage';
import { encodingSignature, loadPerformance, performanceState, probeEncoders, savePerformance, validPerformance } from '../system/performance';
import { streamManager, CameraRow } from '../stream/manager';
import { talkManager } from '../talk/manager';
import { deviceControls } from '../controls/tenda';

const router=Router();router.use(requireAuth,requireAdmin);
function pending(){const signature=encodingSignature();return streamManager.health().filter(w=>w.transcoding&&w.budget_signature!==signature).map(w=>w.camera_id);}
router.get('/health',(_req,res)=>res.json({...systemHealth.snapshot(),server_time:Date.now()}));
router.post('/health/refresh',async(_req,res)=>{await systemHealth.scan();res.json({...systemHealth.snapshot(),server_time:Date.now()});});
router.get('/health/incidents',async(req,res)=>{
  const limit=Number(req.query.limit??100),id=req.query.camera_id===undefined?null:Number(req.query.camera_id);
  if(!Number.isInteger(limit)||limit<1||limit>200||(id!==null&&(!Number.isInteger(id)||id<1||id>2147483647))){res.sendStatus(400);return;}
  try{const {rows}=await pool.query(`SELECT i.id,i.camera_id,c.name AS camera_name,i.kind,i.message,i.opened_at,i.recovered_at FROM camera_health_incidents i JOIN cameras c ON c.id=i.camera_id WHERE ($1::int IS NULL OR i.camera_id=$1) ORDER BY i.opened_at DESC LIMIT $2`,[id,limit]);res.json(rows);}
  catch{res.status(503).json({error:'Chưa tải được lịch sử gián đoạn.'});}
});
router.get('/recording-gaps',async(req,res)=>{
  const id=Number(req.query.camera_id),day=req.query.day;
  if(!Number.isInteger(id)||id<1||id>2147483647||typeof day!=='string'||!validRecordDay(day)){res.sendStatus(400);return;}
  try{
    const {rows}=await pool.query('SELECT id FROM cameras WHERE id=$1',[id]);if(!rows[0]){res.sendStatus(404);return;}
    const [before,current]=await Promise.all([readCoverage(id,previousDay(day)),readCoverage(id,day)]);
    const selected=new Set(current.segments.map(s=>s.start_ms));
    const all=[...before.segments,...current.segments].sort((a,b)=>a.start_ms-b.start_ms);
    const gaps=coverageGaps(all).filter(g=>selected.has(Date.parse(g.end_at)));
    res.json({camera_id:id,day,gaps,segments:current.segments.length});
  }catch{res.status(503).json({error:'Chưa kiểm tra được các khoảng thiếu recording.'});}
});
router.get('/performance',async(_req,res)=>{
  try{await loadPerformance();res.json({...performanceState(),pending_streams:pending()});}
  catch{res.status(503).json({error:'Chưa đọc được chế độ vận hành.'});}
});
router.put('/performance',async(req:AuthedRequest,res)=>{
  const b=req.body??{};
  if(!validPerformance(b.settings)||!Number.isInteger(b.revision)||b.revision<0||Object.keys(b).some(k=>!['settings','revision'].includes(k))){res.status(400).json({error:'Cấu hình tài nguyên không hợp lệ.'});return;}
  try{res.json({...await savePerformance(b.settings,b.revision,req.user!.sub),pending_streams:pending()});}
  catch(err){
    const type=err instanceof Error?err.message:'';
    res.status(type==='revision_conflict'?409:type==='encoder_unavailable'?422:503).json({error:type==='revision_conflict'?'Cấu hình đã đổi ở thiết bị khác. Đọc lại trước khi sửa.':type==='encoder_unavailable'?'Bộ mã hóa phần cứng chưa sẵn sàng.':'Chưa áp dụng được cấu hình.'});
  }
});
let probingAt=0;
router.post('/performance/probe',async(_req,res)=>{
  if(Date.now()-probingAt<15000){res.status(429).json({error:'Chờ một lúc trước khi kiểm tra lại GPU.'});return;}
  probingAt=Date.now();try{await probeEncoders();res.json({...performanceState(),pending_streams:pending()});}catch{res.sendStatus(503);}
});
router.post('/performance/apply',async(req,res)=>{
  if(req.body?.confirm!==true||Object.keys(req.body).some(k=>k!=='confirm')){res.status(400).json({error:'Xác nhận kết nối lại các luồng cần cập nhật.'});return;}
  try{
    const ids=pending();const {rows}=await pool.query<CameraRow>('SELECT * FROM cameras WHERE id=ANY($1::int[]) AND enabled=true',[ids]);
    if(rows.some(c=>talkManager.isCameraBusy(c.id)||deviceControls.alarmActive(c))){res.status(409).json({error:'Có camera đang đàm thoại hoặc bật còi. Dừng thao tác đó trước.'});return;}
    for(const c of rows)await streamManager.restart(c.id,'performance_changed');
    res.json({ok:true,restarted:rows.map(c=>c.id)});
  }catch{res.status(503).json({error:'Chưa áp dụng được cho luồng đang chạy.'});}
});
export default router;
