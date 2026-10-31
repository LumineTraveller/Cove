'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { selectedModes, inside, patternHtml, extractOwnedPattern } = require('../tooling/verify-native-capture.cjs');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const fixturePath = path.join(__dirname, '../apps/desktop/tests/ui/screen-performance.electron.cjs');

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

test('owned canvas extraction uses the same central layout for LF and CRLF', () => {
  const original = fs.readFileSync(fixturePath, 'utf8');
  const lf = original.replace(/\r\n/g, '\n');
  const crlf = lf.replace(/\n/g, '\r\n');
  const html = extractOwnedPattern(lf);
  assert.equal(extractOwnedPattern(crlf), html);
  assert.equal(patternHtml(), html);
  assert.ok(html.includes('x.fillRect(384+bit*72,432,72,108)'));
  assert.ok(!html.includes('${') && !html.includes('sourceAgeRing') && !html.includes('sourceFrozen'));
  const script = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script[1]));
});

test('owned canvas extraction rejects missing, duplicate and unexpected source expressions', () => {
  const input = fs.readFileSync(fixturePath, 'utf8');
  const sourceLine = input.split(/\r?\n/).find(line => line.includes('const source=generatedNv12Enabled?'));
  assert.ok(sourceLine);
  assert.throws(() => extractOwnedPattern(input.replace('window.sourceFrames=frames', 'window.changed=frames')), /not found uniquely/);
  assert.throws(() => extractOwnedPattern(`${input}\n${sourceLine}`), /not found uniquely/);
  assert.throws(() => extractOwnedPattern(input.replace('const source=generatedNv12Enabled?', 'const source=otherFlag?')), /Unexpected owned source structure/);
  assert.throws(() => extractOwnedPattern(input.replace('${sourceAgeDraw}', '${process.exit()}')), /Unexpected owned source interpolation/);
  assert.throws(() => extractOwnedPattern(input.replace('${patternBits.top*1080}', '${patternBits.top*720}')), /Unexpected owned source interpolation/);
});
