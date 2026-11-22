const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const source=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/evidenceApi.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText;
test('simultaneous preview mounts share one HTTP request, then release the pending cache',async()=>{
 let calls=0,resolve;const exported={};vm.runInNewContext(source,{exports:exported,require:()=>({featureRequest:()=>{calls++;return new Promise(r=>resolve=r);}}),URLSearchParams,encodeURIComponent});
 const first=exported.evidenceApi.preview('event','1'),second=exported.evidenceApi.preview('event','1');assert.equal(first,second);assert.equal(calls,1);resolve({id:'fixture'});await first;await Promise.resolve();const third=exported.evidenceApi.preview('event','1');assert.notEqual(third,first);assert.equal(calls,2);resolve({id:'fixture'});await third;
});
test('failed preview requests release their key so an explicit retry can succeed',async()=>{
 let calls=0;const exported={};vm.runInNewContext(source,{exports:exported,require:()=>({featureRequest:()=>{calls++;return calls===1?Promise.reject(new Error('Unavailable')):Promise.resolve({id:'retry'});}}),URLSearchParams,encodeURIComponent});
 await assert.rejects(exported.evidenceApi.preview('notice','2'),/Unavailable/);await Promise.resolve();assert.equal((await exported.evidenceApi.preview('notice','2')).id,'retry');assert.equal(calls,2);
});
