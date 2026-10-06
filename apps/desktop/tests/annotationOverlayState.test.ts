import assert from 'node:assert/strict';
import test from 'node:test';
import { validOverlayFrame } from '../electron/annotation-overlay-state';

const stroke = {id:'stroke',authorSocketId:'viewer',tool:'pen',color:'#3b82f6',width:0.01,
  points:[{x:0,y:0},{x:1,y:1}]};
test('local overlay accepts finite source coordinates and ordered eraser strokes', () => {
  assert.equal(validOverlayFrame({strokes:[stroke,{...stroke,tool:'eraser'}],lasers:[{x:.5,y:.5}]}),true);
});
test('local overlay rejects blackbar/invalid input and unbounded IPC payloads', () => {
  for (const patch of [{width:NaN},{width:.5},{color:'url(x)'},{points:[{x:-.1,y:.5}]},
    {points:[{x:.5,y:Infinity}]},{points:Array(2049).fill({x:.5,y:.5})}])
    assert.equal(validOverlayFrame({strokes:[{...stroke,...patch}],lasers:[]}),false);
  assert.equal(validOverlayFrame({strokes:[],lasers:[{x:1.01,y:0}]}),false);
  assert.equal(validOverlayFrame({strokes:Array(801).fill(stroke),lasers:[]}),false);
  assert.equal(validOverlayFrame({strokes:Array(17).fill({...stroke,points:Array(2048).fill({x:.5,y:.5})}),lasers:[]}),false);
});
