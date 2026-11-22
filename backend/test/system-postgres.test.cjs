const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),{randomBytes}=require('node:crypto');
const envFile=process.env.SYSTEM_TEST_DATABASE_ENV;
test('system migrations, recording gaps, incident recovery, performance persistence and auth work with PostgreSQL',{skip:!envFile},async()=>{
 const data=Object.fromEntries(fs.readFileSync(envFile,'utf8').trim().split('\n').map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));
 const {Pool}=require('pg'),url=new URL('postgresql://127.0.0.1:55432/'+data.POSTGRES_DB);url.username=data.POSTGRES_USER;url.password=data.POSTGRES_PASSWORD;
 const admin=new Pool({connectionString:url.href}),schema='system_'+randomBytes(6).toString('hex');url.searchParams.set('options','-c search_path='+schema);
 process.env.DATABASE_URL=url.href;const root=fs.mkdtempSync(path.join(os.tmpdir(),'camera-system-db-'));process.env.STORAGE_ROOT=root;
 const {pool,initDb}=require('../dist/db'),{HealthMonitor}=require('../dist/system/health'),{recordDay}=require('../dist/system/coverage'),{createSession}=require('../dist/sessions');
 const {loadPerformance,performanceState}=require('../dist/system/performance');
 const {startOperatingProfiles}=require('../dist/operations/profiles');
 let monitor,profiles,server;const realNow=Date.now;
 try{
  await admin.query('CREATE SCHEMA '+schema);await initDb();await initDb();profiles=await startOperatingProfiles();await loadPerformance();
  const user=(await pool.query("SELECT id FROM users WHERE role='admin' LIMIT 1")).rows[0];
  const viewer=(await pool.query("INSERT INTO users(username,password,role) VALUES('fixture-viewer','unused','viewer') RETURNING id")).rows[0];
  const token=(await createSession({sub:user.id,username:'fixture',role:'admin'})).token,viewerToken=(await createSession({sub:viewer.id,username:'fixture-viewer',role:'viewer'})).token;
  const cam=(await pool.query("INSERT INTO cameras(name,rtsp_url,enabled,record,status) VALUES('Fixture','rtsp://fixture-secret',true,true,'online') RETURNING id")).rows[0];
  const now=realNow(),day=recordDay(now),dir=path.join(root,'rec',String(cam.id),day),live=path.join(root,'live',String(cam.id),'index.m3u8');fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(path.dirname(live),{recursive:true});fs.writeFileSync(live,'#EXTM3U\n');
  const name=at=>'rec_'+new Date(at).toISOString().slice(0,19).replaceAll('-','').replace('T','_').replaceAll(':','')+'.ts';
  fs.writeFileSync(path.join(dir,'index.m3u8'),`#EXTM3U\n#EXTINF:40,\n${name(now-150000)}\n#EXTINF:40,\n${name(now-50000)}\n`);
  monitor=new HealthMonitor(0);const service=await monitor.start();
  assert.equal(monitor.snapshot().cameras[0].video,'ready');assert.equal(monitor.snapshot().cameras[0].recording,'recording');
  assert.equal((await pool.query('SELECT count(*) FROM recording_gaps')).rows[0].count,'1');
  await pool.query("UPDATE cameras SET status='error' WHERE id=$1",[cam.id]);await monitor.scan();
  Date.now=()=>now+31000;await monitor.scan();
  assert.equal((await pool.query("SELECT count(*) FROM surveillance_notifications WHERE kind='camera_offline'")).rows[0].count,'0');
  Date.now=()=>now+47000;await monitor.scan();
  assert.equal((await pool.query("SELECT count(*) FROM surveillance_notifications WHERE kind='camera_offline'")).rows[0].count,'1');
  Date.now=()=>now+48000;await monitor.scan();assert.equal((await pool.query("SELECT count(*) FROM surveillance_notifications WHERE kind='camera_offline'")).rows[0].count,'1');
  await pool.query("UPDATE cameras SET status='online' WHERE id=$1",[cam.id]);fs.utimesSync(live,new Date(now+49000),new Date(now+49000));Date.now=()=>now+49000;await monitor.scan();
  assert.equal((await pool.query('SELECT count(*) FROM camera_health_incidents WHERE recovered_at IS NULL')).rows[0].count,'0');
  service.stop();Date.now=realNow;
  // A newly enabled camera needs enough time to complete its first recording
  // segment; repeated connection retries must not extend that grace forever.
  const fresh=(await pool.query("INSERT INTO cameras(name,rtsp_url,enabled,record,status) VALUES('New camera','rtsp://fixture-new',true,true,'online') RETURNING id")).rows[0];
  monitor=new HealthMonitor(0);const freshService=await monitor.start();
  assert.equal(monitor.snapshot().cameras.find(c=>c.id===fresh.id).recording,'waiting');
  Date.now=()=>now+61000;await monitor.scan();
  assert.equal(monitor.snapshot().cameras.find(c=>c.id===fresh.id).recording,'waiting');
  assert.equal((await pool.query("SELECT count(*) FROM surveillance_notifications WHERE kind='recording_stopped' AND camera_id=$1",[fresh.id])).rows[0].count,'0');
  Date.now=()=>now+151000;await monitor.scan();
  assert.equal(monitor.snapshot().cameras.find(c=>c.id===fresh.id).recording,'stalled');
  Date.now=()=>now+167000;await monitor.scan();
  assert.equal((await pool.query("SELECT count(*) FROM surveillance_notifications WHERE kind='recording_stopped' AND camera_id=$1",[fresh.id])).rows[0].count,'1');
  freshService.stop();Date.now=realNow;
  const express=require('express'),app=express();app.use(express.json());app.use('/system',require('../dist/routes/system').default);server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port,headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
  for(const p of ['/health','/performance','/recording-gaps?camera_id='+cam.id+'&day='+day]){
    assert.equal((await fetch(base+'/system'+p)).status,401);
    assert.equal((await fetch(base+'/system'+p,{headers:{Authorization:'Bearer '+viewerToken}})).status,403);
  }
  const before=(await pool.query('SELECT enabled,record,codec,rtsp_url FROM cameras WHERE id=$1',[cam.id])).rows[0];
  const p=performanceState(),quiet={...p.settings,mode:'quiet',adaptive_ai:true};
  const save=await fetch(base+'/system/performance',{method:'PUT',headers,body:JSON.stringify({settings:quiet,revision:p.revision})});assert.equal(save.status,200);const saved=await save.json();assert.equal(saved.budget.ai_max_fps,1);
  const runtime=(await pool.query('SELECT value FROM system_runtime WHERE id=1')).rows[0].value;assert.equal(runtime.width,1280);assert.equal(runtime.adaptive_ai,true);
  const after=(await pool.query('SELECT enabled,record,codec,rtsp_url FROM cameras WHERE id=$1',[cam.id])).rows[0];assert.deepEqual(after,before);
  assert.equal((await fetch(base+'/system/performance',{method:'PUT',headers,body:JSON.stringify({settings:quiet,revision:p.revision})})).status,409);
  assert.equal((await fetch(base+'/system/performance',{method:'PUT',headers,body:JSON.stringify({settings:{...quiet,encoder:'nvenc'},revision:saved.revision})})).status,422);
  assert.equal((await fetch(base+'/system/performance/apply',{method:'POST',headers,body:'{"confirm":false}'})).status,400);
  const gaps=await fetch(base+`/system/recording-gaps?camera_id=${cam.id}&day=${day}`,{headers});assert.equal(gaps.status,200);assert.equal((await gaps.json()).gaps.length,1);
  assert.equal((await fetch(base+`/system/recording-gaps?camera_id=${cam.id}&day=20260231`,{headers})).status,400);
  assert(!JSON.stringify(monitor.snapshot()).includes('fixture-secret'));
 }finally{
  Date.now=realNow;monitor?.timer&&clearInterval(monitor.timer);profiles?.stop();
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  await pool.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();fs.rmSync(root,{recursive:true,force:true});
 }
});
