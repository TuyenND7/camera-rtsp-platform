const {test, after}=require('node:test'),assert=require('node:assert/strict'),net=require('node:net'),{createHash}=require('node:crypto'),fs=require('node:fs'),vm=require('node:vm');
const {RtspTalk,talkTrack,g711}=require('../dist/talk/rtsp'),{TalkManager,talkManager}=require('../dist/talk/manager');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
// ONVIF Streaming 5.3.2: directions describe the client, not the camera.
const sdp=(codec='PCMA',direction='sendonly')=>`v=0\r\na=control:*\r\nm=audio 0 RTP/AVP 8\r\na=recvonly\r\na=rtpmap:8 PCMA/8000\r\na=control:microphone\r\nm=audio 0 RTP/AVP 97\r\na=${direction}\r\na=rtpmap:97 ${codec}/8000/1\r\na=control:talk\r\n`;
async function camera({codec='PCMA',auth='Basic',noBackchannel=false,rejectBackchannel=false}={}){
 const sockets=new Set(),packets=[],methods=[],authorized=[],requests=[];let address;
 const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let buffer=Buffer.alloc(0);
 socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length){
  if(buffer[0]===36){if(buffer.length<4)return;const size=4+buffer.readUInt16BE(2);if(buffer.length<size)return;packets.push(Buffer.from(buffer.subarray(0,size)));buffer=buffer.subarray(size);continue}
  const end=buffer.indexOf('\r\n\r\n');if(end<0)return;const h=buffer.subarray(0,end).toString();buffer=buffer.subarray(end+4);
  const [method,uri]=h.split('\r\n')[0].split(' '),seq=h.match(/CSeq:\s*(\d+)/i)?.[1],a=h.match(/Authorization:\s*([^\r\n]+)/i)?.[1];methods.push(method);
  requests.push({method,uri,backchannel:/Require:\s*www\.onvif\.org\/ver20\/backchannel/i.test(h)});
  let valid=!auth;if(auth==='Basic')valid=a==='Basic '+Buffer.from('user:fixture-password').toString('base64');
  if(auth==='Digest'&&a){const f=Object.fromEntries([...a.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map(m=>[m[1],m[2]??m[3]])),md5=s=>createHash('md5').update(s).digest('hex');valid=f.response===md5(`${md5('user:camera:fixture-password')}:nonce:${f.nc}:${f.cnonce}:auth:${md5(method+':'+uri)}`)}
  const challenge=auth==='Digest'?'Digest realm="camera", nonce="nonce", qop="auth", algorithm=MD5':'Basic realm="camera"';
  const body=method==='DESCRIBE'&&valid?sdp(codec,noBackchannel?'recvonly':'sendonly'):'';
  const extras=!valid?`WWW-Authenticate: ${challenge}\r\n`:method==='DESCRIBE'?`Content-Type: application/sdp\r\nContent-Base: ${address}/stream/\r\n`:method==='SETUP'?'Session: call123;timeout=30\r\nTransport: RTP/AVP/TCP;unicast;interleaved=4-5\r\n':'';
  const unsupported=valid&&rejectBackchannel&&method==='DESCRIBE';
  const response=unsupported?`RTSP/1.0 551 Option not supported\r\nCSeq: ${seq}\r\nUnsupported: www.onvif.org/ver20/backchannel\r\nContent-Length: 0\r\n\r\n`:`RTSP/1.0 ${valid?'200 OK':'401 Unauthorized'}\r\nCSeq: ${seq}\r\n${extras}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  if(valid)authorized.push(method);socket.write(response.slice(0,17));socket.write(response.slice(17));
 }});});await new Promise(r=>server.listen(0,'127.0.0.1',r));address=`rtsp://127.0.0.1:${server.address().port}`;
 return{url:address.replace('://','://user:fixture-password@')+'/stream',packets,methods,authorized,requests,close:async()=>{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r))}};
}
after(()=>talkManager.close());
test('camera microphone and unsupported codecs never count as a speaker backchannel',()=>{
 assert.equal(talkTrack('v=0\r\nm=audio 0 RTP/AVP 8\r\na=control:audio\r\n'),null);
 for(const direction of ['sendrecv','recvonly','inactive'])assert.equal(talkTrack(sdp('PCMA',direction)),null);
 assert.equal(talkTrack(sdp('AAC')),null);assert.equal(talkTrack(sdp().replace('PCMA/8000/1','PCMA/8000/2')),null);
});
test('ONVIF client-send tracks support static payloads and session direction',()=>{
 assert.deepEqual(talkTrack(sdp()),{control:'talk',payload:97,codec:'PCMA'});
 assert.deepEqual(talkTrack('v=0\r\na=sendonly\r\nm=audio 0 RTP/AVP 0\r\na=control:talk\r\n'),{control:'talk',payload:0,codec:'PCMU'});
 assert.equal(talkTrack('v=0\r\na=sendonly\r\nm=audio 0 RTP/AVP 0\r\na=recvonly\r\na=control:microphone\r\n'),null);
});
test('G.711 matches silence and saturation reference codes',()=>{
 assert.deepEqual([0,-1,32767,-32768].map(n=>g711(n,'PCMA')),[0xd5,0x55,0xaa,0x2a]);
 assert.deepEqual([0,-1,32767,-32768].map(n=>g711(n,'PCMU')),[0xff,0x7f,0x80,0]);
});
for(const auth of ['Basic','Digest'])test(`RTSP ${auth} handshake sends real RTP on the negotiated channel`,async()=>{
 const fake=await camera({auth}),client=new RtspTalk(fake.url);try{
  assert.equal((await client.open()).codec,'PCMA');const pcm=Buffer.alloc(320);for(let i=0;i<160;i++)pcm.writeInt16LE(i*100,i*2);
  assert(fake.requests.find(r=>r.method==='SETUP').uri.endsWith('/stream/talk'));
  assert(fake.requests.filter(r=>['DESCRIBE','SETUP','PLAY'].includes(r.method)).every(r=>r.backchannel));
  client.send(pcm);client.send(pcm);await wait(60);assert.equal(fake.packets.length,2);
  const[a,b]=fake.packets;assert.equal(a[1],4);assert.equal(a[5],97);assert.equal(a.readUInt16BE(2),172);assert.equal((b.readUInt16BE(6)-a.readUInt16BE(6))&65535,1);assert.equal((b.readUInt32BE(8)-a.readUInt32BE(8))>>>0,160);
  assert.ok(a.subarray(16).some(v=>v!==0xd5));assert.ok(fake.authorized.includes('PLAY'));client.close();await wait(60);assert.ok(fake.authorized.includes('TEARDOWN'));
 }finally{client.close();await fake.close()}
});
test('RTSP 551 reports unsupported backchannel without trying to send to the microphone',async()=>{
 const fake=await camera({rejectBackchannel:true}),client=new RtspTalk(fake.url);try{
  await assert.rejects(()=>client.open(),e=>e.status===422&&e.message.includes('RTSP 551'));
  assert(!fake.methods.includes('SETUP'));assert(!fake.methods.includes('PLAY'));assert.equal(fake.packets.length,0);
 }finally{client.close();await fake.close()}
});
test('unsupported camera probes never PLAY, SETUP or expose credentials',async()=>{
 const fake=await camera({noBackchannel:true}),manager=new TalkManager();try{const c={id:1,rtsp_url:fake.url},r=await manager.probe(c);assert.equal(r.supported,false);assert.ok(!JSON.stringify(r).includes('fixture-password'));assert.ok(!fake.methods.includes('SETUP')&&!fake.methods.includes('PLAY'));const count=fake.methods.length;await manager.probe(c);assert.equal(fake.methods.length,count)}finally{manager.close();await fake.close()}
});
test('broadcast reaches two camera codecs; ownership, ordering and exclusivity are enforced',async()=>{
 const a=await camera(),b=await camera({codec:'PCMU'}),m=new TalkManager();try{
  const s=await m.start('owner',[{id:1,rtsp_url:a.url},{id:2,rtsp_url:b.url}],async()=>true),pcm=Buffer.alloc(3200);for(let i=0;i<1600;i++)pcm.writeInt16LE(5000,i*2);
  assert.throws(()=>m.push(s.id,'other',0,pcm),/kết thúc/);m.push(s.id,'owner',0,pcm);await wait(130);
  assert.ok(a.packets.some(p=>p[16]===g711(5000,'PCMA')));assert.ok(b.packets.some(p=>p[16]===g711(5000,'PCMU')));
  assert.throws(()=>m.push(s.id,'owner',0,pcm),/thứ tự/);await assert.rejects(()=>m.start('other',[{id:1,rtsp_url:a.url}],async()=>true),/khác/);
  m.end(s.id,'owner');await wait(40);const counts=[a.packets.length,b.packets.length];await wait(90);assert.deepEqual([a.packets.length,b.packets.length],counts);assert.throws(()=>m.push(s.id,'owner',1,pcm),/kết thúc/);
 }finally{m.close();await a.close();await b.close()}
});
test('revocation, idle timeout and maximum duration release camera locks',async()=>{
 let time=0,valid=true;const clients=[],m=new TalkManager(()=>{const c={open:async()=>({codec:'PCMA'}),describe:async()=>null,send:()=>{},close:()=>{c.closed=true},closed:false};clients.push(c);return c},()=>time);
 try{const s=await m.start('owner',[{id:1,rtsp_url:'rtsp://fixture'}],async()=>valid);time=1001;valid=false;await wait(50);assert.ok(clients[0].closed);assert.throws(()=>m.push(s.id,'owner',0,Buffer.alloc(320)),/kết thúc/);
 valid=true;await m.start('owner',[{id:1,rtsp_url:'rtsp://fixture'}],async()=>valid);time+=1600;await wait(40);assert.ok(clients[1].closed);
 await m.start('owner',[{id:1,rtsp_url:'rtsp://fixture'}],async()=>valid);time+=60001;await wait(40);assert.ok(clients[2].closed);
 }finally{m.close()}
});
test('partial setup failure closes transports and allows a later retry',async()=>{
 let count=0;const clients=[],m=new TalkManager(()=>{const c={open:async()=>{if(++count===2)throw Error('private transport error')},describe:async()=>null,send:()=>{},close:()=>{c.closed=true},closed:false};clients.push(c);return c});
 try{await assert.rejects(()=>m.start('o',[{id:1,rtsp_url:'rtsp://a'},{id:2,rtsp_url:'rtsp://b'}],async()=>true),e=>e.message==='Không mở được kênh đàm thoại tới camera.');assert.ok(clients.every(c=>c.closed));const s=await m.start('o',[{id:1,rtsp_url:'rtsp://a'}],async()=>true);m.end(s.id,'o')}finally{m.close()}
});
test('jittered server ticks keep up with a real-time microphone without growing the audio queue',async()=>{
 let time=0,frames=0;const manager=new TalkManager(()=>({open:async()=>({codec:'PCMA'}),describe:async()=>null,send:()=>{frames++},close:()=>{}}),()=>time);
 try{const call=await manager.start('owner',[{id:1,rtsp_url:'rtsp://fixture'}],async()=>true);clearInterval(manager.timer);
 for(let batch=0;batch<25;batch++){manager.push(call.id,'owner',batch,Buffer.alloc(3200));for(let tick=0;tick<8;tick++){time+=25;manager.tick()}await Promise.resolve()}
 assert.equal(frames,250);manager.end(call.id,'owner');
 }finally{manager.close()}
});
test('a burst after network jitter retains recent speech within the buffer limit and keeps the call usable',async()=>{
 let time=0;const received=[],manager=new TalkManager(()=>({open:async()=>({codec:'PCMA'}),describe:async()=>null,send:pcm=>received.push(pcm.readInt16LE(0)),close:()=>{}}),()=>time);
 try{const call=await manager.start('owner',[{id:1,rtsp_url:'rtsp://fixture'}],async()=>true);clearInterval(manager.timer);
 const block=value=>{const b=Buffer.alloc(6400);for(let i=0;i<b.length;i+=2)b.writeInt16LE(value,i);return b};manager.push(call.id,'owner',0,block(100));manager.push(call.id,'owner',1,block(200));
 for(let tick=0;tick<25;tick++){time+=20;manager.tick()}assert.deepEqual(received,[...Array(5).fill(100),...Array(20).fill(200)]);
 manager.push(call.id,'owner',2,Buffer.alloc(320));time+=20;manager.tick();assert.equal(received.at(-1),0);manager.end(call.id,'owner');
 }finally{manager.close()}
});
test('worklet resamples to PCM 8 kHz and never plays mic through the tablet speaker',()=>{
 let Processor;const sent=[],context={sampleRate:48000,AudioWorkletProcessor:class{constructor(){this.port={postMessage:b=>sent.push(b)}}},registerProcessor:(_name,type)=>{Processor=type}};
 vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../../web/public/audio/pcm-capture.js'),'utf8'),context);const p=new Processor();
 for(let i=0;i<75;i++){const out=new Float32Array(128).fill(1);p.process([[new Float32Array(128).fill(.5)]],[[out]]);assert.ok(out.every(v=>v===0))}assert.equal(sent.length,1);assert.equal(sent[0].byteLength,3200);assert.ok(new Int16Array(sent[0]).every(v=>v>16000&&v<17000));
});
