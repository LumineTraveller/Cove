'use strict';
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const adapters=require('./source-adapters.cjs');
function configure(env){
  const stats=env.COVE_FULL_UI_STATS??'0';if(!['0','1'].includes(stats))throw Error('Invalid full App stats control');
  const voice=env.COVE_FULL_UI_VOICE??'muted';if(!['muted','synthetic-varying'].includes(voice))throw Error('Invalid full App voice control');
  const meterDiagnostic=env.COVE_FULL_UI_METER_TRANSITION_DIAGNOSTIC??'0';
  if(!['0','1'].includes(meterDiagnostic))throw Error('Invalid meter transition diagnostic control');
  const frameSink=env.COVE_FULL_UI_FRAME_SINK??'generator',codec=env.COVE_FULL_UI_CODEC??'av1';
  if(!['generator','worker'].includes(frameSink)||!['av1','vp8'].includes(codec))throw Error('Invalid full App sink/codec control');
  if(frameSink==='worker'&&!supportsWorkerFixture(fs.readFileSync(path.join(adapters.root,'apps/desktop/tests/ui/screen-performance.electron.cjs'),'utf8')))
    throw Error('This worktree fixture does not explicitly support the worker frame sink');
  const sample=env.COVE_FPS_SAMPLE_SECONDS??(meterDiagnostic==='1'?'24':'12'),warmup=env.COVE_FPS_WARMUP_MS??'5000';
  if(meterDiagnostic==='1'&&sample!=='24')throw Error('Meter transition diagnostic requires exactly 24 sample seconds');
  if(!/^\d+$/.test(sample)||Number(sample)<1||Number(sample)>30||!/^\d+$/.test(warmup)||Number(warmup)>30000)throw Error('Invalid bounded full App sample duration');
  for(const flag of ['COVE_FPS_BASELINE_FRAME_WRITER','COVE_FPS_MINIMIZE_SENDER','COVE_FPS_NATIVE_LIFECYCLE_CHECKS','COVE_FPS_RECOVERY_CHECKS','COVE_FPS_REPUBLISH_CHECKS','COVE_FPS_DEMAND_CHECKS','COVE_FPS_CONTENT_TRACE','COVE_FPS_GENERATED_NV12','COVE_FPS_DISABLE_RENDERER_BACKGROUNDING'])
    if(env[flag]==='1')throw Error('Full App baseline conflicts with '+flag);
  const fixed={COVE_FPS_RUNTIME_NAME:'fps-validation-full-ui-20261029',COVE_FPS_VISIBLE_PRESENTATION:'1',COVE_FPS_LOCAL_PREVIEW:'1',COVE_FPS_PRODUCT_SENDER_THROTTLING:'1',COVE_FPS_PEER_RENDER_MODE:'hidden',COVE_FPS_NATIVE_GPU:'1',COVE_FPS_CAPTURE_FEATURES:'ZeroCopyDesktopCapture',COVE_FPS_NATIVE_STORAGE:'gpu',COVE_FPS_NATIVE_PIXEL_FORMAT:'bgra',COVE_FPS_NATIVE_FRAME_SINK:frameSink,COVE_FPS_CASES:JSON.stringify([{source:'native',preset:'1080p',fps:120,game:true,captureTarget:'screen',compatibility:codec==='vp8',expectWidth:1728,expectHeight:1080,expectCodec:codec==='av1'?'video/AV1':'video/VP8'}]),COVE_FULL_UI_STATS:stats,COVE_FULL_UI_FRAME_SINK:frameSink,COVE_FULL_UI_CODEC:codec,COVE_FPS_LABEL:env.COVE_FPS_LABEL??'full-ui-baseline',COVE_FPS_SAMPLE_SECONDS:sample,COVE_FPS_WARMUP_MS:warmup};
  fixed.COVE_FULL_UI_VOICE=voice;
  fixed.COVE_FULL_UI_METER_TRANSITION_DIAGNOSTIC=meterDiagnostic;
  for(const [key,value] of Object.entries(fixed)){if(env[key]!==undefined&&!['COVE_FPS_LABEL','COVE_FPS_SAMPLE_SECONDS','COVE_FPS_WARMUP_MS','COVE_FULL_UI_STATS'].includes(key)&&env[key]!==value)throw Error('Full App requires fixed '+key);env[key]=value;}
  return fixed;
}
function supportsWorkerFixture(source){
  return [...source.matchAll(/\[[^\]\r\n]*\]\s*\.includes\(\s*nativeFrameSink\s*\)/g)]
    .some(([whitelist])=>/['"]worker['"]/.test(whitelist));
}
function prepare(){
  const original=fs.readFileSync(path.join(adapters.root,'apps/desktop/tests/ui/media-integration.tsx'),'utf8');
  fs.writeFileSync(path.join(__dirname,'observer.ts'),adapters.observedPrelude(original));
}
if(require.main===module){
  configure(process.env);prepare();
  const original=path.join(adapters.root,'tooling/verify-screen-performance.cjs');
  const entry=new Module(original,module);entry.filename=original;entry.paths=Module._nodeModulePaths(path.dirname(original));
  entry._compile(adapters.launcher(fs.readFileSync(original,'utf8')),original);
}
module.exports={configure,prepare,supportsWorkerFixture};
