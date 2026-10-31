'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { selectedModes, inside, patternHtml } = require('../tooling/verify-native-capture.cjs');
const path = require('node:path');

test('native diagnostic modes are explicit, bounded and preserve requested repeat order', () => {
  assert.deepEqual(selectedModes(), ['acquire-only', 'readback', 'readback-copy']);
  const modes = ['readback-copy', 'gpu-scaled-readback-copy', 'gpu-scaled-readback-copy', 'readback-copy'];
  assert.deepEqual(selectedModes(modes.join(',')), modes);
  for (const value of ['screen', 'readback,', ' readback', Array(7).fill('readback').join(',')])
    assert.throws(() => selectedModes(value));
});

test('native launcher uses the existing deterministic owned pattern and a descendant runtime', () => {
  const html = patternHtml();
  assert.ok(html.includes('window.sourceFrames=frames'));
  assert.ok(html.includes('bit<16'));
  const parent = path.resolve('runtime-owned-test');
  assert.ok(inside(parent, path.join(parent, 'probe.exe')));
  assert.ok(!inside(parent, parent));
  assert.ok(!inside(parent, path.resolve(parent, '../other/probe.exe')));
});
