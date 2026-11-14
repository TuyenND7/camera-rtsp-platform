const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),express=require('express');
const {pool}=require('../dist/db'),{signToken}=require('../dist/auth'),{tokenHash,csrfToken}=require('../dist/sessions'),{browserRequestGuard}=require('../dist/middleware/security'),{talkManager}=require('../dist/talk/manager'),routes=require('../dist/routes/talk').default;
let server,origin,query,probe,start,push,end,lastGains;
const admin=signToken({sub:1,username:'talk-admin',role:'admin'}),viewer=signToken({sub:2,username:'talk-viewer',role:'viewer'}),sessions=new Map([[tokenHash(admin),{id:1,username:'talk-admin',role:'admin'}],[tokenHash(viewer),{id:2,username:'talk-viewer',role:'viewer'}]]);
const camera={id:1,enabled:true,status:'online',rtsp_url:'rtsp://user:fixture-camera-password@127.0.0.1/stream'};let calls=0;
before(async()=>{
 query=pool.query;pool.query=async(sql,values)=>{
  if(sql.startsWith('SELECT u.id'))return{rows:sessions.has(values[0])?[sessions.get(values[0])]:[]};
  if(sql.startsWith('SELECT id, rtsp_url'))return{rows:values[0].includes(1)?[camera]:[]};
  throw Error('unexpected query');};
 probe=talkManager.probe;start=talkManager.start;push=talkManager.push;end=talkManager.end;
 talkManager.probe=async c=>({camera_id:c.id,supported:true,reason:'ready',codec:'PCMA'});
 talkManager.start=async(owner,rows,validate)=>{assert.equal(owner,tokenHash(admin));assert.equal(rows.length,1);assert.equal(await validate(),true);calls++;return{id:'fixture-call',camera_ids:[1],sample_rate:8000,max_seconds:60}};
 talkManager.push=(id,owner,sequence,pcm,gains)=>{assert.equal(id,'fixture-call');assert.equal(owner,tokenHash(admin));assert.equal(sequence,0);assert.ok(Buffer.isBuffer(pcm));if(gains!==undefined)require('../dist/talk/volume').talkGains(gains,[1]);lastGains=gains;calls++};
 talkManager.end=(id,owner)=>{assert.equal(id,'fixture-call');assert.equal(owner,tokenHash(admin));calls++};
 const app=express();app.set('trust proxy',1);app.use(browserRequestGuard,express.json({limit:'16kb'}));app.use('/api/talk',routes);app.use((err,_req,res,_next)=>res.status(err.status||500).json({error:'invalid payload'}));
 server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{pool.query=query;Object.assign(talkManager,{probe,start,push,end});talkManager.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
const request=(path,body={camera_ids:[1]},token=admin,extra={})=>fetch(origin+'/api/talk'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'CameraStation',...(token?{Authorization:'Bearer '+token}:{}),'X-Forwarded-Proto':'https',...extra},body:JSON.stringify(body)});
test('all talk actions require a current administrator session',async()=>{
 for(const path of ['/capabilities','/sessions','/sessions/fixture-call/audio']){assert.equal((await request(path,undefined,null)).status,401);assert.equal((await request(path,undefined,viewer)).status,403)}
 assert.equal((await fetch(origin+'/api/talk/sessions/fixture-call',{method:'DELETE',headers:{'X-Requested-With':'CameraStation'}})).status,401);
});
test('cross-origin and cookie requests without CSRF cannot open or send audio',async()=>{
 assert.equal((await request('/sessions',undefined,admin,{Origin:'https://other.example'})).status,403);
 const base={Cookie:'camera_session='+admin,'X-Requested-With':'CameraStation'};
 assert.equal((await request('/sessions',undefined,null,base)).status,403);
 const good=await request('/sessions',undefined,null,{...base,'X-CSRF-Token':csrfToken(admin)});assert.equal(good.status,201);
 assert.equal((await request('/sessions',undefined,null,{'X-Requested-With':'','X-CSRF-Token':csrfToken(admin),Cookie:'camera_session='+admin})).status,403);
});
test('HTTP mic sessions are rejected even for a valid administrator',async()=>{assert.equal((await request('/sessions',undefined,admin,{'X-Forwarded-Proto':'http'})).status,426)});
test('invalid camera lists never reach networking and capability results omit RTSP credentials',async()=>{
 for(const ids of [[],[0],[1,1],['1'],[2],Array.from({length:17},(_,i)=>i+1)])assert.ok([400,404].includes((await request('/capabilities',{camera_ids:ids})).status));
 const r=await request('/capabilities');assert.equal(r.status,200);const text=await r.text();assert.ok(!text.includes('fixture-camera-password')&&!text.includes('rtsp://'));
});
test('only bounded raw audio requests are accepted',async()=>{
 const headers={Authorization:'Bearer '+admin,'X-Forwarded-Proto':'https','Content-Type':'application/octet-stream','X-Audio-Sequence':'0'};
 assert.equal((await fetch(origin+'/api/talk/sessions/fixture-call/audio',{method:'POST',headers,body:Buffer.alloc(3200)})).status,204);
 assert.equal((await fetch(origin+'/api/talk/sessions/fixture-call/audio',{method:'POST',headers,body:Buffer.alloc(6401)})).status,413);
 assert.equal((await fetch(origin+'/api/talk/sessions/fixture-call/audio',{method:'POST',headers:{...headers,'X-Audio-Sequence':'-1'},body:Buffer.alloc(320)})).status,400);
 assert.equal((await fetch(origin+'/api/talk/sessions/fixture-call',{method:'DELETE',headers:{Authorization:'Bearer '+admin}})).status,204);assert.ok(calls>=3);
});
test('gain headers are parsed and invalid or unrelated camera gains are rejected',async()=>{
 const headers={Authorization:'Bearer '+admin,'X-Forwarded-Proto':'https','Content-Type':'application/octet-stream','X-Audio-Sequence':'0'};
 const send=value=>fetch(origin+'/api/talk/sessions/fixture-call/audio',{method:'POST',headers:{...headers,'X-Camera-Talk-Gains':value},body:Buffer.alloc(320)});
 assert.equal((await send('{"1":2}')).status,204);assert.deepEqual(lastGains,{'1':2});
 for(const value of ['broken','null','[]','{"2":2}','{"1":-1}','{"1":5}','{"1":"2"}',' '.repeat(1025)])assert.equal((await send(value)).status,400);
});
test('duplex listen requires HTTPS/current admin/ownership; duplicate streams rejected, cancel and revocation close the call',async()=>{
 const old=talkManager.readAudio;let reads=0,valid=true;talkManager.readAudio=(id,owner,cameraId)=>{if(owner!==tokenHash(admin)||id!=='fixture-call'||!valid)throw new (require('../dist/talk/rtsp').TalkError)(404,'ended');assert.equal(cameraId,1);reads++;return Buffer.alloc(320)};
 const url=origin+'/api/talk/sessions/fixture-call/listen/1',headers={Authorization:'Bearer '+admin,'X-Forwarded-Proto':'https'};
 try{
  assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{headers:{...headers,Authorization:'Bearer '+viewer}})).status,403);assert.equal((await fetch(url,{headers:{...headers,'X-Forwarded-Proto':'http'}})).status,426);
  const controller=new AbortController(),response=await fetch(url,{headers,signal:controller.signal});assert.equal(response.status,200);assert.equal(response.headers.get('x-audio-format'),'pcm_s16le');assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal((await response.body.getReader().read()).value.length,320);
  assert.equal((await fetch(url,{headers})).status,409);const prior=calls;controller.abort();await new Promise(r=>setTimeout(r,80));assert(calls>prior);
  const second=await fetch(url,{headers}),reader=second.body.getReader();await reader.read();valid=false;while(!(await reader.read()).done){}assert(reads>=3);
 }finally{talkManager.readAudio=old}
});
test('invalid duplex option is rejected before opening a camera',async()=>{assert.equal((await request('/sessions',{camera_ids:[1],duplex:'yes'})).status,400)});
