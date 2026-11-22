const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { pool } = require('../dist/db');
const { signToken } = require('../dist/auth');
const { surveillanceDefaults, validSurveillanceConfig, publicNotice, publicPin } = require('../dist/detections/surveillance');
const { default: routes, cameraSurveillanceRouter } = require('../dist/routes/surveillance');
const live = require('../dist/detections/live');
const zone = { id:'corner',name:'Góc sân',points:[[.5,.5],[1,.5],[1,1],[.5,1]] };
let server, base, original, originalConnect, originalRead, calls=[], config={...surveillanceDefaults}, stale=false;
const admin = signToken({sub:1,username:'fixture',role:'admin'}), viewer = signToken({sub:2,username:'fixture',role:'viewer'});
const headers = token => ({Authorization:'Bearer '+token,'Content-Type':'application/json'});
before(async () => {
  original=pool.query; originalConnect=pool.connect; originalRead=live.readLiveDetections;
  pool.query=async (sql,params=[]) => {
    if(sql.startsWith('SELECT u.id'))return {rows:[{id:params[1],username:'fixture',role:params[1]===2?'viewer':'admin'}]};
    calls.push({sql,params});
    if(sql.startsWith('SELECT id, name FROM identified_people'))return {rows:[]};
    if(sql.startsWith('SELECT ai_surveillance'))return {rows:[{ai_surveillance:config}]};
    if(sql.startsWith('UPDATE cameras SET ai_surveillance')){config=JSON.parse(params[0]);return {rows:[{ai_surveillance:config}]};}
    if(sql.startsWith('SELECT id,status,enabled'))return {rows:[{id:3,status:'online',enabled:true,ai_enabled:true,ai_fps:2,ai_surveillance:config}]};
    if(sql.includes('AS unread_count'))return {rows:[{unread_count:0,latest_id:'0'}]};
    return {rows:[]};
  };
  live.readLiveDetections=async()=>({frames:stale?[]:[{at:Date.now(),detections:[{track_id:'c3-abcdef123456-1',track_number:1,label:'person',box:[0,0,10,10]}]}]});
  const app=express();app.use(express.json());app.use('/cameras/:id/surveillance',cameraSurveillanceRouter);app.use('/surveillance',routes);
  server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{pool.query=original;pool.connect=originalConnect;live.readLiveDetections=originalRead;server.closeAllConnections();await new Promise(r=>server.close(r));});
test('regions reject out-of-image, self crossing, tiny polygons, duplicates and enabled-empty policy',()=>{
  assert(validSurveillanceConfig({...surveillanceDefaults,zones_enabled:true,zones:[zone]}));
  assert(validSurveillanceConfig({...surveillanceDefaults,zones_enabled:true,zones:[{...zone,points:[[.1,.1],[.15,.1],[.15,.15],[.1,.15]]}]}));
  for(const patch of [
    {zones_enabled:true,zones:[]}, {auto_pin_enabled:'yes'}, {alarm_enabled:true}, {loitering_seconds:0},
    {zones:[zone,zone]}, {zones:[{...zone,points:[[0,0],[1,1],[1,0],[0,1]]}]},
    {zones:[{...zone,points:[[0,0],[.01,0],[.01,.01],[0,.01]]}]},
    {zones:[{...zone,points:[[0,0],[2,0],[2,1],[0,1]]}]},
  ])assert(!validSurveillanceConfig({...surveillanceDefaults,...patch}),JSON.stringify(patch));
});
test('notification/pin reads require a session; configuration and pin writes require admin',async()=>{
  for(const path of ['/cameras/3/surveillance','/surveillance/notifications','/surveillance/pins','/surveillance/notifications/1/thumbnail'])assert.equal((await fetch(base+path)).status,401);
  for(const [path,method] of [['/cameras/3/surveillance','GET'],['/cameras/3/surveillance','PUT'],['/surveillance/pins','POST'],['/surveillance/pins/123','DELETE']])assert.equal((await fetch(base+path,{method,headers:headers(viewer)})).status,403);
});
test('configuration persists with no video restart, no hardware command and valid empty-zone disable',async()=>{
  const value={...surveillanceDefaults,zones_enabled:true,zones:[zone],intrusion_enabled:true};
  const res=await fetch(base+'/cameras/3/surveillance',{method:'PUT',headers:headers(admin),body:JSON.stringify(value)});
  assert.equal(res.status,200);assert.deepEqual(await res.json(),value);
  assert.equal((await fetch(base+'/cameras/3/surveillance',{headers:headers(admin)})).status,200);
  const invalid=await fetch(base+'/cameras/3/surveillance',{method:'PUT',headers:headers(admin),body:JSON.stringify({...value,zones:[]})});assert.equal(invalid.status,400);
  assert.equal((await fetch(base+'/cameras/3/surveillance',{method:'PUT',headers:headers(admin),body:JSON.stringify({...value,zones:[],zones_enabled:false})})).status,200);
});
test('bounded cursors and read markers are per user; after pages are ascending to retain bursts',async()=>{
  for(const query of ['limit=10000','before=bad','before=1&after=2','kind=alarm','unread=maybe'])assert.equal((await fetch(base+'/surveillance/notifications?'+query,{headers:headers(admin)})).status,400);
  calls=[];assert.equal((await fetch(base+'/surveillance/notifications?after=10',{headers:headers(viewer)})).status,200);
  const sql=calls.find(c=>c.sql.includes('ORDER BY n.id'));
  assert(sql.sql.includes('ASC'));assert.deepEqual(sql.params,[2,'10',50]);
  assert.equal((await fetch(base+'/surveillance/notifications/read',{method:'POST',headers:headers(viewer),body:JSON.stringify({ids:['1','2']})})).status,200);
  const mark=calls.find(c=>c.sql.startsWith('INSERT INTO surveillance_notification_reads'));
  assert.deepEqual(mark.params,[2,['1','2']]);
  for(const body of [{all:'true'},{ids:['0']},{ids:Array(101).fill('1')},{all:true,ids:['1']}])assert.equal((await fetch(base+'/surveillance/notifications/read',{method:'POST',headers:headers(admin),body:JSON.stringify(body)})).status,400);
});
test('a stale or disabled manual target never becomes pinned',async()=>{
  const body={camera_id:3,track_id:'c3-abcdef123456-1',track_number:1,label:'person'};
  config={...surveillanceDefaults,manual_pin_enabled:false};
  assert.equal((await fetch(base+'/surveillance/pins',{method:'POST',headers:headers(admin),body:JSON.stringify(body)})).status,409);
  config={...surveillanceDefaults};stale=true;
  assert.equal((await fetch(base+'/surveillance/pins',{method:'POST',headers:headers(admin),body:JSON.stringify(body)})).status,409);
  assert.equal((await fetch(base+'/surveillance/pins',{method:'POST',headers:headers(admin),body:JSON.stringify({...body,track_id:'c2-abcdef123456-1'})})).status,400);
});
test('public notifications and pins never expose raw identities or credential fields',()=>{
  const row={id:'1',camera_id:3,camera_name:'Fixture',track_id:'c3-abcdef123456-1',identity:{state:'known',person_id:'00000000-0000-4000-8000-000000000001',name:'Injected',embedding:[1]},rtsp_url:'private',last_seen_at:new Date(),status:'online',enabled:true,ai_enabled:true};
  const notice=publicNotice(row,new Map()),pin=publicPin(row,new Map());
  assert.deepEqual(notice.identity,{state:'unmatched'});assert.equal(pin.state,'tracking');
  const text=JSON.stringify([notice,pin]);for(const hidden of ['Injected','embedding','private'])assert(!text.includes(hidden));
  assert.equal(publicPin({...row,last_seen_at:new Date(Date.now()-21000)},new Map()).state,'lost');
  assert.equal(publicPin({...row,status:'error'},new Map()).state,'lost');
});
