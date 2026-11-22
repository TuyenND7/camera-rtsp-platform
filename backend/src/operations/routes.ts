import { Router } from 'express';
import type { PoolClient } from 'pg';
import { pool } from '../db';
import { requireAuth, requireAdmin, AuthedRequest } from '../middleware/auth';
import { browserRequestGuard, loginLimiter } from '../middleware/security';
import { tokenHash } from '../sessions';
import { operatingProfilesSnapshot, profileModes, ProfileError, saveOperatingProfiles, selectOperatingMode, validateProfileSettings } from './profiles';
import { pushSnapshot, registerPush, sendPushTest } from './push';
import { PushError, validatePushPreferences } from './pushSecurity';

const router = Router();
router.use(browserRequestGuard, requireAuth);
const fail = (res: any, error: unknown, message: string) => res.status(error instanceof PushError || error instanceof ProfileError ? error.status : 503).json({ error: error instanceof PushError || error instanceof ProfileError ? error.message : message });
const uuid = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

router.get('/profiles', requireAdmin, async (_req, res) => {
  try { res.json(await operatingProfilesSnapshot()); } catch (err) { fail(res, err, 'Chưa đọc được chế độ vận hành.'); }
});
router.put('/profiles', requireAdmin, async (req: AuthedRequest, res) => {
  const body = req.body ?? {};
  if (Object.keys(body).some(k => !['revision','settings'].includes(k)) || !Number.isInteger(body.revision) || body.revision < 1) { res.status(400).json({ error: 'Phiên bản cấu hình không hợp lệ.' }); return; }
  try { res.json(await saveOperatingProfiles(validateProfileSettings(body.settings), body.revision, req.user!.sub)); }
  catch (err) { fail(res, err, 'Chưa lưu được chế độ vận hành.'); }
});
router.post('/profiles/mode', requireAdmin, async (req: AuthedRequest, res) => {
  const body=req.body??{};
  if (Object.keys(body).some(k=>!['mode','control'].includes(k)) || !profileModes.includes(body.mode) || (body.control!==undefined && body.control!=='manual')) { res.status(400).json({error:'Chế độ không hợp lệ.'}); return; }
  try { res.json(await selectOperatingMode(body.mode,req.user!.sub)); } catch(err) { fail(res,err,'Chưa chuyển được chế độ.'); }
});

router.use('/push', (req, res, next) => { if (!req.secure) { res.status(400).json({ error: 'Mở trang bằng HTTPS để đăng ký thông báo đẩy.' }); return; } next(); });
router.get('/push', async (req: AuthedRequest, res) => {
  try { res.json(await pushSnapshot(req.user!.sub, tokenHash(req.sessionToken!))); } catch (err) { fail(res, err, 'Chưa đọc được cài đặt thông báo đẩy.'); }
});
router.get('/push/active/:id',async(req:AuthedRequest,res)=>{
  if(!uuid(req.params.id)){res.sendStatus(400);return;}
  try{
    const {rows}=await pool.query(`SELECT p.id FROM push_subscriptions p JOIN auth_sessions s ON s.token_hash=p.session_hash
      WHERE p.id=$1 AND p.user_id=$2 AND p.session_hash=$3 AND s.expires_at>now()`,[req.params.id,req.user!.sub,tokenHash(req.sessionToken!)]);
    res.sendStatus(rows[0]?204:404);
  }catch{res.sendStatus(503);}
});
router.post('/push/subscriptions', async (req: AuthedRequest, res) => {
  const b=req.body??{};
  if (Object.keys(b).some(k=>!['subscription','name'].includes(k)) || typeof b.name!=='string' || !b.name.trim() || b.name.length>60 || /[\x00-\x1f\x7f]/.test(b.name)) { res.status(400).json({error:'Tên thiết bị không hợp lệ.'}); return; }
  try { res.status(201).json(await registerPush(req.user!.sub,tokenHash(req.sessionToken!),b.subscription,b.name.trim())); }
  catch(err) { fail(res,err,'Chưa đăng ký được thiết bị nhận thông báo.'); }
});
router.delete('/push/devices/:id', async (req: AuthedRequest,res)=>{
  if(!uuid(req.params.id)){res.sendStatus(400);return;}
  try { await pool.query('DELETE FROM push_subscriptions WHERE id=$1 AND user_id=$2',[req.params.id,req.user!.sub]);res.json({ok:true}); }
  catch(err){fail(res,err,'Chưa xóa được thiết bị.');}
});
router.put('/push/preferences',async(req:AuthedRequest,res)=>{
  const patch=req.body??{},allowed=['enabled','timezone','quiet_enabled','quiet_start','quiet_end'];
  if(!Object.keys(patch).length||Object.keys(patch).some(k=>!allowed.includes(k))){res.status(400).json({error:'Cài đặt thông báo không hợp lệ.'});return;}
  let client:PoolClient|undefined;
  try {
    client=await pool.connect();
    await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(731924,$1)',[req.user!.sub]);
    const {rows}=await client.query('SELECT * FROM push_preferences WHERE user_id=$1',[req.user!.sub]);
    const old=rows[0]??{enabled:true,timezone:'Asia/Ho_Chi_Minh',quiet_enabled:false,quiet_start:'22:00',quiet_end:'07:00'};
    const value=validatePushPreferences(Object.fromEntries(allowed.map(k=>[k,Object.prototype.hasOwnProperty.call(patch,k)?patch[k]:old[k]])));
    await client.query(`INSERT INTO push_preferences(user_id,enabled,timezone,quiet_enabled,quiet_start,quiet_end)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id) DO UPDATE SET enabled=EXCLUDED.enabled,timezone=EXCLUDED.timezone,
      quiet_enabled=EXCLUDED.quiet_enabled,quiet_start=EXCLUDED.quiet_start,quiet_end=EXCLUDED.quiet_end,updated_at=now()`,
      [req.user!.sub,value.enabled,value.timezone,value.quiet_enabled,value.quiet_start,value.quiet_end]);
    await client.query('COMMIT');
    res.json(await pushSnapshot(req.user!.sub,tokenHash(req.sessionToken!)));
  } catch(err){if(client)await client.query('ROLLBACK').catch(()=>undefined);fail(res,err,'Chưa lưu được cài đặt thông báo.');}
  finally{client?.release();}
});
router.post('/push/snooze',async(req:AuthedRequest,res)=>{
  const body=req.body??{};
  if(Object.keys(body).some(k=>k!=='minutes') || ![0,15,60,480].includes(body.minutes)){res.status(400).json({error:'Chọn 15 phút, 1 giờ, 8 giờ hoặc tiếp tục nhận.'});return;}
  try{
    await pool.query(`INSERT INTO push_preferences(user_id,snooze_until) VALUES($1,CASE WHEN $2::int=0 THEN NULL ELSE now()+($2::int*interval '1 minute') END)
      ON CONFLICT(user_id) DO UPDATE SET snooze_until=EXCLUDED.snooze_until,updated_at=now()`,[req.user!.sub,body.minutes]);
    res.json(await pushSnapshot(req.user!.sub,tokenHash(req.sessionToken!)));
  }catch(err){fail(res,err,'Chưa tạm hoãn được thông báo.');}
});
router.post('/push/test',loginLimiter(3,60000),async(req:AuthedRequest,res)=>{
  const body=req.body??{};
  if(Object.keys(body).some(k=>k!=='device_id') || typeof body.device_id!=='string' || !uuid(body.device_id)){res.sendStatus(400);return;}
  try{await sendPushTest(req.user!.sub,tokenHash(req.sessionToken!),body.device_id);res.json({accepted:true});}
  catch(err){fail(res,err,'Chưa gửi được thông báo thử.');}
});
export default router;
