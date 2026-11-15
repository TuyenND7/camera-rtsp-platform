const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/liveDetections.tsx'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,exports_={};vm.runInNewContext(code,{exports:exports_,require:n=>n==='react'?{createContext:()=>({})}:{},Date,Math});
const now=1700000000000,frames=[{at:now-5000,detections:['old']},{at:now-3500,detections:['person']},{at:now-3000,detections:[]}],state={state:'ready',synchronized:true,updated_at:now,frame_ttl_ms:750,frames};
test('overlay follows displayed video time, never newest server result or a future frame',()=>{assert.equal(exports_.selectDetectionFrame(state,now-3300,now),frames[1]);assert.equal(exports_.selectDetectionFrame(state,now-2900,now),frames[2]);assert.equal(exports_.selectDetectionFrame(state,now-4000,now),null)});
test('no timestamp, stale worker, stopped or unsynchronized source clears Live overlay',()=>{assert.equal(exports_.selectDetectionFrame(state,null,now),null);for(const change of [{updated_at:now-13000},{state:'waiting'},{synchronized:false}])assert.equal(exports_.selectDetectionFrame({...state,...change},now-3300,now),null)});
test('viewer clock skew does not hide fresh boxes or extend stale worker lifetime',()=>{
 for(const skew of [-180000,180000]){
  const viewerNow=now+skew;
  const value=exports_.normalizeDetectionClock({...state,server_time:now,updated_at:now-1000},viewerNow);
  assert.equal(exports_.selectDetectionFrame(value,now-3300,viewerNow),frames[1]);
  assert.equal(exports_.selectDetectionFrame(value,now-3300,viewerNow+12000),null);
  assert.equal(exports_.selectDetectionFrame(exports_.normalizeDetectionClock({...state,server_time:now,updated_at:now-13000},viewerNow),now-3300,viewerNow),null);
  assert.equal(value.frames,frames);
 }
});
