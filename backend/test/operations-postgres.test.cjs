// Opt-in isolated PostgreSQL integration. No external push provider or camera.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),http=require('node:http');
const source=process.env.OPERATIONS_TEST_DATABASE_URL;
if(!source){test('operations PostgreSQL integration requires an explicit disposable local database',{skip:true},()=>{});}else{
 const schema='operations_'+crypto.randomBytes(6).toString('hex'),url=new URL(source);url.searchParams.set('options','-c search_path='+schema);
 process.env.DATABASE_URL=url.href;const root=fs.mkdtempSync(path.join(os.tmpdir(),'camera-operations-db-'));process.env.STORAGE_ROOT=root;
 const {Pool}=require('pg'),admin=new Pool({connectionString:source}),{pool}=require('../dist/db'),express=require('express');
 const routes=require('../dist/operations/routes').default,{createSession}=require('../dist/sessions');
 const {startOperatingProfiles}=require('../dist/operations/profiles'),{PushDeliveryService,sendPushTest}=require('../dist/operations/push'),{PushError}=require('../dist/operations/pushSecurity');
 let server,base,session,other,profiles;const ecdh=crypto.createECDH('prime256v1');ecdh.generateKeys();
 const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/local-integration-fixture',keys:{p256dh:ecdh.getPublicKey().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url')}};
 const headers=s=>({'Content-Type':'application/json','X-Forwarded-Proto':'https','X-Requested-With':'CameraStation','X-CSRF-Token':s.csrf,Cookie:'camera_session='+s.token});
 const request=(route,method='GET',body,s=session,extra={})=>fetch(base+route,{method,headers:{...(s?headers(s):{}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
 before(async()=>{
  await admin.query('CREATE SCHEMA '+schema);await pool.query(fs.readFileSync(path.join(__dirname,'../src/schema.sql'),'utf8'));await pool.query(fs.readFileSync(path.join(__dirname,'../src/operations/schema.sql'),'utf8'));
  await pool.query("INSERT INTO users(id,username,password,role) VALUES(1,'ops-admin','unused-fixture','admin'),(2,'ops-other','unused-fixture','viewer')");
  await pool.query("INSERT INTO cameras(id,name,rtsp_url,enabled,record) VALUES(1,'Fixture camera','rtsp://invalid.invalid/fixture',true,true)");
  session=await createSession({sub:1,username:'ops-admin',role:'admin'});other=await createSession({sub:2,username:'ops-other',role:'viewer'});profiles=await startOperatingProfiles();
  const app=express();app.set('trust proxy',1);app.use(express.json({limit:'16kb'}));app.use('/ops',routes);server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port+'/ops';
 });
 after(async()=>{profiles?.stop();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await pool.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();fs.rmSync(root,{recursive:true,force:true});});
 test('profile writes enforce auth, role, CSRF and revision while leaving recording untouched',async()=>{
  assert.equal((await request('/profiles','GET',undefined,null)).status,401);assert.equal((await request('/profiles','GET',undefined,other)).status,403);
  const snapshot=await(await request('/profiles')).json();assert.equal(snapshot.runtime.mode,'manual');
  snapshot.settings.manual_mode='away';snapshot.settings.profiles.away={notifications_enabled:false,cameras:{'1':{intrusion_enabled:true,popup_enabled:false}}};
  assert.equal((await request('/profiles','PUT',{revision:snapshot.revision,settings:snapshot.settings},session,{'X-CSRF-Token':'invalid'})).status,403);
  const saved=await(await request('/profiles','PUT',{revision:snapshot.revision,settings:snapshot.settings})).json();assert.equal(saved.runtime.mode,'away');assert.equal(saved.runtime.notifications_enabled,false);assert.equal(saved.runtime.camera_overrides['1'].intrusion_enabled,true);
  assert.equal((await request('/profiles','PUT',{revision:snapshot.revision,settings:snapshot.settings})).status,409);
  const camera=await pool.query('SELECT enabled,record FROM cameras WHERE id=1');assert.deepEqual(camera.rows[0],{enabled:true,record:true});
  assert.equal((await request('/profiles/mode','POST',{mode:'manual'})).status,200);
 });
 test('push ownership, durable cursors, dedupe, session expiry and provider cleanup work in PostgreSQL',async()=>{
  const invalid=await request('/push/subscriptions','POST',{subscription:{...subscription,endpoint:'https://127.0.0.1/private'},name:'Fixture'});assert.equal(invalid.status,400);
  const subscribed=await request('/push/subscriptions','POST',{subscription,name:'Fixture'});assert.equal(subscribed.status,201);const initial=await subscribed.json();assert.equal(initial.devices.length,1);assert(!JSON.stringify(initial).includes('privateKey'));assert(!JSON.stringify(initial).includes(subscription.endpoint));const device=initial.devices[0];
  assert.equal((await request('/push','GET',undefined,session,{'X-Forwarded-Proto':'http'})).status,400);
  await request('/push/preferences','PUT',{enabled:false});await request('/push/preferences','PUT',{timezone:'UTC'});
  const prefs=await(await request('/push')).json();assert.equal(prefs.preferences.enabled,false);assert.equal(prefs.preferences.timezone,'UTC');
  assert.equal((await request('/push/preferences','PUT',{quiet_start:'07:00'})).status,400);
  await request('/push/preferences','PUT',{enabled:true,quiet_enabled:false});await request('/push/snooze','POST',{minutes:15});
  let testsSent=0;await assert.rejects(()=>sendPushTest(1,require('../dist/sessions').tokenHash(session.token),device.id,async()=>testsSent++),e=>e instanceof PushError&&e.status===409);assert.equal(testsSent,0);await request('/push/snooze','POST',{minutes:0});
  assert.equal((await request('/push/subscriptions','POST',{subscription,name:'Other'},other)).status,409);
  assert.equal((await request('/push/active/'+device.id,'GET',undefined,other)).status,404);
  await request('/push/devices/'+device.id,'DELETE',undefined,other);assert.equal((await pool.query('SELECT count(*)::int AS n FROM push_subscriptions')).rows[0].n,1);
  const sent=[];const service=new PushDeliveryService(async(_s,payload)=>sent.push(payload),()=>true);
  for(let n=0;n<2;n++)await pool.query("INSERT INTO surveillance_notifications(camera_id,kind,zone_id,track_id,track_number,label,detected_at) VALUES(1,'intrusion','whole',$1,$2,'person',now())",['fixture-'+n,n+1]);
  await service.tick();assert.equal(sent.length,2);await new PushDeliveryService(async(_s,payload)=>sent.push(payload),()=>true).tick();assert.equal(sent.length,2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM push_deliveries WHERE state='sent'")).rows[0].n,2);
  await sendPushTest(1,require('../dist/sessions').tokenHash(session.token),device.id,async()=>{});
  const notice=await pool.query("INSERT INTO surveillance_notifications(camera_id,kind,zone_id,track_id,track_number,label,detected_at) VALUES(1,'intrusion','whole','expired-fixture',4,'person',now()) RETURNING id");
  const pending=await pool.query("INSERT INTO push_deliveries(subscription_id,notification_id,state) VALUES($1,$2,'sending') RETURNING id",[device.id,notice.rows[0].id]);
  await pool.query('UPDATE auth_sessions SET expires_at=now()-interval \'1 second\' WHERE user_id=1');await service.deliver(pending.rows[0].id,1);assert.equal(sent.length,2);
  assert.equal((await request('/push')).status,401);assert.equal((await pool.query('SELECT state FROM push_deliveries WHERE id=$1',[pending.rows[0].id])).rows[0].state,'skipped');
  session=await createSession({sub:1,username:'ops-admin',role:'admin'});const again=await(await request('/push/subscriptions','POST',{subscription:{...subscription,endpoint:subscription.endpoint+'-new'},name:'New login'})).json();
  await pool.query("INSERT INTO surveillance_notifications(camera_id,kind,zone_id,track_id,track_number,label,detected_at) VALUES(1,'intrusion','whole','gone-provider',5,'person',now())");
  await new PushDeliveryService(async()=>{throw new PushError('gone',410,'provider_410');},()=>true).tick();assert.equal((await pool.query('SELECT count(*)::int AS n FROM push_subscriptions WHERE id=$1',[again.devices[0].id])).rows[0].n,0);
 });
 test('outbox catches a lower notification ID committed after the high-water cursor advanced',async()=>{
  const registered=await(await request('/push/subscriptions','POST',{subscription:{...subscription,endpoint:subscription.endpoint+'-late'},name:'Late commit fixture'})).json();
  const device=registered.devices[0],held=await pool.connect(),sent=[];let committed=false;
  const insert=`INSERT INTO surveillance_notifications(camera_id,kind,zone_id,track_id,track_number,label,detected_at) VALUES(1,'intrusion','whole',$1,9,'person',now()) RETURNING id`;
  try{
   await held.query('BEGIN');const lower=await held.query(insert,['late-low-'+crypto.randomUUID()]);
   const higher=await pool.query(insert,['late-high-'+crypto.randomUUID()]);
   const service=new PushDeliveryService(async(_s,payload)=>sent.push(payload),()=>true);await service.tick();
   assert.equal(sent.length,1);assert.equal(sent[0].tag,'camera-notice-'+higher.rows[0].id);
   await held.query('COMMIT');committed=true;await service.tick();
   assert.equal(sent.length,2);assert(sent.some(p=>p.tag==='camera-notice-'+lower.rows[0].id));
   assert.equal((await pool.query('SELECT cursor_id FROM push_subscriptions WHERE id=$1',[device.id])).rows[0].cursor_id,String(higher.rows[0].id));
   await new PushDeliveryService(async(_s,payload)=>sent.push(payload),()=>true).tick();assert.equal(sent.length,2);
  }finally{if(!committed)await held.query('ROLLBACK');held.release();}
 });
}
