const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto');
const {TendaControls,controlState}=require('../dist/controls/tenda');
const storage=fs.mkdtempSync(path.join(os.tmpdir(),'camera-controls-'));
const camera={id:2,rtsp_url:'rtsp://owner:fixture-private-password@192.0.2.2/stream'},hash=createHash('sha256').update(camera.rtsp_url).digest('hex');
const state={alarm_supported:true,alarm_active:null,light_supported:true,light_enabled:false,observed_at:Date.now(),WifiConfiguration:{password:'fixture-secret'}};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function fixture(){const base=fs.mkdtempSync(path.join(storage,'sdk-')),root=path.join(base,'controls');fs.mkdirSync(root);const g={version:1,control_version:1,instance:randomUUID(),authenticated:true,updated_at:Date.now(),bindings:[{id:2,url_hash:hash,model:'CT3V1.0'}]};const publish=()=>fs.writeFileSync(path.join(base,'status.json'),JSON.stringify(g));publish();return{base,root,g,publish,client:new TendaControls(base)}}
after(()=>fs.rmSync(storage,{recursive:true,force:true}));
test('control responses whitelist state and preserve an unknown physical siren state',()=>{
 const safe=controlState(2,state);assert.equal(safe.alarm_active,null);assert.equal(safe.light_enabled,false);assert.ok(!JSON.stringify(safe).includes('fixture-secret'));assert.throws(()=>controlState(2,{...state,observed_at:'bad'}));
});
test('control requests require a fresh authenticated gateway and exact camera binding',async()=>{
 const f=fixture();try{f.g.updated_at=Date.now()-4000;f.publish();await assert.rejects(()=>f.client.get(camera),/chưa sẵn sàng/);f.g.updated_at=Date.now();f.g.authenticated=false;f.publish();await assert.rejects(()=>f.client.get(camera));f.g.authenticated=true;f.g.control_version=0;f.publish();await assert.rejects(()=>f.client.get(camera));f.g.control_version=1;f.publish();await assert.rejects(()=>f.client.get({...camera,rtsp_url:camera.rtsp_url+'changed'}));assert.deepEqual(fs.readdirSync(f.root),[]);}finally{f.client.close()}
});
test('SDK command IPC carries fingerprints, not camera credentials, and returns only safe state',async()=>{
 const f=fixture();let command;
 const agent=setInterval(()=>{for(const n of fs.readdirSync(f.root)){const d=path.join(f.root,n);if(!fs.existsSync(path.join(d,'request.json')))continue;command=JSON.parse(fs.readFileSync(path.join(d,'request.json')));fs.writeFileSync(path.join(d,'result.json'),JSON.stringify({ok:true,confirmed:true,state:{...state,light_enabled:true}}));}},10);
 try{const result=await f.client.set(camera,'light',true);assert.equal(command.action,'light');assert.equal(command.enabled,true);assert.equal(command.url_hash,hash);assert.equal(command.agent_instance,f.g.instance);assert.ok(!JSON.stringify(command).includes('fixture-private-password'));assert.equal(result.light_enabled,true);assert.ok(!JSON.stringify(result).includes('WifiConfiguration'));}finally{clearInterval(agent);f.client.close()}
});
test('an active timed alarm prevents duplicate starts and can be stopped after a backend restart',async()=>{
 const f=fixture(),id=randomUUID(),d=path.join(f.root,id);fs.mkdirSync(d);fs.writeFileSync(path.join(f.root,'alarm-2.json'),JSON.stringify({camera_id:2,url_hash:hash,request:id,ends_at:Date.now()+10000}));
 const agent=setInterval(()=>{if(fs.existsSync(path.join(d,'stop'))&&!fs.existsSync(path.join(d,'finished.json'))){fs.writeFileSync(path.join(d,'finished.json'),JSON.stringify({ok:true,acknowledged:true,confirmed:false,state}));fs.unlinkSync(path.join(f.root,'alarm-2.json'));}},10);
 try{assert.equal(f.client.alarmActive(camera),true);await assert.rejects(()=>f.client.set(camera,'alarm',true,10),/Còi đang/);const stopped=await f.client.set(camera,'alarm',false);assert.equal(stopped.alarm_active,null);assert.equal(f.client.alarmActive(camera),false);assert.ok(fs.existsSync(path.join(d,'stop')));}finally{clearInterval(agent);f.client.close()}
});
test('camera reconfiguration cancels pending control before a late hardware action',async()=>{
 const f=fixture();let directory;
 const agent=setInterval(()=>{for(const n of fs.readdirSync(f.root)){const d=path.join(f.root,n);if(!fs.existsSync(path.join(d,'request.json')))continue;directory=d;if(fs.existsSync(path.join(d,'stop')))fs.writeFileSync(path.join(d,'result.json'),JSON.stringify({ok:false,status:409,error:'sdk_control_cancelled'}));}},10);
 try{const pending=f.client.set(camera,'alarm',true,5);while(!directory)await wait(10);f.client.cancelCamera(camera.id);await assert.rejects(()=>pending,/hủy lệnh/);assert.ok(fs.existsSync(path.join(directory,'stop')));}finally{clearInterval(agent);f.client.close()}
});
test('a result from a previous SDK generation cannot confirm a new control request',async()=>{
 const f=fixture();let directory;
 const agent=setInterval(()=>{for(const n of fs.readdirSync(f.root)){const d=path.join(f.root,n);if(!fs.existsSync(path.join(d,'request.json'))||fs.existsSync(path.join(d,'result.json')))continue;directory=d;f.g.instance=randomUUID();f.publish();fs.writeFileSync(path.join(d,'result.json'),JSON.stringify({ok:true,state}));}},10);
 try{await assert.rejects(()=>f.client.get(camera),/khởi động lại/);assert.ok(fs.existsSync(path.join(directory,'stop')));}finally{clearInterval(agent);f.client.close()}
});

test('manual alarm metadata survives backend client restart and stays active until explicit stop',async()=>{
 const f=fixture();let second,alarmDirectory;
 const agent=setInterval(()=>{for(const n of fs.readdirSync(f.root)){const d=path.join(f.root,n);if(!fs.existsSync(d)||!fs.statSync(d).isDirectory())continue;
  if(d===alarmDirectory&&fs.existsSync(path.join(d,'stop'))&&!fs.existsSync(path.join(d,'finished.json'))){fs.unlinkSync(path.join(f.root,'alarm-2.json'));fs.writeFileSync(path.join(d,'finished.json'),JSON.stringify({ok:true,state}));continue}
  if(!fs.existsSync(path.join(d,'request.json'))||fs.existsSync(path.join(d,'result.json')))continue;
  const c=JSON.parse(fs.readFileSync(path.join(d,'request.json')));if(c.action==='alarm'&&c.enabled){assert.equal(c.duration_seconds,0);alarmDirectory=d;fs.writeFileSync(path.join(f.root,'alarm-2.json'),JSON.stringify({camera_id:2,url_hash:hash,request:n,duration_seconds:0,ends_at:null}))}
  fs.writeFileSync(path.join(d,'result.json'),JSON.stringify({ok:true,state}));}},10);
 try{const result=await f.client.set(camera,'alarm',true,0);assert.equal(result.alarm_command_active,true);assert.equal(result.alarm_until_stopped,true);assert.equal(result.ends_at,null);
 second=new TendaControls(f.base);const loaded=await second.get(camera);assert.equal(loaded.alarm_command_active,true);assert.equal(loaded.alarm_active,null);
 const stopped=await second.set(camera,'alarm',false);assert.equal(stopped.alarm_command_active,false);assert.equal(stopped.alarm_until_stopped,false);assert.equal(second.alarmActive(camera),false);
 }finally{clearInterval(agent);second?.close();f.client.close()}
});
