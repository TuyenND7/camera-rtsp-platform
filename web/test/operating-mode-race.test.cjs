const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/OperatingProfilesSettings.tsx'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};},snapshot=mode=>({settings:{control:'manual'},runtime:{mode}}),settle=()=>new Promise(r=>setImmediate(r));
function harness(api){
 const states=[],refs=[],effects=[];let stateIndex=0,refIndex=0,effectIndex=0,poll;
 const events=new Map(),react={useState:initial=>{const i=stateIndex++;if(!(i in states))states[i]=initial;return[states[i],v=>states[i]=typeof v==='function'?v(states[i]):v];},useRef:initial=>refs[refIndex++]??(refs[refIndex-1]={current:initial}),useEffect:callback=>{const i=effectIndex++;if(!effects[i])effects[i]=callback;}};
 const exports_={};vm.runInNewContext(code,{exports:exports_,require:name=>name==='react'?react:name==='react/jsx-runtime'?{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})}:name==='./operationsApi'?{operationsApi:api,profileNames:{manual:'Theo camera',home:'Ở nhà',away:'Vắng nhà',night:'Ban đêm'}}:{},document:{hidden:false},window:{addEventListener:(k,f)=>events.set(k,f),removeEventListener:k=>events.delete(k),dispatchEvent:e=>events.get(e.type)?.()},Event:class{constructor(type){this.type=type;}},setInterval:f=>(poll=f,1),clearInterval:()=>{}});
 return{states,effects,render:()=>{stateIndex=refIndex=effectIndex=0;return exports_.OperatingModeSelector({compact:true});},poll:()=>poll(),select:tree=>tree.props.children.find(c=>c&&c.type==='select')};
}
test('a delayed polling GET cannot overwrite a successfully selected newer mode',async()=>{
 const first=deferred(),oldPoll=deferred(),post=deferred();let reads=0;
 const h=harness({profiles:()=>++reads===1?first.promise:oldPoll.promise,selectMode:()=>post.promise});h.render();const cleanup=h.effects[0]();
 first.resolve(snapshot('home'));await settle();const tree=h.render();h.poll();h.select(tree).props.onChange({target:{value:'away'}});
 post.resolve(snapshot('away'));await settle();assert.equal(h.states[0].runtime.mode,'away');oldPoll.resolve(snapshot('home'));await settle();assert.equal(h.states[0].runtime.mode,'away');cleanup();
});
test('StrictMode cleanup invalidates the old read while the remounted effect can load immediately',async()=>{
 const first=deferred(),second=deferred();let reads=0;const h=harness({profiles:()=>++reads===1?first.promise:second.promise});h.render();const cleanup=h.effects[0]();cleanup();const finalCleanup=h.effects[0]();
 assert.equal(reads,2);first.resolve(snapshot('home'));second.resolve(snapshot('night'));await settle();assert.equal(h.states[0].runtime.mode,'night');finalCleanup();
});
