const {test,after}=require('node:test'),assert=require('node:assert/strict');
const {LiveAudio,liveAudio}=require('../dist/stream/audio'),{TalkManager,talkManager}=require('../dist/talk/manager');
after(()=>talkManager.close());
const frame=n=>Buffer.alloc(320,n);
test('fragmented PCM reassembles exactly; readers are independent and skip old audio',()=>{
 let now=1000;const hub=new LiveAudio(()=>now),generation=hub.begin(1);
 const input=Buffer.concat([frame(1),frame(2),frame(3),frame(4)]);hub.push(1,generation,input.subarray(0,319));assert.equal(hub.ready(1),false);hub.push(1,generation,input.subarray(319));
 const a=hub.open(1),b=hub.open(1);assert.deepEqual(a.read(),input);assert.deepEqual(b.read(),input);assert.equal(a.read().length,0);
 for(let i=5;i<=60;i++)hub.push(1,generation,frame(i));
 assert.equal(hub.channels.get(1).frames.length,25);assert.equal(a.read()[0],51);assert.equal(a.read()[0],56);assert.equal(a.read().length,0);
 now+=1500;assert.equal(hub.ready(1),false);assert.throws(()=>b.read(),/ngắt/);
});
test('replacing or stopping a generation invalidates readers without closing its replacement',()=>{
 const hub=new LiveAudio(),old=hub.begin(1);hub.push(1,old,frame(1));const reader=hub.open(1),next=hub.begin(1);hub.end(1,old);hub.push(1,old,frame(9));hub.push(1,next,frame(2));
 assert.throws(()=>reader.read(),/ngắt/);assert.equal(hub.open(1).read()[0],2);hub.end(1,next);assert.equal(hub.ready(1),false);
});
test('duplex needs explicit request, fresh audio and supported native mode; owner and closure enforced',async()=>{
 const generations=[101,102,103].map(id=>[id,liveAudio.begin(id)]);generations.slice(0,2).forEach(([id,g])=>liveAudio.push(id,g,frame(id)));
 const clients=[],manager=new TalkManager((_url,camera)=>{const c={open:async()=>({codec:'PCM'}),describe:async()=>null,send(){},close(){this.closed=true},enableDuplex(){return camera.id!==102}};clients.push(c);return c});
 const cameras=generations.map(([id])=>({id,rtsp_url:'rtsp://fixture'}));
 try{
  let call=await manager.start('a',cameras,async()=>true);assert.deepEqual(call.listen_camera_ids,[]);manager.end(call.id,'a');
  call=await manager.start('a',cameras,async()=>true,true);assert.deepEqual(call.listen_camera_ids,[101]);
  assert.throws(()=>manager.readAudio(call.id,'b',101),e=>e.status===404);assert.throws(()=>manager.readAudio(call.id,'a',102),e=>e.status===422);assert.equal(manager.readAudio(call.id,'a',101).length,320);
  manager.end(call.id,'a');assert.throws(()=>manager.readAudio(call.id,'a',101),e=>e.status===404);assert(clients.every(c=>c.closed));
 }finally{manager.close();generations.forEach(([id,g])=>liveAudio.end(id,g))}
});
