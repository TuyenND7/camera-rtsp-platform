const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto');
const storage=fs.mkdtempSync(path.join(os.tmpdir(),'camera-tenda-test-'));process.env.STORAGE_ROOT=storage;
const {TendaTalk,tendaGateway,tendaCacheKey}=require('../dist/talk/tenda'),{TalkManager,talkManager}=require('../dist/talk/manager');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const camera={id:2,rtsp_url:'rtsp://owner:fixture-private-password@192.0.2.1:8554/profile0'};
const hash=createHash('sha256').update(camera.rtsp_url).digest('hex');
function gateway(base){fs.mkdirSync(base,{recursive:true});const state={version:1,instance:randomUUID(),updated_at:Date.now(),authenticated:true,bindings:[{id:2,url_hash:hash,model:'CT3V1.0'}]};const publish=()=>fs.writeFileSync(path.join(base,'status.json'),JSON.stringify(state));publish();return{state,publish};}
const directory=()=>fs.mkdtempSync(path.join(storage,'gateway-'));
after(()=>{talkManager.close();fs.rmSync(storage,{recursive:true,force:true})});
test('SDK bindings require the exact camera URL, supported model and bounded status',async()=>{
 const base=directory(),g=gateway(base),client=new TendaTalk(camera,base);
 try{assert.equal((await client.describe()).codec,'PCMA');assert.equal(tendaGateway({...camera,id:3},base),undefined);assert.equal(tendaGateway({...camera,rtsp_url:camera.rtsp_url+'1'},base),undefined);
 g.state.bindings[0].model='unknown';g.publish();assert.equal(tendaGateway(camera,base),undefined);g.state.bindings[0].model='CT3V1.0';g.state.updated_at=Date.now()-4000;g.publish();await assert.rejects(()=>client.describe(),/chưa sẵn sàng/);
 g.state.updated_at=Date.now()+4000;g.publish();await assert.rejects(()=>client.describe(),/chưa sẵn sàng/);g.state.updated_at=Date.now();g.state.authenticated=false;g.publish();await assert.rejects(()=>client.describe(),/chưa sẵn sàng/);
 fs.writeFileSync(path.join(base,'status.json'),' '.repeat(17000));assert.equal(tendaGateway(camera,base),undefined);
 }finally{client.close()}
});
test('audio is accepted after SDK readiness, never includes camera credentials, and stops on close',async()=>{
 const base=directory(),g=gateway(base),client=new TendaTalk(camera,base);let session,ready=false;
 const agent=setInterval(()=>{for(const name of fs.readdirSync(base)){const d=path.join(base,name);if(!fs.existsSync(path.join(d,'start.json')))continue;session=d;if(ready&&!fs.existsSync(path.join(d,'state.json')))fs.writeFileSync(path.join(d,'state.json'),JSON.stringify({state:'ready'}))}},10);
 try{let resolved=false;const opening=client.open().then(v=>{resolved=true;return v});await wait(80);assert.equal(resolved,false);assert.ok(session);assert.throws(()=>client.send(Buffer.alloc(320)),/chưa sẵn sàng/);assert.equal(fs.statSync(path.join(session,'audio.pcm')).size,0);const command=JSON.parse(fs.readFileSync(path.join(session,'start.json')));assert.equal(command.agent_instance,g.state.instance);assert.equal(command.url_hash,hash);assert.ok(!JSON.stringify(command).includes('fixture-private-password'));ready=true;await opening;
 const pcm=Buffer.alloc(320);for(let n=0;n<160;n++)pcm.writeInt16LE(n*100,n*2);client.send(pcm);assert.deepEqual(fs.readFileSync(path.join(session,'audio.pcm')),pcm);assert.throws(()=>client.send(Buffer.alloc(640)),/đã đóng/);client.close();assert.ok(fs.existsSync(path.join(session,'stop')));assert.throws(()=>client.send(pcm),/đã đóng/);
 }finally{clearInterval(agent);client.close()}
});
test('transient manifest replacement preserves only a fresh verified record and never masks revocation',async()=>{
 const base=directory(),g=gateway(base),file=path.join(base,'status.json'),saved=path.join(base,'status.saved');
 assert.ok(tendaGateway(camera,base));fs.renameSync(file,saved);assert.ok(tendaGateway(camera,base));assert.equal(tendaGateway({...camera,rtsp_url:'rtsp://changed'},base),undefined);fs.renameSync(saved,file);
 g.state.authenticated=false;g.publish();assert.equal(tendaGateway(camera,base).authenticated,false);fs.renameSync(file,saved);assert.equal(tendaGateway(camera,base).authenticated,false);fs.renameSync(saved,file);
 g.state.authenticated=true;g.state.updated_at=Date.now()-4000;g.publish();tendaGateway(camera,base);fs.renameSync(file,saved);assert.equal(tendaGateway(camera,base),undefined);fs.renameSync(saved,file);
 g.state.updated_at=Date.now();g.publish();assert.ok(tendaGateway(camera,base));fs.writeFileSync(file,'invalid json');assert.equal(tendaGateway(camera,base),undefined);fs.unlinkSync(file);assert.equal(tendaGateway(camera,base),undefined);
});
test('a gateway restart closes an existing voice session and invokes onClose once',async()=>{
 const base=directory(),g=gateway(base),client=new TendaTalk(camera,base);let notices=0;client.onClose=()=>notices++;
 const opening=client.open();await wait(30);const session=fs.readdirSync(base).map(n=>path.join(base,n)).find(p=>fs.existsSync(path.join(p,'start.json')));fs.writeFileSync(path.join(session,'state.json'),JSON.stringify({state:'ready'}));await opening;
 g.state.instance=randomUUID();g.publish();await wait(320);assert.equal(notices,1);assert.ok(fs.existsSync(path.join(session,'stop')));await wait(280);assert.equal(notices,1);client.close();
});
test('failed SDK setup closes the request and leaves no usable audio channel',async()=>{
 const base=directory();gateway(base);const client=new TendaTalk(camera,base),opening=client.open();await wait(20);const session=fs.readdirSync(base).map(n=>path.join(base,n)).find(p=>fs.existsSync(path.join(p,'start.json')));fs.writeFileSync(path.join(session,'state.json'),JSON.stringify({state:'error',code:8}));await assert.rejects(()=>opening,/SDK|sẵn sàng/);assert.ok(fs.existsSync(path.join(session,'stop')));assert.throws(()=>client.send(Buffer.alloc(320)),/đã đóng/);
});
test('installing or restarting the SDK invalidates an old negative capability cache',async()=>{
 const base=path.join(storage,'.tenda-talk');let probes=0;const manager=new TalkManager(()=>({describe:async()=>{probes++;return null},open:async()=>{},close:()=>{},send:()=>{}}));
 try{await manager.probe(camera);await manager.probe(camera);assert.equal(probes,1);const g=gateway(base);assert.ok(tendaCacheKey(camera,base));await manager.probe(camera);assert.equal(probes,2);g.state.instance=randomUUID();g.publish();await manager.probe(camera);assert.equal(probes,3)}finally{manager.close()}
});
