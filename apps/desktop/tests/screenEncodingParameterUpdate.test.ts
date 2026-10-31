import test from 'node:test';
import assert from 'node:assert/strict';

import { createScreenEncodingPlan } from '../src/features/media/screen/screenCapture';
import {
  updateScreenEncodingParametersIfNeeded,
  type ScreenEncodingParameterUpdate,
} from '../src/features/media/screen/screenEncodingParameterUpdate';

const activePlan = createScreenEncodingPlan({
  preset: '1080p',
  maxFps: 120,
  activity: 'active',
  sourceWidth: 3840,
  sourceHeight: 2160,
});
const motionPlan = createScreenEncodingPlan({
  preset: '1080p',
  maxFps: 120,
  activity: 'motion',
  sourceWidth: 3840,
  sourceHeight: 2160,
});

function matchingParameters(): RTCRtpSendParameters {
  return {
    transactionId: 'screen-transaction',
    codecs: [],
    headerExtensions: [],
    rtcp: { cname: 'screen-sender' },
    degradationPreference: 'maintain-resolution',
    encodings: [
      { rid: 'first', active: false, maxBitrate: 200_000_000, maxFramerate: 120, scaleResolutionDownBy: 2 },
      { rid: 'second', active: true, maxBitrate: 200_000_000, maxFramerate: 120, scaleResolutionDownBy: 2 },
    ],
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = () => resolvePromise();
    reject = (reason) => rejectPromise(reason);
  });
  return { promise, resolve, reject };
}

function completion(update: ScreenEncodingParameterUpdate): Promise<void> {
  assert.equal(update.status, 'submitted');
  if (update.status !== 'submitted') throw new Error('Expected a submitted update');
  return update.completion;
}

test('matching sender parameters are skipped, with one read and no cached snapshot', async () => {
  let parameters = matchingParameters();
  let reads = 0;
  const submissions: RTCRtpSendParameters[] = [];
  const sender = {
    getParameters: () => { reads += 1; return parameters; },
    setParameters: (next: RTCRtpSendParameters) => { submissions.push(next); return Promise.resolve(); },
  };

  assert.equal(updateScreenEncodingParametersIfNeeded(sender, activePlan).status, 'unchanged');
  assert.equal(reads, 1);
  assert.equal(submissions.length, 0);

  // A later external change must be detected from the sender's actual parameters.
  parameters = matchingParameters();
  parameters.encodings[1].maxFramerate = 15;
  await completion(updateScreenEncodingParametersIfNeeded(sender, activePlan));
  assert.equal(reads, 2);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].encodings[1].maxFramerate, 120);
});

test('every controlled field is compared and unrelated parameters are preserved', async (t) => {
  const cases: Array<[string, (parameters: RTCRtpSendParameters) => void]> = [
    ['degradation preference', (parameters) => { parameters.degradationPreference = 'maintain-framerate'; }],
    ['maximum bitrate', (parameters) => { parameters.encodings[1].maxBitrate = 10_000_000; }],
    ['maximum frame rate', (parameters) => { parameters.encodings[1].maxFramerate = 60; }],
    ['resolution scale', (parameters) => { parameters.encodings[1].scaleResolutionDownBy = 1; }],
  ];

  for (const [name, change] of cases) {
    await t.test(name, async () => {
      const parameters = matchingParameters();
      change(parameters);
      const before = structuredClone(parameters);
      const submissions: RTCRtpSendParameters[] = [];
      let reads = 0;
      const sender = {
        getParameters: () => { reads += 1; return parameters; },
        setParameters: (next: RTCRtpSendParameters) => { submissions.push(next); return Promise.resolve(); },
      };

      await completion(updateScreenEncodingParametersIfNeeded(sender, activePlan));
      assert.equal(reads, 1);
      assert.equal(submissions.length, 1);
      const sent = submissions[0];
      assert.notEqual(sent, parameters);
      assert.equal(sent.transactionId, parameters.transactionId);
      assert.equal(sent.codecs, parameters.codecs);
      assert.equal(sent.headerExtensions, parameters.headerExtensions);
      assert.equal(sent.rtcp, parameters.rtcp);
      assert.equal(sent.degradationPreference, 'maintain-resolution');
      assert.deepEqual(sent.encodings.map(({ rid, active }) => ({ rid, active })), [
        { rid: 'first', active: false },
        { rid: 'second', active: true },
      ]);
      for (const encoding of sent.encodings) {
        assert.equal(encoding.maxBitrate, 200_000_000);
        assert.equal(encoding.maxFramerate, 120);
        assert.equal(encoding.scaleResolutionDownBy, 2);
      }
      assert.deepEqual(parameters, before, 'the sender snapshot is not mutated');
    });
  }
});

test('an empty encoding list is submitted because its settings cannot be verified', async () => {
  const parameters = matchingParameters();
  parameters.encodings = [];
  let submissions = 0;
  const sender = {
    getParameters: () => parameters,
    setParameters: () => { submissions += 1; return Promise.resolve(); },
  };

  await completion(updateScreenEncodingParametersIfNeeded(sender, activePlan));
  assert.equal(submissions, 1);
});

test('a pending update on another sender does not prevent skipping a matching sender', async () => {
  const oldSubmission = deferred();
  const first = {
    getParameters: matchingParameters,
    setParameters: () => oldSubmission.promise,
  };
  let secondSubmissions = 0;
  const second = {
    getParameters: matchingParameters,
    setParameters: () => { secondSubmissions += 1; return Promise.resolve(); },
  };

  const firstCompletion = completion(updateScreenEncodingParametersIfNeeded(first, motionPlan));
  assert.equal(updateScreenEncodingParametersIfNeeded(second, activePlan).status, 'unchanged');
  assert.equal(secondSubmissions, 0);
  oldSubmission.resolve();
  await firstCompletion;
});

test('matching snapshots still submit until every prior update on that sender settles', async () => {
  const pending = [deferred(), deferred(), deferred(), deferred()];
  const submissions: RTCRtpSendParameters[] = [];
  const sender = {
    getParameters: matchingParameters,
    setParameters: (next: RTCRtpSendParameters) => {
      submissions.push(next);
      return pending[submissions.length - 1].promise;
    },
  };

  const first = completion(updateScreenEncodingParametersIfNeeded(sender, motionPlan));
  assert.equal(submissions[0].degradationPreference, 'maintain-framerate');
  const second = completion(updateScreenEncodingParametersIfNeeded(sender, activePlan));
  assert.equal(submissions[1].degradationPreference, 'maintain-resolution');

  pending[0].resolve();
  await first;
  const third = completion(updateScreenEncodingParametersIfNeeded(sender, activePlan));
  const failure = new Error('second update failed');
  const rejected = assert.rejects(second, (error) => error === failure);
  pending[1].reject(failure);
  await rejected;
  const fourth = completion(updateScreenEncodingParametersIfNeeded(sender, activePlan));
  assert.equal(submissions.length, 4);

  pending[2].resolve();
  pending[3].resolve();
  await Promise.all([third, fourth]);
  assert.equal(updateScreenEncodingParametersIfNeeded(sender, activePlan).status, 'unchanged');
});

test('a rejected update releases its in-flight count and preserves the rejection', async () => {
  let parameters = matchingParameters();
  parameters.encodings[0].maxFramerate = 15;
  const pending = deferred();
  let submissions = 0;
  const sender = {
    getParameters: () => parameters,
    setParameters: () => { submissions += 1; return pending.promise; },
  };

  const result = completion(updateScreenEncodingParametersIfNeeded(sender, activePlan));
  parameters = matchingParameters();
  const failure = new Error('setParameters rejected');
  const rejected = assert.rejects(result, (error) => error === failure);
  pending.reject(failure);
  await rejected;
  assert.equal(updateScreenEncodingParametersIfNeeded(sender, activePlan).status, 'unchanged');
  assert.equal(submissions, 1);
});

test('a synchronous setParameters throw releases its count and remains catchable', () => {
  let parameters = matchingParameters();
  parameters.encodings[0].maxFramerate = 15;
  const failure = new Error('setParameters threw');
  let submissions = 0;
  const sender = {
    getParameters: () => parameters,
    setParameters: (): Promise<void> => { submissions += 1; throw failure; },
  };

  assert.throws(() => updateScreenEncodingParametersIfNeeded(sender, activePlan), (error) => error === failure);
  parameters = matchingParameters();
  assert.equal(updateScreenEncodingParametersIfNeeded(sender, activePlan).status, 'unchanged');
  assert.equal(submissions, 1);
});

test('a reentrant call observes the submission before setParameters returns', async () => {
  let nested: ScreenEncodingParameterUpdate | undefined;
  let submissions = 0;
  const sender = {
    getParameters: matchingParameters,
    setParameters: (): Promise<void> => {
      submissions += 1;
      if (submissions === 1) nested = updateScreenEncodingParametersIfNeeded(sender, activePlan);
      return Promise.resolve();
    },
  };

  const outer = updateScreenEncodingParametersIfNeeded(sender, motionPlan);
  assert.ok(nested);
  await Promise.all([completion(outer), completion(nested)]);
  assert.equal(submissions, 2);
  assert.equal(updateScreenEncodingParametersIfNeeded(sender, activePlan).status, 'unchanged');
});
