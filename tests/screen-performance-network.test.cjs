'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const fixtureExports={};
const source=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../apps/desktop/tests/ui/screen-performance-fixture.ts'),'utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS},
}).outputText;
vm.runInNewContext(source,{exports:fixtureExports,require:name=>{
  if(name==='./screen-performance-pattern-layouts.json')return require('../apps/desktop/tests/ui/screen-performance-pattern-layouts.json');
  assert.match(name,/nativeScreenCapture$/);return {};
},performance:{now:()=>0},URLSearchParams});
const observe=entries=>JSON.parse(JSON.stringify(fixtureExports.screenPerformanceNetworkSnapshot(new Map(entries.map(stat=>[stat.id,stat])))));

test('network observation selects the transport pair and copies only safe finite aggregates',()=>{
  const report=[
    {type:'transport',id:'secret-transport',selectedCandidatePairId:'secret-selected',dtlsState:'connected',sdp:'private-sdp'},
    {type:'local-candidate',id:'secret-local',protocol:'tcp',address:'192.0.2.9',port:1234,url:'turn:private'},
    {type:'candidate-pair',id:'secret-other',state:'waiting',nominated:false,bytesSent:0},
    {type:'candidate-pair',id:'secret-selected',localCandidateId:'secret-local',remoteCandidateId:'private-remote',
      state:'succeeded',nominated:true,currentRoundTripTime:.004,totalRoundTripTime:.4,responsesReceived:100,
      availableOutgoingBitrate:8e6,availableIncomingBitrate:9e6,bytesSent:1000,bytesReceived:2000,
      packetsSent:10,packetsReceived:20,requestsSent:2,responsesSent:3,packetsDiscardedOnSend:0,bytesDiscardedOnSend:0,
      token:'private-token',address:'192.0.2.8',url:'https://private.invalid'},
  ];
  const before=structuredClone(report),result=observe(report);
  assert.deepEqual(result.candidatePairs,[
    {selected:true,currentRoundTripTime:.004,totalRoundTripTime:.4,responsesReceived:100,
      availableOutgoingBitrate:8e6,availableIncomingBitrate:9e6,bytesSent:1000,bytesReceived:2000,
      packetsSent:10,packetsReceived:20,requestsSent:2,responsesSent:3,packetsDiscardedOnSend:0,bytesDiscardedOnSend:0,
      protocol:'tcp',nominated:true,state:'succeeded'},
    {selected:false,bytesSent:0,nominated:false,state:'waiting'},
  ]);
  assert.equal(result.candidatePairsTruncated,false);assert.deepEqual(report,before);
  assert.doesNotMatch(JSON.stringify(result),/secret|private|192\.0\.2|1234|sdp|CandidateId/);
});

test('remote inbound includes video only, supports local video correlation and signed packet loss',()=>{
  const result=observe([
    {type:'outbound-rtp',id:'video-out',kind:'video'},
    {type:'outbound-rtp',id:'audio-out',kind:'audio'},
    {type:'remote-inbound-rtp',id:'video-remote',kind:'video',roundTripTime:.02,totalRoundTripTime:.4,
      roundTripTimeMeasurements:20,fractionLost:.01,packetsLost:2,packetsReceived:1000,jitter:.003,reportsReceived:20,
      localId:'video-out',remoteId:'secret-remote',ssrc:777777},
    {type:'remote-inbound-rtp',id:'inferred-video',localId:'video-out',packetsLost:-2,roundTripTime:0},
    {type:'remote-inbound-rtp',id:'audio-remote',kind:'audio',localId:'video-out',roundTripTime:99},
    {type:'remote-inbound-rtp',id:'inferred-audio',localId:'audio-out',roundTripTime:99},
    {type:'remote-inbound-rtp',id:'unknown',localId:'absent',roundTripTime:99},
  ]);
  assert.deepEqual(result.remoteInboundVideo,[
    {roundTripTime:.02,totalRoundTripTime:.4,roundTripTimeMeasurements:20,fractionLost:.01,
      packetsReceived:1000,jitter:.003,reportsReceived:20,packetsLost:2},
    {roundTripTime:0,packetsLost:-2},
  ]);
  assert.equal(result.remoteInboundVideoCount,2);assert.equal(result.remoteInboundVideoTruncated,false);
  assert.doesNotMatch(JSON.stringify(result),/video-out|audio-out|secret|ssrc|777777/);
});

test('network arrays are capped at eight, prioritize selected pairs and report truncation',()=>{
  const entries=Array.from({length:20},(_,index)=>({type:'candidate-pair',id:`pair-${index}`,state:'succeeded',bytesSent:index}));
  entries.push({type:'transport',id:'transport',selectedCandidatePairId:'pair-19'});
  entries.push(...Array.from({length:12},(_,index)=>({type:'remote-inbound-rtp',id:`remote-${index}`,kind:'video',roundTripTime:index})));
  const result=observe(entries);
  assert.equal(result.candidatePairs.length,8);assert.equal(result.remoteInboundVideo.length,8);
  assert.equal(result.candidatePairs[0].selected,true);assert.equal(result.candidatePairs[0].bytesSent,19);
  assert.equal(result.candidatePairCount,20);assert.equal(result.remoteInboundVideoCount,12);
  assert.equal(result.candidatePairsTruncated,true);assert.equal(result.remoteInboundVideoTruncated,true);
  assert.equal(result.limitPerType,8);
});

test('invalid metrics and private strings are omitted, canonical selection and zero metrics remain',()=>{
  const result=observe([
    {type:'candidate-pair',id:'pair',selected:true,nominated:'private',state:'private-state',
      currentRoundTripTime:NaN,totalRoundTripTime:Infinity,bytesSent:-1,bytesReceived:'private-bytes',
      availableOutgoingBitrate:0,packetsSent:0},
    {type:'remote-inbound-rtp',id:'remote',kind:'video',roundTripTime:-1,jitter:NaN,fractionLost:'private-loss',packetsLost:1.5},
  ]);
  assert.deepEqual(result.candidatePairs,[{selected:true,availableOutgoingBitrate:0,packetsSent:0}]);
  assert.deepEqual(result.remoteInboundVideo,[{}]);assert.doesNotMatch(JSON.stringify(result),/private/);
});

test('an empty report has a detached fixed bounded shape',()=>{
  const a=observe([]),b=observe([]);a.candidatePairs.push({private:'not live'});
  assert.deepEqual(b,{candidatePairs:[],remoteInboundVideo:[],candidatePairCount:0,remoteInboundVideoCount:0,
    limitPerType:8,candidatePairsTruncated:false,remoteInboundVideoTruncated:false});
});

test('network observations reuse the same existing stats result without an extra RTC query',()=>{
  const fixture=fs.readFileSync(path.join(__dirname,'../apps/desktop/tests/ui/screen-performance-fixture.ts'),'utf8');
  const snapshot=fixture.slice(fixture.indexOf('const connections = await Promise.all'),fixture.indexOf('const reports =',fixture.indexOf('const connections = await Promise.all')));
  assert.equal((snapshot.match(/connection\.getStats\(/g)||[]).length,1);
  assert.match(snapshot,/network: screenPerformanceNetworkSnapshot\(report\)/);
  assert.doesNotMatch(snapshot,/getRemoteCertificates|getLocalCandidates|getRemoteCandidates/);
});
