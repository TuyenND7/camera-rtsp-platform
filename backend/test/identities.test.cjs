const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),express=require('express');
const {pool}=require('../dist/db'),{signToken}=require('../dist/auth'),route=require('../dist/routes/identities').default;
const {faceIdentity,validEmbedding,validName}=require('../dist/identities');
let original,server,base;
before(async()=>{original=pool.query;pool.query=async(sql,params)=>{if(sql.startsWith('SELECT u.id'))return {rows:[{id:1,username:'fixture',role:params[1]===2?'viewer':'admin'}]};throw Error('Unexpected database query')};const app=express();app.use(express.json());app.use('/identities',route);server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port});
after(async()=>{pool.query=original;server.closeAllConnections();await new Promise(r=>server.close(r))});
test('biometric APIs, images and enrollment jobs require administrator access',async()=>{
 const viewer=signToken({sub:2,username:'fixture',role:'viewer'});
 for(const [path,method] of [['','GET'],['/analyze','POST'],['/jobs/invalid','GET'],['/jobs/invalid/faces/0','GET'],['/samples/invalid','GET'],['/enroll','POST'],['/invalid','PUT'],['/invalid','DELETE']]){
  assert.equal((await fetch(base+'/identities'+path,{method})).status,401);
  assert.equal((await fetch(base+'/identities'+path,{method,headers:{Authorization:'Bearer '+viewer}})).status,403);
 }
});
test('invalid job IDs, traversal and invalid enrollments fail without reading files or writing DB',async()=>{
 const token=signToken({sub:1,username:'fixture',role:'admin'}),headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
 for(const path of ['/jobs/invalid','/jobs/invalid/faces/0','/samples/invalid'])assert.equal((await fetch(base+'/identities'+path,{headers})).status,400);
 for(const body of [{},{job_id:'../private',face_id:'../../../config',name:'A'},{job_id:'invalid',face_id:'0',name:''}])assert.equal((await fetch(base+'/identities/enroll',{method:'POST',headers,body:JSON.stringify(body)})).status,400);
});
test('only active registered IDs supply names; worker names and private vectors are discarded',()=>{
 const id='05606d47-8556-4b1a-95b0-c00628359924',people=new Map([[id,'Ông A']]);
 assert.deepEqual(faceIdentity({state:'known',person_id:id,name:'Injected',embedding:[1]},people),{state:'known',person_id:id,name:'Ông A'});
 assert.deepEqual(faceIdentity({state:'known',person_id:id},new Map()),{state:'unmatched'});
 assert.equal(faceIdentity({state:'other'},people),undefined);
 assert.deepEqual(faceIdentity({state:'not_visible',person_id:id,name:'A'},people),{state:'not_visible'});
 assert(validName('Ông A'));assert(!validName(' '));assert(!validName('a\nadmin'));assert(!validName('a'.repeat(61)));
 assert(validEmbedding([1,...Array(127).fill(0)]));
 for(const value of [[],Array(128).fill(0),Array(128).fill(1),[NaN,...Array(127).fill(0)]])assert(!validEmbedding(value));
});
