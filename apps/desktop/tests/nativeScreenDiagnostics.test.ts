import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeScreenFailureReason, nativeScreenStartDiagnostic } from '../electron/native-screen-capture-diagnostics';

test('native failure codes retain known failures and exclude arbitrary backend text', () => {
  for (const code of ['source_ineligible', 'invalid_protocol', 'helper_unavailable', 'untrusted_sender'])
    assert.equal(nativeScreenFailureReason(code), code);
  for (const value of [null, undefined, {}, 123, 'token=private', 'source_ineligible\nprivate'])
    assert.equal(nativeScreenFailureReason(value), 'unknown_failure');
});

test('start response diagnoses a prior sticky failure without exposing controller internals', () => {
  const summary = { disabled: true, failureCode: 'import_failed', started: 1, stopped: 1,
    activeSessions: 0, frames: 2, transferredFrames: 0, sourceId: 'private', token: 'private' };
  const result = nativeScreenStartDiagnostic({ ok: false, reason: 'unavailable' }, summary);
  assert.deepEqual(result, { status: 'rejected', reason: 'unavailable', disabledAfterFailure: true,
    controllerFailureReason: 'import_failed', started: 1, stopped: 1, activeSessions: 0, frames: 2,
    transferredFrames: 0 });
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('ready diagnostics omit stale response reasons and validate counters', () => {
  const result = nativeScreenStartDiagnostic({ ok: true, reason: 'private' }, {
    disabled: false, failureCode: null, started: 1, stopped: NaN, activeSessions: -1,
    frames: Infinity, transferredFrames: 1.5 });
  assert.equal(result.reason, null);
  assert.equal(result.controllerFailureReason, null);
  assert.equal(result.started, 1);
  assert.equal(result.stopped, null);
  assert.equal(result.activeSessions, null);
  assert.equal(result.frames, null);
  assert.equal(result.transferredFrames, null);
});
