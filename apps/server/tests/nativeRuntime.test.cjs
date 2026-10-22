const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pinnedVersion, isWithin, assertPrivateModuleDirectory, assertCandidateModuleDirectory, createPlan, parseArguments } = require('../scripts/native-runtime.cjs');

test('native rebuild target follows the pinned server runtime, without npx or a shell', () => {
  const plan = createPlan();
  assert.equal(plan.electron, require('../package.json').devDependencies.electron);
  assert.equal(plan.command, process.execPath);
  assert.equal(plan.args[plan.args.indexOf('-t') + 1], plan.electron);
  assert.ok(plan.args[0].endsWith(path.join('prebuild-install', 'bin.js')));
  assert.doesNotMatch(require('../package.json').scripts['rebuild:native'], /npx|29\.4\.6|cd /);
});

test('runtime candidates are explicit, pinned and separate from the packaged manifest', () => {
  const candidate = createPlan({ candidate: true });
  assert.equal(candidate.electron, require('../../desktop/package.json').devDependencies.electron);
  assert.equal(require('../electron/runtime-candidate.json').status, 'candidate-not-activated');
  assert.notEqual(candidate.electron, createPlan().electron);
  for (const value of ['latest', '^44.0.0', '44.0.0-beta.1', '44.0', null]) assert.throws(() => pinnedVersion(value));
});

test('borrowed dependency directories cannot be rebuilt or mistaken for the checkout', () => {
  const root = path.resolve('checkout');
  const module = path.join(root, 'node_modules', 'better-sqlite3');
  const outside = path.resolve('checkout-other', 'node_modules', 'better-sqlite3');
  assert.equal(isWithin(root, outside), false);
  assert.throws(() => assertPrivateModuleDirectory(root, module, value => value === module ? outside : value), /Refusing to rebuild/);
  assert.equal(assertPrivateModuleDirectory(root, module, value => value), module);
});

test('runtime tool rejects missing and unknown arguments', () => {
  assert.deepEqual(parseArguments(['check', '--candidate', '--module-dir', 'private-module']), { command: 'check', candidate: true, moduleDirectory: 'private-module' });
  assert.throws(() => parseArguments(['check', '--electron']), /Missing value/);
  assert.throws(() => parseArguments(['check', '--install']), /Unknown argument/);
  assert.throws(() => createPlan({ moduleDirectory: path.resolve(__dirname, '..') }), /must contain better-sqlite3/);
  const probe = fs.readFileSync(path.join(__dirname, '../scripts/runtime-probe.cjs'), 'utf8');
  assert.doesNotMatch(probe, /require\([^\n]*(?:src\/index|dist\/index)|startServer\(/);
  assert.match(probe, /new Database\(':memory:'\)/);
});

test('candidate isolation checks physical paths, including a junction to this checkout node_modules', () => {
  const root = path.resolve('checkout');
  const runtime = path.join(root, 'runtime');
  const candidate = path.join(runtime, 'candidate', 'better-sqlite3');
  const live = path.join(root, 'node_modules', 'better-sqlite3');
  assert.equal(assertCandidateModuleDirectory(root, candidate, value => value), candidate);
  assert.throws(() => assertCandidateModuleDirectory(root, candidate, value => value === candidate ? live : value), /real isolated copy/);
  assert.throws(() => assertCandidateModuleDirectory(root, candidate, value => value === runtime ? root : value), /real isolated copy/);
});
