const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {EventThumbnailCache,EventImageMissing}=require('../dist/detections/thumbnails');

test('repeated requests share one render and reuse its private cache',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'camera-event-thumbs-'));
 try{
  const dir=path.join(root,'events/1/20261123');await fs.mkdir(dir,{recursive:true});
  const source=path.join(dir,'000001_123.jpg');await fs.writeFile(source,Buffer.alloc(128));
  let renders=0,finish;const gate=new Promise(resolve=>finish=resolve);
  const cache=new EventThumbnailCache(root,async(_,target)=>{renders++;await gate;await fs.writeFile(target,Buffer.alloc(64))});
  const first=cache.get('events/1/20261123/000001_123.jpg'),second=cache.get('events/1/20261123/000001_123.jpg');
  await new Promise(resolve=>setTimeout(resolve,30));finish();
  const files=await Promise.all([first,second]);assert.equal(renders,1);assert.equal(files[0],files[1]);
  assert.equal(await cache.get('events/1/20261123/000001_123.jpg'),files[0]);assert.equal(renders,1);
  assert.deepEqual((await fs.readdir(dir)).sort(),['000001_123.jpg','000001_123.thumb-v2.jpg']);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});

test('older low-resolution cache is replaced by a preview rendered from the original',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'camera-event-upgrade-'));
 try{
  const dir=path.join(root,'events/1/20261123');await fs.mkdir(dir,{recursive:true});
  const original=path.join(dir,'frame.jpg');await fs.writeFile(original,Buffer.alloc(128));
  await fs.writeFile(path.join(dir,'frame.thumb.jpg'),Buffer.alloc(32));
  let input;const cache=new EventThumbnailCache(root,async(source,target)=>{input=source;await fs.writeFile(target,Buffer.alloc(64))});
  const thumbnail=await cache.get('events/1/20261123/frame.jpg');
  assert.equal(input,await fs.realpath(original));assert.equal(thumbnail,path.join(await fs.realpath(dir),'frame.thumb-v2.jpg'));
  assert.equal((await fs.stat(original)).size,128);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});

test('paths outside events and symlinks to private files cannot be thumbnailed',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'camera-event-paths-'));
 try{
  const dir=path.join(root,'events/1/20261123');await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(root,'private.jpg'),Buffer.alloc(128));
  await fs.symlink(path.join(root,'private.jpg'),path.join(dir,'leak.jpg'));
  let rendered=false;const cache=new EventThumbnailCache(root,async()=>{rendered=true});
  for(const file of ['../private.jpg','events/../private.jpg','/private.jpg','events/1/20261123/leak.jpg','events/1/20261123/missing.jpg'])await assert.rejects(cache.get(file),EventImageMissing);
  assert.equal(rendered,false);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});

test('failed resize leaves the original usable and removes partial output',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'camera-event-failure-'));
 try{
  const dir=path.join(root,'events/1/20261123');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'frame.jpg'),Buffer.alloc(128));
  const cache=new EventThumbnailCache(root,async(_,temporary)=>{await fs.writeFile(temporary,Buffer.alloc(10));throw Error('codec fixture failure')});
  await assert.rejects(cache.get('events/1/20261123/frame.jpg'));
  assert.deepEqual(await fs.readdir(dir),['frame.jpg']);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});

test('many different snapshots never run more than two encoders at once',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'camera-event-limit-'));
 try{
  const dir=path.join(root,'events/1/20261123');await fs.mkdir(dir,{recursive:true});let active=0,peak=0;
  const cache=new EventThumbnailCache(root,async(_,temporary)=>{peak=Math.max(peak,++active);await new Promise(resolve=>setTimeout(resolve,10));await fs.writeFile(temporary,Buffer.alloc(64));active--});
  await Promise.all(Array.from({length:8},async(_,i)=>{const name=`frame_${i}.jpg`;await fs.writeFile(path.join(dir,name),Buffer.alloc(128));return cache.get('events/1/20261123/'+name)}));
  assert.equal(peak,2);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
