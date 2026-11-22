const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/PushSettings.tsx'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function support({https=true,ios=false,standalone=false,apis=true}={}){
 const window={isSecureContext:https,matchMedia:()=>({matches:standalone}),...(apis?{PushManager:function(){},Notification:{}}:{})},navigator={userAgent:ios?'iPhone':'Android WebView',maxTouchPoints:ios?5:1,...(apis?{serviceWorker:{}}:{})},exports_={};
 vm.runInNewContext(code,{exports:exports_,require:()=>({}),window,navigator,location:{protocol:https?'https:':'http:'}});return exports_.pushSupport();
}
test('push support uses HTTPS and feature detection without opening a permission prompt',()=>{
 assert.equal(support(),'');assert.match(support({https:false}),/HTTPS/);assert.match(support({apis:false}),/WebView/);
});
test('iOS explains Home Screen setup while standalone browsers with APIs can subscribe',()=>{
 assert.match(support({ios:true}),/16\.4/);assert.match(support({ios:true}),/Màn hình chính/);assert.equal(support({ios:true,standalone:true}),'');
});
