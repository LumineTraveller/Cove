'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildPlan, runPlan } = require('../tooling/ci-regression.cjs');
const { smokeClientIdentity } = require('../tooling/smoke-client-identity.cjs');
const { CLIENT_PROTOCOL_VERSION, CLIENT_RELEASE_VERSIONS, CLIENT_MINIMUM_VERSIONS, isSupportedClientVersion } = require('@cove/contracts');

test('runtime smoke REST, socket and registration identities satisfy the current shared version gate', () => {
  for (const platform of ['desktop', 'mobile']) {
    const identity = smokeClientIdentity(platform);
    assert.equal(identity.headers['x-cove-client-protocol'], String(CLIENT_PROTOCOL_VERSION));
    assert.equal(identity.auth.clientProtocol, CLIENT_PROTOCOL_VERSION);
    assert.equal(identity.auth.clientPlatform, platform);
    assert.equal(identity.registration.platform, platform);
    assert.equal(identity.headers['x-cove-client-version'], CLIENT_RELEASE_VERSIONS[platform]);
    assert.equal(identity.registration.clientVersion, identity.auth.clientVersion);
    assert.equal(isSupportedClientVersion(identity.auth.clientVersion, CLIENT_MINIMUM_VERSIONS[platform]), true);
  }
  assert.throws(() => smokeClientIdentity('unknown'), /Unsupported/);
});

test('desktop tests keep their JSX config and per-file process isolation', () => {
  const steps = buildPlan('desktop');
  const tests = steps.find(step => step.name.startsWith('desktop TS'));
  assert.equal(tests.cwd, 'apps/desktop');
  assert.ok(tests.args.includes('tests/connectionDeadline.test.ts'));
  assert.ok(tests.args.includes('tests/voiceConnectionRecovery.test.ts'));
  assert.equal(tests.args.includes('--test-isolation=none'), false);
  assert.ok(steps.findIndex(step => step.name.includes('electron/tsconfig.json build')) < steps.indexOf(tests));
});

test('server gates include native and recovery integration plus real runtime smoke', () => {
  const steps = buildPlan('server');
  const tests = steps.find(step => step.cwd === 'apps/server' && step.args.includes('--test'));
  for (const name of ['connectionRecovery', 'mediaNativeIntegration', 'roomIntegration', 'mobileRemoteControlRecovery'])
    assert.ok(tests.args.includes(`tests/${name}.test.ts`), name);
  assert.ok(steps.some(step => step.cwd === 'apps/server' && step.args.includes('tests/nativeRuntime.test.cjs')));
  assert.deepEqual(steps.at(-1).args, ['tooling/runtime-smoke.cjs']);
});

test('mobile logic tests use mobile Jest without packaging or device installation', () => {
  const steps = buildPlan('mobile');
  assert.equal(steps.at(-1).cwd, 'apps/mobile');
  assert.ok(steps.at(-1).args.includes('--runInBand'));
  assert.equal(steps.some(step => step.args.some(arg => /^(?:assemble|--?publish|adb(?:\.exe)?$|install$|rebuild$)/.test(arg))), false);
  assert.throws(() => buildPlan('release'), /Expected one suite/);
});

test('a failed gate stops later tests and subprocesses are hidden and bounded', t => {
  t.mock.method(console, 'log', () => {});
  const calls = [];
  assert.throws(() => runPlan([
    { name: 'failed compile', cwd: '.', args: ['fixture.cjs'] },
    { name: 'must not run', cwd: '.', args: ['other.cjs'] },
  ], (executable, args, options) => {
    calls.push({ executable, args, options });
    return { status: 1 };
  }), /failed compile failed: exit 1/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.ok(calls[0].options.timeout > 0);
});

test('ordinary PR/main workflow is read-only, cancellable and runs every declared suite', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/regression.yml'), 'utf8');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 3);
  assert.equal((workflow.match(/node-version: 24/g) ?? []).length, 3);
  for (const suite of ['server', 'desktop', 'mobile']) assert.ok(workflow.includes(`node tooling/ci-regression.cjs ${suite}`));
  assert.doesNotMatch(workflow, /pull_request_target|secrets\.|contents: write|gh release|--publish/);
});
