const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'camera-lifecycle-'));process.env.STORAGE_ROOT=root;
const ffmpeg=require('../dist/stream/ffmpeg'),discovery=require('../dist/discovery'),{pool}=require('../dist/db'),{StreamManager}=require('../dist/stream/manager'),{flushStreamDiagnostics}=require('../dist/stream/diagnostics');
const performance=require('../dist/system/performance'),{isHardwareEncoderError}=require('../dist/stream/encoding');
const originals={start:ffmpeg.startFfmpeg,query:pool.query,remember:discovery.rememberSerial};
const cam={id:99,name:'Fixture',enabled:true,record:true,codec:'h264',status:'stopped',rtsp_url:'rtsp://127.0.0.1:9/fixture'};
let callbacks=[],spawns=0,kills=0;
before(()=>{pool.query=async()=>({rows:[cam]});discovery.rememberSerial=async()=>undefined;ffmpeg.startFfmpeg=async(...args)=>{spawns++;callbacks.push(args);return {proc:{kill:()=>{kills++;}},liveCodec:'h264',paths:{},hasAudio:false};};});
after(async()=>{ffmpeg.startFfmpeg=originals.start;pool.query=originals.query;discovery.rememberSerial=originals.remember;await flushStreamDiagnostics();fs.rmSync(root,{recursive:true,force:true});});
test('frame zero never marks a camera online; sustained recovery resets accumulated reconnect delay',async()=>{
 const manager=new StreamManager(),realNow=Date.now;let now=realNow();Date.now=()=>now;
 try{
  manager.spawn(cam,30000);await new Promise(r=>setImmediate(r));const log=callbacks.at(-1)[4];
  log('frame=0','progress');assert.equal(manager.health()[0].online,false);assert.equal(manager.health()[0].backoff_ms,30000);
  log('frame=1','progress');assert.equal(manager.health()[0].online,true);now+=10000;log('frame=10','progress');assert.equal(manager.health()[0].backoff_ms,30000);
  now+=21000;log('frame=30','progress');assert.equal(manager.health()[0].backoff_ms,1000);
 }finally{Date.now=realNow;manager.stopAll();}
});
test('stopping after an asynchronous restart cancels its pending start',async()=>{
 const manager=new StreamManager();const before=spawns;
 await manager.restart(cam.id);manager.stop(cam.id);await new Promise(r=>setTimeout(r,1600));
 assert.equal(spawns,before);assert.deepEqual(manager.health(),[]);manager.stopAll();
});
test('stop during probe kills a late process and cannot revive the stopped camera',async()=>{
 const manager=new StreamManager(),old=ffmpeg.startFfmpeg;let resolve;
 ffmpeg.startFfmpeg=()=>new Promise(r=>resolve=r);
 try{
  manager.start(cam);manager.stop(cam.id);let killed=false;resolve({proc:{kill:()=>{killed=true;}},paths:{},liveCodec:'h264',hasAudio:false});
  await new Promise(r=>setImmediate(r));assert.equal(killed,true);assert.deepEqual(manager.health(),[]);
 }finally{ffmpeg.startFfmpeg=old;manager.stopAll();}
});
test('a completed rediscovery cannot revive a camera stopped while the scan was running',async()=>{
 const manager=new StreamManager(),old=discovery.rediscoverCamera;let resolve;
 discovery.rediscoverCamera=()=>new Promise(r=>resolve=r);
 try{
  manager.start(cam);await new Promise(r=>setImmediate(r));manager.failures.set(cam.id,2);
  callbacks.at(-1)[5](1);assert.equal(typeof resolve,'function');manager.stop(cam.id);
  const count=spawns;resolve({from:'127.0.0.1',to:'127.0.0.2'});
  await new Promise(r=>setImmediate(r));assert.equal(manager.pendingStarts.size,0);
  assert.deepEqual(manager.health(),[]);assert.equal(spawns,count);
 }finally{discovery.rediscoverCamera=old;manager.stopAll();}
});
test('only a confirmed hardware transcode error disables GPU, not RTSP or recording failures',async()=>{
 const old=performance.encoderFailed,failed=[];performance.encoderFailed=encoder=>failed.push(encoder);
 try{
  for(const [codec,line] of [
   ['h264','[h264_nvenc @ 0x1] Cannot load libcuda.so.1'],
   ['h265','[rtsp @ 0x1] Connection refused'],
   ['h265','[hls @ 0x1] Failed to open recording: No space left on device'],
   ['h265','[h264_nvenc @ 0x1] Cannot load libcuda.so.1'],
  ]){
   const manager=new StreamManager();manager.start(cam);await new Promise(r=>setImmediate(r));
   const cb=callbacks.at(-1);cb[7]('process_spawned',{encoder:'nvenc',live_codec:codec});cb[4](line,'stderr');cb[5](1);manager.stopAll();
  }
  assert.deepEqual(failed,['nvenc']);
  assert(isHardwareEncoderError('[h264_vaapi @ 0x1] Driver does not support required entrypoint','vaapi'));
  assert(!isHardwareEncoderError('[h264_nvenc @ 0x1] Using device NVIDIA','nvenc'));
  assert(!isHardwareEncoderError('Error initializing output stream','nvenc'));
 }finally{performance.encoderFailed=old;}
});
test('shutdown also cancels delayed bootstrap and day-roll database callbacks',async()=>{
 const old=pool.query,count=spawns;
 try{
  for(const action of ['bootstrap','rollRecordingDayIfNeeded']){
   let resolve;pool.query=()=>new Promise(r=>resolve=r);
   const manager=new StreamManager();manager.recordDay='19000101';const pending=manager[action]();manager.stopAll();
   resolve({rows:[cam]});await pending;await new Promise(r=>setImmediate(r));
   assert.equal(manager.pendingStarts.size,0);assert.deepEqual(manager.health(),[]);
  }
  assert.equal(spawns,count);
 }finally{pool.query=old;}
});
