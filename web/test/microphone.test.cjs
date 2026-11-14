const{test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),ts=require('typescript');
const script=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/microphone.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText;
function fixture({resume=()=>Promise.resolve(),media}={}){
 const state={closed:0,stopped:0,requests:0,nodes:[]},stream={getTracks:()=>[{stop:()=>state.stopped++}]};
 class Context{constructor(){this.state='running';this.audioWorklet={addModule:async()=>{}};this.destination={}}resume(){return resume()}createMediaStreamSource(){return{connect:()=>{},disconnect:()=>{}}}close(){state.closed++;this.state='closed';return Promise.resolve()}}
 class Worklet{constructor(){this.port={onmessage:null,close:()=>{}};state.nodes.push(this)}connect(){}disconnect(){}}
 const exports={},context={exports,require:()=>({DuplexPlayback:class{async start(){}stop(){state.playbackStopped=true}}}),AudioContext:Context,AudioWorkletNode:Worklet,ArrayBuffer,DOMException,window:{isSecureContext:true},navigator:{mediaDevices:{getUserMedia:()=>{state.requests++;return media?media(stream):Promise.resolve(stream)}}}};
 vm.runInNewContext(script,context);return{state,stream,mic:new exports.Microphone()};
}
test('releasing before resume prevents a microphone permission request',async()=>{
 let release;const f=fixture({resume:()=>new Promise(r=>release=r)}),pending=f.mic.start(()=>{});f.mic.stop();release();await assert.rejects(()=>pending,e=>e.name==='AbortError');assert.equal(f.state.requests,0);assert.equal(f.state.closed,1);
});
test('a microphone granted after release is stopped and never transmitted',async()=>{
 let grant;const f=fixture({media:stream=>new Promise(r=>grant=()=>r(stream))});let sent=0;const pending=f.mic.start(()=>sent++);await new Promise(r=>setImmediate(r));f.mic.stop();grant();await assert.rejects(()=>pending,e=>e.name==='AbortError');assert.equal(f.state.stopped,1);assert.equal(f.state.nodes.length,0);assert.equal(sent,0);
});
test('normal release stops tracks, audio graph and later worklet deliveries',async()=>{
 const f=fixture();let sent=0;await f.mic.start(()=>sent++);const node=f.state.nodes[0];node.port.onmessage({data:new ArrayBuffer(3200)});assert.equal(sent,1);const callback=node.port.onmessage;f.mic.stop();callback({data:new ArrayBuffer(3200)});assert.equal(sent,1);assert.equal(f.state.stopped,1);assert.equal(f.state.closed,1);assert.equal(node.port.onmessage,null);
});
