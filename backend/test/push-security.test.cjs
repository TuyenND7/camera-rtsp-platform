const {test,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'camera-push-test-'));process.env.STORAGE_ROOT=root;
const {pool}=require('../dist/db');
const {validPushEndpoint,publicInternetAddress,validatePushSubscription,pushAllowed,pushPreferenceDefaults,deliverWebPush,PushError}=require('../dist/operations/pushSecurity');
const {pushVapid,pushNoticePayload,PushDeliveryService,shouldRetryPush}=require('../dist/operations/push');
const ecdh=crypto.createECDH('prime256v1');ecdh.generateKeys();const sub={endpoint:'https://fcm.googleapis.com/fcm/send/fixture',keys:{p256dh:ecdh.getPublicKey().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url')}};
after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('subscriptions require valid browser ECDH/auth keys and known HTTPS push providers',()=>{
 assert.deepEqual(validatePushSubscription(sub),sub);
 for(const endpoint of ['http://fcm.googleapis.com/fcm/send/fixture','https://127.0.0.1/a','https://192.168.0.1/a','https://fcm.googleapis.com.evil.example/a','https://fcm.googleapis.com@127.0.0.1/a','https://fcm.googleapis.com:8443/a','https://web.push.apple.com.evil.example/a','https://evil.example/a'])assert(!validPushEndpoint(endpoint));
 for(const endpoint of ['https://web.push.apple.com/QHfixture','https://updates.push.services.mozilla.com/wpush/v2/fixture','https://wns2-par02p.notify.windows.com/w/?token=fixture'])assert(validPushEndpoint(endpoint));
 assert.throws(()=>validatePushSubscription({...sub,keys:{...sub.keys,p256dh:Buffer.alloc(65).toString('base64url')}}));
});
test('DNS pinning rejects private, mapped, loopback, link-local, tunnel and documentation addresses',()=>{
 for(const ip of ['127.0.0.1','10.1.2.3','192.168.1.1','169.254.169.254','100.64.0.1','172.16.2.1','198.18.0.1','203.0.113.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2::1','2001:db8::1','2001:0000::1','2002:7f00:0001::1'])assert(!publicInternetAddress(ip),ip);
 for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111','2a00:1450:4000::1'])assert(publicInternetAddress(ip),ip);
});
test('quiet hours, snooze, disabled notifications and operating mode all suppress sends',()=>{
 const prefs={...pushPreferenceDefaults(),timezone:'UTC',quiet_enabled:true,quiet_start:'22:00',quiet_end:'07:00'};
 for(const time of ['2026-11-23T22:00:00Z','2026-11-24T06:59:00Z'])assert(!pushAllowed(prefs,new Date(time)));
 assert(pushAllowed(prefs,new Date('2026-11-24T07:00:00Z')));
 assert(!pushAllowed({...prefs,quiet_enabled:false,snooze_until:'2026-11-24T08:00:00Z'},new Date('2026-11-24T07:00:00Z')));
 assert(!pushAllowed({...prefs,quiet_enabled:false,enabled:false}));assert(!pushAllowed({...prefs,quiet_enabled:false},new Date(),false));
});
test('VAPID private key stays in a 0600 file; payloads contain only safe text and relative links',async()=>{
 const a=await pushVapid(),b=await pushVapid();assert.equal(a.publicKey,b.publicKey);assert.equal(fs.statSync(path.join(root,'.push','vapid.json')).mode&0o777,0o600);
 const payload=pushNoticePayload({id:'9',camera_id:2,camera_name:'Sân',kind:'intrusion',rtsp_url:'rtsp://secret:private@camera'});
 assert.equal(payload.url,'/live?camera=2&notice=9');assert(!JSON.stringify(payload).includes('private'));
 assert.equal(pushNoticePayload({id:10,kind:'storage_error',message:'untrusted password'}).url,'/settings#health');
});
test('the transport pins verified DNS, encrypts payloads and never follows provider redirects',async()=>{
 const dns=require('node:dns/promises'),https=require('node:https'),{EventEmitter}=require('node:events'),oldLookup=dns.lookup,oldRequest=https.request;
 let requests=0,providerStatus=201,privateDns=false;
 dns.lookup=async()=>[{address:privateDns?'127.0.0.1':'8.8.8.8',family:4}];
 https.request=(_url,options,callback)=>{
  requests++;assert.equal(options.agent,false);assert.equal(options.family,4);
  options.lookup('fcm.googleapis.com',{all:true},(_err,addresses)=>assert.deepEqual(addresses,[{address:'8.8.8.8',family:4}]));
  const req=new EventEmitter();req.destroy=()=>{};req.end=body=>{assert(Buffer.isBuffer(body));assert(!body.toString().includes('private message'));queueMicrotask(()=>{callback({statusCode:providerStatus,resume(){}});req.emit('close');});};return req;
 };
 try{
  const keys=await pushVapid();
  await deliverWebPush(sub,{message:'private message'},keys);assert.equal(requests,1);
  providerStatus=302;await assert.rejects(()=>deliverWebPush(sub,{message:'private message'},keys),e=>e instanceof PushError&&e.status===302);assert.equal(requests,2);
  privateDns=true;await assert.rejects(()=>deliverWebPush(sub,{message:'private message'},keys),e=>e instanceof PushError&&e.code==='private_address');assert.equal(requests,2);
 }finally{dns.lookup=oldLookup;https.request=oldRequest;}
});
test('expired/revoked sessions skip delivery; retries are bounded and 410 removes the subscription',async()=>{
 const original=pool.query,updates=[],sent=[];let live=false,throwStatus=0;
 pool.query=async(sql,values)=>{if(sql.startsWith('SELECT d.id')){assert(sql.includes('s.expires_at>now()'));assert(sql.includes('s.user_id=p.user_id'));return{rows:live?[{id:'8',subscription_id:'00000000-0000-4000-8000-000000000001',...sub,camera_id:1,camera_name:'Fixture',kind:'intrusion',enabled:true,timezone:'UTC',quiet_enabled:false,quiet_start:'22:00',quiet_end:'07:00'}]:[]};}updates.push({sql,values});return{rows:[]};};
 const service=new PushDeliveryService(async(_sub,payload)=>{if(throwStatus)throw new PushError('provider failure',throwStatus,'fixture_error');sent.push(payload);},()=>true);
 try{
  await service.deliver('1',1);assert.equal(sent.length,0);assert(updates.some(u=>u.sql.includes("state='skipped'")));
  live=true;await service.deliver('2',1);assert.equal(sent.length,1);
  throwStatus=503;await service.deliver('3',1);assert(updates.some(u=>u.values?.[0]==='3'&&u.values[1]==='pending'&&u.values[3]===15));
  await service.deliver('4',3);assert(updates.some(u=>u.values?.[0]==='4'&&u.values[1]==='failed'));
  throwStatus=410;await service.deliver('5',1);assert(updates.some(u=>u.sql.startsWith('DELETE FROM push_subscriptions')));
  throwStatus=0;service.stop();await service.deliver('6',1);assert.equal(sent.length,1);
  assert(!shouldRetryPush(400,1));assert(!shouldRetryPush(503,3));assert(shouldRetryPush(429,2));
 }finally{pool.query=original;}
});
test('service worker has no fetch/cache interception and revalidates queued pushes before showing',async()=>{
 const handlers={},shown=[],opened=[];let active=204;
 const self={location:{origin:'https://camera.example'},addEventListener:(k,f)=>handlers[k]=f,skipWaiting:()=>{},registration:{showNotification:async(...args)=>shown.push(args)},clients:{claim:async()=>{},matchAll:async()=>[],openWindow:async url=>opened.push(url)}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../web/public/push-sw.js'),'utf8'),{self,URL,AbortController,setTimeout,clearTimeout,fetch:async()=>({status:active})});
 assert(!handlers.fetch);let pending;const payload={version:1,title:'Test',url:'//evil.example/x',subscription_id:'00000000-0000-4000-8000-000000000001',silent:true};
 handlers.push({data:{json:()=>payload},waitUntil:p=>pending=p});await pending;assert.equal(shown.length,1);assert.equal(shown[0][1].silent,true);assert.equal(shown[0][1].data.url,'/notifications');
 active=401;handlers.push({data:{json:()=>payload},waitUntil:p=>pending=p});await pending;assert.equal(shown.length,1);
 handlers.notificationclick({notification:{data:{url:'https://evil.example/x'},close:()=>{}},waitUntil:p=>pending=p});await pending;assert(!opened[0].includes('evil.example'));
});
