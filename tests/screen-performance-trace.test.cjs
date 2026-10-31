'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const { TRACE_CATEGORIES, captureTraceOptions, sanitizeCaptureTrace, analyzeCaptureTrace, cleanupOwnedTraceExports } = require('../tooling/analyze-screen-performance-trace.cjs');
test('trace config includes only reviewed categories and explicitly owned processes', () => {
  const options = captureTraceOptions([12, 34, 12], [...TRACE_CATEGORIES, 'netlog', 'disabled-by-default-devtools.screenshot']);
  assert.deepEqual(options.included_process_ids, [12, 34]);
  assert.deepEqual(options.included_categories, TRACE_CATEGORIES);
  assert.equal(options.enable_argument_filter, true); assert.equal(options.trace_buffer_size_in_kb, 32768);
  assert.ok(!options.included_categories.includes('toplevel'));assert.ok(!options.included_categories.includes('viz'));
  assert.throws(() => captureTraceOptions([], TRACE_CATEGORIES));
  assert.throws(() => captureTraceOptions([12], ['netlog']));
});
test('post-exit export audit sanitizes complete late raw and removes only recognized owned exporter temps',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cove-trace-export-test-'));
  try{
    fs.writeFileSync(path.join(directory,'capture-trace.raw.json'),JSON.stringify({traceEvents:[{ph:'X',pid:12,tid:2,cat:'media',name:'ConvertAndScale',ts:1,dur:2,args:{secret:'late-secret'}}]}));
    fs.writeFileSync(path.join(directory,'11111111-1111-1111-1111-111111111111.tmp'),'{"traceEvents":[');
    fs.writeFileSync(path.join(directory,'unrelated.tmp'),'keep');
    const result=cleanupOwnedTraceExports(directory,[12]);
    assert.equal(result.rawFileRetained,false);assert.equal(result.records.length,2);
    assert.ok(result.records.every(record=>record.removed));
    assert.ok(!fs.readFileSync(path.join(directory,'capture-trace-recovered.json'),'utf8').includes('late-secret'));
    assert.equal(fs.readFileSync(path.join(directory,'unrelated.tmp'),'utf8'),'keep');
  }finally{for(const name of fs.readdirSync(directory))fs.unlinkSync(path.join(directory,name));fs.rmdirSync(directory);}
});
test('sanitization removes every event argument and arbitrary metadata', () => {
  const trace = sanitizeCaptureTrace({metadata:{secret:'secret-token'},traceEvents:[
    {ph:'M',pid:12,tid:2,name:'thread_name',args:{name:'CaptureThread',secret:'secret-token'}},
    {ph:'X',pid:12,tid:2,cat:'media',name:'ConvertAndScale',ts:1,dur:3,args:{sdp:'private-sdp',url:'http://localhost?token=secret-token'}},
  ]});
  assert.equal(trace.threadNames['12:2'], 'CaptureThread');
  assert.ok(trace.traceEvents.every(event => !Object.hasOwn(event, 'args')));
  assert.ok(!JSON.stringify(trace).includes('secret-token')); assert.ok(!JSON.stringify(trace).includes('private-sdp'));
});
test('analysis avoids nested thread CPU double counting and keeps async lifetimes separate', () => {
  const trace={threadNames:{'12:2':'CaptureThread'},traceEvents:[
    {ph:'i',pid:12,tid:2,cat:'disabled-by-default-video_and_image_capture',name:'UsingDesktopCapturer',ts:0},
    {ph:'X',pid:12,tid:2,cat:'webrtc',name:'CaptureFrame',ts:0,dur:10000,tts:0,tdur:4000},
    {ph:'X',pid:12,tid:2,cat:'media',name:'ConvertAndScale',ts:1000,dur:3000,tts:1000,tdur:2000},
    {ph:'b',pid:12,tid:2,cat:'gpu.capture',name:'Capture',ts:0,id:'1'},
    {ph:'e',pid:12,tid:3,cat:'gpu.capture',name:'Capture',ts:20000,id:'1'},
  ]};
  const result=analyzeCaptureTrace(trace);
  assert.equal(result.capturePathMarkers[0].name,'UsingDesktopCapturer');
  assert.equal(result.threads.find(thread=>thread.tid===2).recordedThreadCpuUnionMs,4);
  assert.equal(result.captureAndTaskSlices.find(group=>group.kind==='async-lifetime').inclusiveThreadCpuMs,null);
  assert.equal(analyzeCaptureTrace({traceEvents:[{ph:'X',pid:1,tid:1,cat:'media',name:'ConvertAndScale',ts:0,dur:5}]}).threads[0].recordedThreadCpuUnionMs,null);
});

test('native lambda capture analysis requires the named thread and unions nested known CPU', () => {
  const result = analyzeCaptureTrace({ threadNames: { '1:2': 'desktopCaptureThread' }, traceEvents: [
    { ph: 'X', pid: 1, tid: 2, cat: 'webrtc', name: 'operator()', ts: 0, dur: 8000, tts: 0, tdur: 5000 },
    { ph: 'X', pid: 1, tid: 2, cat: 'webrtc', name: 'operator()', ts: 500, dur: 5000, tts: 500, tdur: 3500 },
    { ph: 'X', pid: 1, tid: 2, cat: 'media', name: 'ConvertAndScale', ts: 1000, dur: 2000, tts: 1000, tdur: 2000 },
    { ph: 'X', pid: 1, tid: 2, cat: 'media', name: 'VideoCaptureDeviceClient::OnIncomingCapturedBufferExt', ts: 500, dur: 4000, tts: 500, tdur: 3000 },
    { ph: 'X', pid: 9, tid: 2, cat: 'webrtc', name: 'operator()', ts: 0, dur: 100000, tts: 0, tdur: 99999 },
  ] }).nativeCaptureSegments;
  assert.equal(result.count, 1);
  assert.equal(result.summary.threadCpuMs.mean, 5);
  assert.equal(result.summary.elapsedMinusThreadCpuMs.mean, 3);
  assert.equal(result.summary.residualThreadCpuMs.mean, 2);
});
