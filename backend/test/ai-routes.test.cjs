const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),express=require('express');
const {pool}=require('../dist/db'),{signToken}=require('../dist/auth'),{streamManager}=require('../dist/stream/manager'),events=require('../dist/routes/events').default,cameras=require('../dist/routes/cameras').default;
let server,base,query,restart,calls=0,updates=[];
const token=signToken({sub:1,username:'fixture',role:'admin'});
before(async()=>{query=pool.query;restart=streamManager.restart;streamManager.restart=async()=>{calls++};pool.query=async(sql,params)=>{if(sql.startsWith('SELECT u.id'))return{rows:[{id:1,username:'fixture',role:'admin'}]};if(sql.startsWith('SELECT id, status, enabled'))return{rows:[{id:3,status:'online',enabled:true,ai_enabled:true,ai_fps:2}]};if(sql.startsWith('UPDATE cameras SET')){updates.push(params);return{rows:[{id:3,status:'online',enabled:true,ai_enabled:true,ai_fps:2,rtsp_url:'rtsp://fixture',ai_overlay_enabled:params[12]??true,ai_overlay_labels:params[13]??['person','cat','dog']}]}};throw Error('Unexpected query')};const app=express();app.use(express.json());app.use('/events',events);app.use('/cameras',cameras);server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port});
after(async()=>{pool.query=query;streamManager.restart=restart;server.closeAllConnections();await new Promise(r=>server.close(r))});
test('live AI metadata requires session and bounded numeric camera IDs',async()=>{assert.equal((await fetch(base+'/events/live?camera_ids=3')).status,401);for(const ids of ['0','3,3','../3','1'.repeat(30),Array.from({length:17},(_,i)=>i+1).join(',')])assert.equal((await fetch(base+'/events/live?camera_ids='+ids,{headers:{Authorization:'Bearer '+token}})).status,400);const r=await fetch(base+'/events/live?camera_ids=3',{headers:{Authorization:'Bearer '+token}});assert.equal(r.status,200);assert.equal((await r.json())[0].camera_id,3)});
test('event thumbnails require a session and a valid numeric event ID',async()=>{
 assert.equal((await fetch(base+'/events/1/thumbnail')).status,401);
 for(const id of ['0','-1','abc','999999999999999999999'])assert.equal((await fetch(base+'/events/'+id+'/thumbnail',{headers:{Authorization:'Bearer '+token}})).status,400);
});
test('changing AI settings does not restart Live or close its camera transport',async()=>{const r=await fetch(base+'/cameras/3',{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({ai_enabled:true,ai_fps:2,ai_labels:['person'],ai_rtsp_url:''})});assert.equal(r.status,200);assert.equal(calls,0)});
test('display-only settings persist off/empty choices without changing AI or restarting video',async()=>{
 for(const patch of [{ai_overlay_enabled:false},{ai_overlay_enabled:true,ai_overlay_labels:['cat']},{ai_overlay_labels:[]}]){
  const response=await fetch(base+'/cameras/3',{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(patch)});
  assert.equal(response.status,200);const camera=await response.json();
  for(const [key,value] of Object.entries(patch))assert.deepEqual(camera[key],value);
  assert.equal(camera.ai_enabled,true);assert.equal(calls,0);
  const params=updates.at(-1);assert.deepEqual(params.slice(5,10),[null,null,null,null,null]);
 }
});
test('invalid overlay settings are rejected before any camera update',async()=>{
 const count=updates.length;
 for(const patch of [{ai_overlay_enabled:'false'},{ai_overlay_enabled:null},{ai_overlay_labels:['cat','cat']},{ai_overlay_labels:['unknown']},{ai_overlay_labels:null}]){
  const response=await fetch(base+'/cameras/3',{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(patch)});
  assert.equal(response.status,400);
 }
 assert.equal(updates.length,count);
});
