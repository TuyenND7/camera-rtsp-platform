const {test}=require('node:test'),assert=require('node:assert/strict');
const {defaultProfileSettings,validateProfileSettings,resolveProfile}=require('../dist/operations/profiles');
const schedule=(id,days,start,end,mode='night')=>({id,days,start,end,mode});
test('manual defaults leave all camera settings and continuous recording unchanged',()=>{
 const settings=defaultProfileSettings(),runtime=resolveProfile(settings,new Date('2026-11-23T00:00:00Z'));
 assert.equal(runtime.mode,'manual');assert.deepEqual(runtime.camera_overrides,{});assert.equal(runtime.notifications_enabled,true);
 settings.profiles.away.cameras['3']={intrusion_enabled:true,popup_enabled:false};settings.profiles.away.notifications_enabled=false;settings.manual_mode='away';
 const active=resolveProfile(validateProfileSettings(settings));assert.deepEqual(active.camera_overrides,{'3':{intrusion_enabled:true,popup_enabled:false}});assert.equal(active.notifications_enabled,false);
 for(const forbidden of ['record','enabled','rtsp_url','zones','ai_enabled']){const bad=defaultProfileSettings();bad.profiles.home.cameras['1']={[forbidden]:true};assert.throws(()=>validateProfileSettings(bad));}
});
test('overnight windows belong to their starting day, end exclusively and wrap the week',()=>{
 const settings=defaultProfileSettings();settings.control='schedule';settings.timezone='UTC';settings.schedules=[schedule('night',[6],'22:00','07:00')];
 assert.equal(resolveProfile(settings,new Date('2026-11-21T23:00:00Z')).mode,'night');
 assert.equal(resolveProfile(settings,new Date('2026-11-22T06:59:00Z')).mode,'night');
 assert.equal(resolveProfile(settings,new Date('2026-11-22T07:00:00Z')).mode,'manual');
 assert.equal(resolveProfile(settings,new Date('2026-11-22T23:00:00Z')).mode,'manual');
 settings.schedules.push(schedule('overlap',[0],'06:30','08:00','home'));assert.throws(()=>validateProfileSettings(settings),/trùng/);
 settings.schedules[1].start='07:00';assert(validateProfileSettings(settings));
});
test('DST repeats evaluate both instants; spring gaps resume at the first matching wall-clock minute',()=>{
 const settings=defaultProfileSettings();settings.control='schedule';settings.timezone='America/New_York';settings.schedules=[schedule('fall',[0],'01:00','02:00')];
 for(const at of ['2026-11-01T05:30:00Z','2026-11-01T06:30:00Z'])assert.equal(resolveProfile(settings,new Date(at)).mode,'night');
 assert.equal(resolveProfile(settings,new Date('2026-11-01T07:00:00Z')).mode,'manual');
 settings.schedules=[schedule('spring',[0],'02:30','04:00')];assert.equal(resolveProfile(settings,new Date('2026-03-08T06:59:00Z')).mode,'manual');
 assert.equal(resolveProfile(settings,new Date('2026-03-08T07:00:00Z')).mode,'night');assert.equal(resolveProfile(settings,new Date('2026-03-08T08:00:00Z')).mode,'manual');
});
test('ambiguous full-day windows, overlap, duplicate IDs, invalid weekdays/timezones and unknown fields are rejected',()=>{
 for(const change of [s=>s.timezone='Invalid/Timezone',s=>s.schedules=[schedule('bad',[1],'07:00','07:00')],s=>s.schedules=[schedule('bad',[8],'07:00','08:00')],s=>s.schedules=[schedule('same',[1],'07:00','08:00'),schedule('same',[2],'07:00','08:00')],s=>s.automatic_alarm=true]){
  const settings=defaultProfileSettings();change(settings);assert.throws(()=>validateProfileSettings(settings));
 }
});
