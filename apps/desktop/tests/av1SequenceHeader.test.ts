import assert from 'node:assert/strict';
import test from 'node:test';
import { createAv1SequenceHeaderRepeater } from '../src/features/media/screen/av1SequenceHeader';

const delimiter = [0x12, 0];
const initialSequence = [0x0a, 3, 1, 2, 3];
const nextSequence = [0x0a, 2, 4, 5];
const picture = [0x32, 2, 6, 7];
const scope = { synchronizationSource: 1234, payloadType: 101, width: 2560, height: 1600 };

function encodedFrame(
  bytes: number[],
  type: RTCEncodedVideoFrame['type'] = 'key',
  metadata: RTCEncodedVideoFrameMetadata = scope,
) {
  return { data: Uint8Array.from(bytes).buffer, type, getMetadata: () => metadata };
}

test('subsequent AV1 keyframes repeat the first sequence header after the delimiter', () => {
  const repeat = createAv1SequenceHeaderRepeater();
  const first = encodedFrame([...delimiter, ...initialSequence, ...picture]);
  const original = first.data;
  repeat(first);
  assert.equal(first.data, original);
  new Uint8Array(first.data).fill(0); // The later frame must use an owned copy.

  const delta = encodedFrame([...delimiter, ...picture], 'delta');
  const deltaData = delta.data;
  repeat(delta);
  assert.equal(delta.data, deltaData);

  const key = encodedFrame([...delimiter, ...picture]);
  repeat(key);
  assert.deepEqual(Array.from(new Uint8Array(key.data)), [...delimiter, ...initialSequence, ...picture]);
});

test('a resized or replaced AV1 stream needs its own sequence header', () => {
  const repeat = createAv1SequenceHeaderRepeater();
  repeat(encodedFrame([...initialSequence, ...picture]));
  const resized = { ...scope, width: 1728, height: 1080 };
  const missing = encodedFrame(picture, 'key', resized);
  const original = missing.data;
  repeat(missing);
  assert.equal(missing.data, original);

  repeat(encodedFrame([...delimiter, ...nextSequence, ...picture], 'key', resized));
  repeat(missing);
  assert.deepEqual(Array.from(new Uint8Array(missing.data)), [...nextSequence, ...picture]);
});

test('an existing sequence is kept and replaces the cached configuration', () => {
  const repeat = createAv1SequenceHeaderRepeater();
  repeat(encodedFrame([...initialSequence, ...picture]));
  const withSequence = encodedFrame([...delimiter, ...nextSequence, ...picture]);
  const original = withSequence.data;
  repeat(withSequence);
  assert.equal(withSequence.data, original);

  const later = encodedFrame([...delimiter, ...picture]);
  repeat(later);
  assert.deepEqual(Array.from(new Uint8Array(later.data)), [...delimiter, ...nextSequence, ...picture]);
});

test('keyframes place the sequence header before leading metadata for RTP startup', () => {
  const metadata = [0x2a, 0x06, 0x01, 0x00, 0x64, 0x00, 0x32, 0x80];
  for (const prefix of [[], delimiter]) {
    const repeat = createAv1SequenceHeaderRepeater();
    const frame = encodedFrame([...prefix, ...metadata, ...initialSequence, ...picture]);
    repeat(frame);
    assert.deepEqual([...new Uint8Array(frame.data)], [...prefix, ...initialSequence, ...metadata, ...picture]);
    const later = encodedFrame([...prefix, ...metadata, ...picture]);
    repeat(later);
    assert.deepEqual([...new Uint8Array(later.data)], [...prefix, ...initialSequence, ...metadata, ...picture]);
  }
});

test('truncated OBUs and frames without a known sequence pass unchanged', () => {
  const repeat = createAv1SequenceHeaderRepeater();
  const uninitialized = encodedFrame(picture);
  const initialData = uninitialized.data;
  repeat(uninitialized);
  assert.equal(uninitialized.data, initialData);

  repeat(encodedFrame([...initialSequence, ...picture]));
  for (const bytes of [[0x0a, 0x80], [0x32, 4, 1], [0x14], [0x8a, 1, 0], delimiter]) {
    const invalid = encodedFrame(bytes);
    const original = invalid.data;
    repeat(invalid);
    assert.equal(invalid.data, original);
  }
});

test('a sequence-only OBU without a size is length-delimited before prepending it to a picture', () => {
  const repeat = createAv1SequenceHeaderRepeater();
  const sequence = encodedFrame([0x08, 1, 2, 3]);
  repeat(sequence);
  assert.deepEqual([...new Uint8Array(sequence.data)], [0x08, 1, 2, 3]);
  const next = encodedFrame([...delimiter, ...picture]);
  repeat(next);
  assert.deepEqual([...new Uint8Array(next.data)], [...delimiter, ...initialSequence, ...picture]);
});

test('a configuration delivered in a delta frame initializes the next keyframe', () => {
  const repeat = createAv1SequenceHeaderRepeater();
  const firstKey = encodedFrame([...delimiter, ...picture]);
  assert.equal(repeat(firstKey)?.action, 'missing-sequence');
  const configuration = encodedFrame([...delimiter, ...initialSequence], 'delta');
  const original = configuration.data;
  assert.equal(repeat(configuration)?.action, 'configuration-only');
  assert.equal(configuration.data, original);
  const nextKey = encodedFrame([...delimiter, ...picture]);
  assert.equal(repeat(nextKey)?.action, 'repeated');
  assert.deepEqual([...new Uint8Array(nextKey.data)], [...delimiter, ...initialSequence, ...picture]);
});

test('a genuine sequence after a picture is moved to the front for WebRTC packetization', () => {
  const repeat = createAv1SequenceHeaderRepeater();
  const trailing = encodedFrame([...delimiter, ...picture, 0x08, 1, 2, 3]);
  assert.equal(repeat(trailing)?.action, 'reordered');
  assert.deepEqual([...new Uint8Array(trailing.data)], [...delimiter, ...initialSequence, ...picture]);
});

test('a sequence in a later temporal unit does not initialize the previous picture', () => {
  const repeat = createAv1SequenceHeaderRepeater();
  const frame = encodedFrame([...delimiter, ...picture, ...delimiter, ...initialSequence, ...picture]);
  const original = frame.data;
  assert.equal(repeat(frame)?.action, 'missing-sequence');
  assert.equal(frame.data, original);
});
