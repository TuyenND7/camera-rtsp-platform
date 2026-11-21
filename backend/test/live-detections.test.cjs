const {test}=require('node:test'),assert=require('node:assert/strict'),{sanitizeLiveDetections,filterLiveOverlay,isOverlaySettingsValid}=require('../dist/detections/live');
const now=1700000000000,frame={at:now-3000,width:640,height:360,detections:[{label:'person',confidence:.9,box:[-10,-20,700,400]}]},state={version:1,camera_id:3,updated_at:now,state:'ready',synchronized:true,frames:[frame]};
test('response supplies server clock without trusting worker clock metadata',()=>{assert.equal(sanitizeLiveDetections({...state,server_time:now+3600000},3,2,now).server_time,now)});
test('Live visibility and class choices preserve tracking data and event snapshots',()=>{
 const detections=['person','cat','dog'].map((label,i)=>({label,confidence:.9,box:[5,10,120,200],track_id:`c3-012345abcdef-${i+1}`,track_number:i+1}));
 const original=sanitizeLiveDetections({...state,frames:[{...frame,detections}]},3,2,now);
 assert.deepEqual(filterLiveOverlay(original,{}),original);
 for(const settings of [{ai_overlay_enabled:false},{ai_overlay_labels:[]}]){
  const hidden=filterLiveOverlay(original,settings);assert.equal(hidden.state,'hidden');assert.deepEqual(hidden.frames,[]);
 }
 const selected=filterLiveOverlay(original,{ai_overlay_enabled:true,ai_overlay_labels:['cat']});
 assert.deepEqual(selected.frames[0].detections,[detections[1]]);
 assert.equal(selected.frames[0].at,frame.at);
 assert.deepEqual(original.frames[0].detections,detections);
 assert.deepEqual(filterLiveOverlay(original,{ai_overlay_enabled:true,ai_overlay_labels:['person','cat','dog']}).frames[0].detections,detections);
});
test('overlay settings accept off and empty selection, reject unknown or duplicate classes',()=>{
 for(const [enabled,selected] of [[undefined,undefined],[false,[]],[true,['person','cat','dog']]])assert(isOverlaySettingsValid(enabled,selected));
 for(const [enabled,selected] of [[null,[]],['false',[]],[true,null],[true,'cat'],[true,['cat','cat']],[true,['unknown']],[true,[1]]])assert(!isOverlaySettingsValid(enabled,selected));
});
test('only well-formed camera-local tracking IDs reach Live; old detections still work',()=>{
 const tracked={label:'person',confidence:.9,box:[1,2,100,200],track_id:'c3-012345abcdef-7',track_number:7};
 const sanitize=patch=>sanitizeLiveDetections({...state,frames:[{...frame,detections:[{...tracked,...patch}]}]},3,2,now).frames[0].detections[0];
 assert.deepEqual(sanitize({}),tracked);
 for(const patch of [{track_id:'c2-012345abcdef-7'},{track_number:8},{track_number:-1},{track_number:1.5},{track_id:'<script>'},{track_id:undefined}]){
  const result=sanitize(patch);assert.equal(result.track_id,undefined);assert.equal(result.track_number,undefined);assert.equal(result.label,'person');
 }
});
test('cat and dog detections reach Live with the same validation as people',()=>{const detections=['cat','dog','person'].map(label=>({label,confidence:.85,box:[5,10,120,200]}));const result=sanitizeLiveDetections({...state,frames:[{...frame,detections}]},3,2,now);assert.deepEqual(result.frames[0].detections,detections);assert.deepEqual(sanitizeLiveDetections({...state,frames:[{...frame,detections:[{label:'dog',confidence:2,box:[5,10,120,200]}]}]},3,2,now).frames[0].detections,[])});
test('only recent matching-camera data is exposed; invalid boxes and private fields removed',()=>{const value=sanitizeLiveDetections({...state,password:'private-fixture',frames:[{...frame,detections:[...frame.detections,{label:'person',confidence:NaN,box:[1,1,20,20]},{label:'unknown',confidence:.9,box:[1,1,20,20]},{label:'person',confidence:.9,box:[30,20,10,10]}]}]},3,2,now);assert.deepEqual(value.frames[0].detections,[{label:'person',confidence:.9,box:[0,0,640,360]}]);assert(!JSON.stringify(value).includes('private-fixture'))});
test('stale, future, wrong camera and unsynchronized external RTSP cannot become Live boxes',()=>{for(const patch of [{updated_at:now-13000},{updated_at:now+4000},{camera_id:2},{synchronized:false}])assert.equal(sanitizeLiveDetections({...state,...patch},3,2,now).frames.length,0);assert.equal(sanitizeLiveDetections({...state,frames:[{...frame,at:now-31000}]},3,2,now).frames.length,0)});
