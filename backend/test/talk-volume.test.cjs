const {test,after}=require('node:test'),assert=require('node:assert/strict');
const {amplifyPcm,talkGains}=require('../dist/talk/volume');
const {TalkManager,talkManager}=require('../dist/talk/manager');
const pcm=values=>{const b=Buffer.alloc(values.length*2);values.forEach((v,i)=>b.writeInt16LE(v,i*2));return b};
test('gain boosts quiet samples without mutating the source; zero mutes and unity bypasses',()=>{
 const input=pcm([0,1000,-1000,5000,-5000]);const original=Buffer.from(input);
 const output=amplifyPcm(input,2);assert.deepEqual(Array.from({length:5},(_,i)=>output.readInt16LE(i*2)),[0,2000,-2000,10000,-10000]);
 assert.deepEqual(input,original);assert.equal(amplifyPcm(input,1),input);assert.ok(amplifyPcm(input,0).every(v=>v===0));
 for(const gain of [-1,4.01,NaN,Infinity])assert.throws(()=>amplifyPcm(input,gain));
});
test('soft limiter preserves polarity and bounds loud PCM instead of wrapping',()=>{
 const input=pcm([32767,-32768,20000,-20000,1000,-1000]),output=amplifyPcm(input,4);
 assert.equal(output.length,input.length);for(let i=0;i<6;i++){const value=output.readInt16LE(i*2);assert(Math.abs(value)<=32768);assert.equal(Math.sign(value),Math.sign(input.readInt16LE(i*2)));}
 assert.equal(output.readInt16LE(8),4000);assert.equal(output.readInt16LE(10),-4000);
});
test('gains are bounded, selected-camera-only numeric maps',()=>{
 assert.deepEqual(talkGains({'2':0,'3':4},[2,3]),{2:0,3:4});
 for(const value of [null,[],4,{'1':2},{'02':2},{'2':'2'},{'2':-1},{'2':4.1},{'2':NaN},{'2':Infinity},JSON.parse('{"__proto__":2}')])assert.throws(()=>talkGains(value,[2,3]));
});
test('broadcast applies independent gains by camera ID and accepts live updates without changing raw PCM',async()=>{
 let time=0;const received=new Map(),m=new TalkManager((_url,camera)=>({open:async()=>({codec:'PCMA'}),describe:async()=>null,send:frame=>{if(!received.has(camera.id))received.set(camera.id,[]);received.get(camera.id).push(frame.readInt16LE(0))},close:()=>{}}),()=>time);
 try{const call=await m.start('owner',[{id:3,rtsp_url:'rtsp://three'},{id:2,rtsp_url:'rtsp://two'}],async()=>true);clearInterval(m.timer);const frame=Buffer.alloc(320);for(let i=0;i<160;i++)frame.writeInt16LE(1000,i*2);
 assert.throws(()=>m.push(call.id,'other',0,frame,{3:4}));assert.throws(()=>m.push(call.id,'owner',0,frame,{99:4}));
 m.push(call.id,'owner',0,frame,{3:2,2:.5});time+=20;m.tick();assert.equal(received.get(3).at(-1),2000);assert.equal(received.get(2).at(-1),500);assert.equal(frame.readInt16LE(0),1000);
 m.push(call.id,'owner',1,frame,{3:0});time+=20;m.tick();assert.equal(received.get(3).at(-1),0);assert.equal(received.get(2).at(-1),500);
 m.push(call.id,'owner',2,frame,{3:4,2:1});time+=20;m.tick();assert.equal(received.get(3).at(-1),4000);assert.equal(received.get(2).at(-1),1000);m.end(call.id,'owner');
 }finally{m.close()}
});
after(()=>talkManager.close());
