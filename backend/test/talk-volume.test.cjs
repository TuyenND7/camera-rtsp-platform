const {test,after}=require('node:test'),assert=require('node:assert/strict');
const {PcmAmplifier,talkGains}=require('../dist/talk/volume');
const {TalkManager,talkManager}=require('../dist/talk/manager');
const pcm=values=>{const b=Buffer.alloc(values.length*2);values.forEach((v,i)=>b.writeInt16LE(v,i*2));return b};
test('quiet samples retain linear gain with 5 ms lookahead and the source is immutable',()=>{
 const samples=Array.from({length:160},(_,i)=>[0,1000,-1000,5000,-5000][i%5]),input=pcm(samples),original=Buffer.from(input);
 for(const gain of [.5,1,2]){const output=new PcmAmplifier().process(input,gain);for(let i=0;i<160;i++)assert.equal(output.readInt16LE(i*2),i<40?0:Math.round(samples[i-40]*gain));}
 assert.deepEqual(input,original);
 for(const gain of [-1,4.01,NaN,Infinity])assert.throws(()=>new PcmAmplifier().process(input,gain));
 assert.throws(()=>new PcmAmplifier().process(Buffer.alloc(3),1));
});
function render(input,gain,chunk=320){const limiter=new PcmAmplifier(),out=[];for(let i=0;i<input.length;i+=chunk)out.push(limiter.process(input.subarray(i,i+chunk),gain));return Buffer.concat(out)}
function amplitude(buffer,harmonic=1){let sin=0,cos=0;const count=buffer.length/2;for(let n=0;n<count;n++){const phase=2*Math.PI*500*harmonic*n/8000,value=buffer.readInt16LE(n*2);sin+=value*Math.sin(phase);cos+=value*Math.cos(phase)}return 2*Math.hypot(sin,cos)/count}
test('loud boosted tones keep harmonic distortion below 0.3% and retain useful loudness',()=>{
 const input=pcm(Array.from({length:16000},(_,n)=>Math.round(.7*32767*Math.sin(2*Math.PI*500*n/8000))));
 for(const gain of [2,4]){const output=render(input,gain),steady=output.subarray(8000,24000),fundamental=amplitude(steady),thd=Math.sqrt([3,5,7].reduce((sum,h)=>sum+amplitude(steady,h)**2,0))/fundamental;
 assert(thd<.003,`gain ${gain} distortion ${100*thd}%`);assert(fundamental>32768*.75);for(let i=0;i<output.length;i+=2)assert(Math.abs(output.readInt16LE(i))<=29492);}
});
test('limiter timing and audio do not depend on HTTP/frame boundaries',()=>{
 const input=pcm(Array.from({length:8000},(_,n)=>Math.round((n<3200?.7:.05)*32767*Math.sin(2*Math.PI*500*n/8000))));
 const baseline=render(input,4);for(const chunk of [80,160,640,3200])assert.deepEqual(render(input,4,chunk),baseline);
 assert(amplitude(baseline.subarray(12000,15200))>.049*4*32767);
});
test('isolated full-scale transients are bounded; mute discards pending voice immediately',()=>{
 const samples=Array(1600).fill(0);samples[0]=32767;samples[639]=-32768;
 const limiter=new PcmAmplifier(),out=limiter.process(pcm(samples),4);for(let i=0;i<out.length;i+=2)assert(Math.abs(out.readInt16LE(i))<=29492);
 const quiet=pcm(Array(160).fill(1000));limiter.process(quiet,4);assert(limiter.process(quiet,0).every(v=>v===0));
 const resumed=limiter.process(quiet,2);for(let i=0;i<160;i++)assert.equal(resumed.readInt16LE(i*2),i<40?0:2000);
});
test('gains are bounded, selected-camera-only numeric maps',()=>{
 assert.deepEqual(talkGains({'2':0,'3':4},[2,3]),{2:0,3:4});
 for(const value of [null,[],4,{'1':2},{'02':2},{'2':'2'},{'2':-1},{'2':4.1},{'2':NaN},{'2':Infinity},JSON.parse('{"__proto__":2}')])assert.throws(()=>talkGains(value,[2,3]));
});
test('broadcast applies independent gains by camera ID and accepts live updates without changing raw PCM',async()=>{
 let time=0;const received=new Map(),m=new TalkManager((_url,camera)=>({open:async()=>({codec:'PCMA'}),describe:async()=>null,send:frame=>{if(!received.has(camera.id))received.set(camera.id,[]);received.get(camera.id).push(frame.readInt16LE(318))},close:()=>{}}),()=>time);
 try{const call=await m.start('owner',[{id:3,rtsp_url:'rtsp://three'},{id:2,rtsp_url:'rtsp://two'}],async()=>true);clearInterval(m.timer);const frame=Buffer.alloc(320);for(let i=0;i<160;i++)frame.writeInt16LE(1000,i*2);
 assert.throws(()=>m.push(call.id,'other',0,frame,{3:4}));assert.throws(()=>m.push(call.id,'owner',0,frame,{99:4}));
 m.push(call.id,'owner',0,frame,{3:2,2:.5});time+=20;m.tick();assert.equal(received.get(3).at(-1),2000);assert.equal(received.get(2).at(-1),500);assert.equal(frame.readInt16LE(0),1000);
 m.push(call.id,'owner',1,frame,{3:0});time+=20;m.tick();assert.equal(received.get(3).at(-1),0);assert.equal(received.get(2).at(-1),500);
 m.push(call.id,'owner',2,frame,{3:4,2:1});time+=20;m.tick();assert.equal(received.get(3).at(-1),4000);assert.equal(received.get(2).at(-1),1000);
 const loud=pcm(Array(160).fill(23000));m.push(call.id,'owner',3,loud,{3:4,2:1});time+=20;m.tick();assert(received.get(3).at(-1)>23000&&received.get(3).at(-1)<29492);assert.equal(received.get(2).at(-1),23000);
 m.push(call.id,'owner',4,frame,{3:0});time+=20;m.tick();assert.equal(received.get(3).at(-1),0);assert.equal(received.get(2).at(-1),1000);m.end(call.id,'owner');
 }finally{m.close()}
});
after(()=>talkManager.close());
