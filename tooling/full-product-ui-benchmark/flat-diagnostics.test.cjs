'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {configure}=require('./run.cjs'),adapters=require('./source-adapters.cjs');
const read=file=>fs.readFileSync(path.join(adapters.root,file),'utf8');

test('flat diagnostics is explicit, default-off and only adds a filter control to the fixed motion workload',()=>{
  const normal={};configure(normal);assert.equal(normal.COVE_FULL_UI_FLAT_DIAGNOSTICS,'0');
  for(const value of ['',true,1,'true','yes'])assert.throws(()=>configure({COVE_FULL_UI_MOTION_SWITCH:'1',COVE_FULL_UI_FLAT_DIAGNOSTICS:value}));
  for(const change of [{COVE_FULL_UI_MOTION_SWITCH:'0'},{COVE_FULL_UI_STATS:'0'},
    {COVE_FULL_UI_VOICE:'synthetic-varying'},{COVE_FULL_UI_METER_TRANSITION_DIAGNOSTIC:'1'}])
    assert.throws(()=>configure({COVE_FULL_UI_MOTION_SWITCH:'1',COVE_FULL_UI_FLAT_DIAGNOSTICS:'1',...change}));
  const baseline={COVE_FULL_UI_MOTION_SWITCH:'1'},candidate={...baseline,COVE_FULL_UI_FLAT_DIAGNOSTICS:'1'};
  configure(baseline);configure(candidate);
  for(const key of Object.keys(baseline))if(key!=='COVE_FULL_UI_FLAT_DIAGNOSTICS')assert.equal(candidate[key],baseline[key],key);
  assert.equal(candidate.COVE_FPS_SAMPLE_SECONDS,'192');assert.equal(candidate.COVE_FULL_UI_KEEP_CAPTURE_ACTIVE,'0');
});

test('flat fixture changes only its scoped backdrop filter and removes the style idempotently',()=>{
  let style=null,created=0,removed=0;
  const overlay={};
  const document={createElement(tag){assert.equal(tag,'style');created++;return {textContent:'',isConnected:false,
    remove(){this.isConnected=false;style=null;removed++;}};},head:{appendChild(node){node.isConnected=true;style=node;}},
    querySelectorAll(selector){assert.equal(selector,'.cove-shell .diagnostics-v2');return [overlay];}};
  const module={exports:{}};
  const source=require('typescript').transpileModule(read('tooling/full-product-ui-benchmark/flat-diagnostics.ts'),
    {compilerOptions:{module:require('typescript').ModuleKind.CommonJS,target:require('typescript').ScriptTarget.ES2020}}).outputText;
  vm.runInNewContext(source,{module,exports:module.exports,document,getComputedStyle:node=>{
    assert.equal(node,overlay);return {backdropFilter:style?'none':'blur(18px) saturate(1.18)'};}});
  const {installFlatDiagnostics,flatDiagnosticsRule}=module.exports;
  assert.equal(flatDiagnosticsRule,'.cove-shell .diagnostics-v2{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}');
  const baseline=installFlatDiagnostics(false);assert.equal(created,0);assert.equal(baseline.snapshot().backdropFilters[0],baseline.snapshot().expectedBackdropFilter);
  baseline.dispose();assert.equal(removed,0);
  const candidate=installFlatDiagnostics(true);assert.equal(created,1);assert.equal(candidate.snapshot().styleMounted,true);
  assert.equal(candidate.snapshot().overlayCount,1);assert.equal(candidate.snapshot().backdropFilters[0],'none');
  assert.equal(candidate.snapshot().expectedBackdropFilter,'none');candidate.dispose();candidate.dispose();
  assert.equal(removed,1);assert.equal(candidate.snapshot().styleMounted,false);assert.equal(candidate.snapshot().disposed,true);
  assert.equal(candidate.snapshot().overlayCount,0);
});

test('actual style guards reject mismatched switch, baseline filter, extra overlays and leaked control',()=>{
  const adapted=adapters.electron(read('apps/desktop/tests/ui/screen-performance.electron.cjs'));
  assert.doesNotThrow(()=>new vm.Script(adapted));
  const code=adapted.match(/if\(fullUiStats\)\{for\(const sample of \[send,receive\]\)\{const d=sample.fullProductUi\?\.flatDiagnostics,[^\n]+?\}\}/)?.[0];
  assert.ok(code);
  const evidence=enabled=>({enabled,diagnosticOnly:enabled,disposed:false,styleMounted:enabled,
    expectedBackdropFilter:enabled?'none':'blur(18px) saturate(1.18)',overlayCount:1,
    backdropFilters:[enabled?'none':'blur(18px) saturate(1.18)']});
  for(const enabled of [false,true]){
    const run=d=>vm.runInNewContext(code,{fullUiStats:true,fullUiFlatDiagnostics:enabled,
      send:{fullProductUi:{flatDiagnostics:d}},receive:{fullProductUi:{flatDiagnostics:evidence(enabled)}}});
    assert.doesNotThrow(()=>run(evidence(enabled)));
    for(const change of [{enabled:!enabled},{diagnosticOnly:!enabled},{disposed:true},{styleMounted:!enabled},
      {overlayCount:0},{overlayCount:2},{expectedBackdropFilter:'other'},{backdropFilters:['blur(2px)']},{backdropFilters:['none','none']}])
      assert.throws(()=>run({...evidence(enabled),...change}),/Fixed flat diagnostics style contract was lost/);
  }
  assert.match(adapted,/fullUiFlatDiagnostics\?pane.backdropFilter!=='none':!pane.backdropFilter.includes\('blur\('\)/);
  for(const marker of ["pane.videoObjectFit!=='contain'",'pane.overlayMounted!==fullUiStats','pane.overlayPosition!==\'absolute\'',
    'renderer.fixture?.flatDiagnostics?.disposed===true','renderer.fixture?.flatDiagnostics?.styleMounted===false'])assert.ok(adapted.includes(marker),marker);
  const launcher=adapters.launcher(read('tooling/verify-screen-performance.cjs'));
  assert.match(launcher,/flatDiagnostics:\{enabled:process.env.COVE_FULL_UI_FLAT_DIAGNOSTICS==='1'/);
  assert.ok(launcher.includes("fs.readdirSync(path.join(root,'tooling/full-product-ui-benchmark'))"));
});
