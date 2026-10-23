'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validatePerformanceCases}=require('../tooling/screen-performance-config.cjs');
const base={source:'native',preset:'540p',fps:120};

test('comparison dimensions are optional or complete finite positive integer pairs',()=>{
  assert.doesNotThrow(()=>validatePerformanceCases([base]));
  assert.doesNotThrow(()=>validatePerformanceCases([{...base,expectCaptureWidth:1000,expectCaptureHeight:624,
    expectEncodedWidth:865,expectEncodedHeight:540,expectCodec:'video/AV1'}]));
  for(const [width,height] of [['expectWidth','expectHeight'],['expectCaptureWidth','expectCaptureHeight'],
    ['expectEncodedWidth','expectEncodedHeight']]){
    assert.throws(()=>validatePerformanceCases([{...base,[width]:864}]));
    assert.throws(()=>validatePerformanceCases([{...base,[height]:540}]));
    for(const invalid of [0,-1,NaN,Infinity,1.5,'864',8193,null])
      assert.throws(()=>validatePerformanceCases([{...base,[width]:invalid,[height]:540}]));
  }
});

test('invalid sources, unbounded cases and unrecognized codecs are rejected',()=>{
  for(const cases of [null,[],Array(13).fill(base),[{...base,source:'personal'}],
    [{...base,expectCodec:'video/fake'}]])assert.throws(()=>validatePerformanceCases(cases));
});
