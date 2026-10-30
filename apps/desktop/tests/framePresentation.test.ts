import test from 'node:test';
import assert from 'node:assert/strict';
import { bindFramePresentation, readFramePresentation } from '../src/features/media/diagnostics/framePresentation';

class CountedEvents extends EventTarget {
  listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    if (listener) {
      const bucket = this.listeners.get(type) ?? new Set();
      bucket.add(listener); this.listeners.set(type, bucket);
    }
    super.addEventListener(type, listener, options);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
    if (listener) this.listeners.get(type)?.delete(listener);
    super.removeEventListener(type, listener, options);
  }
  count() { return [...this.listeners.values()].reduce((total, bucket) => total + bucket.size, 0); }
}
class Track extends CountedEvents {
  readyState: 'live' | 'ended' = 'live';
  stopCalls = 0;
  stop() { this.stopCalls++; }
  end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
  mediaTrack() { return this as unknown as MediaStreamTrack; }
}
class Stream extends CountedEvents {
  constructor(public tracks: Track[]) { super(); }
  getVideoTracks() { return this.tracks.map(track => track.mediaTrack()); }
  mediaStream() { return this as unknown as MediaStream; }
}
class OwnerDocument extends CountedEvents {
  hidden = false;
  pictureInPictureElement: Video | null = null;
}
class Video extends CountedEvents {
  paused = false;
  ended = false;
  plays = 0;
  pauses = 0;
  nextCallback = 0;
  callbacks = new Map<number, VideoFrameRequestCallback>();
  cancelled: number[] = [];
  constructor(public ownerDocument: OwnerDocument, public srcObject: MediaStream) { super(); }
  requestVideoFrameCallback(callback: VideoFrameRequestCallback) {
    const id = ++this.nextCallback; this.callbacks.set(id, callback); return id;
  }
  cancelVideoFrameCallback(id: number) { this.cancelled.push(id); this.callbacks.delete(id); }
  play() { this.plays++; return Promise.resolve(); }
  pause() { this.pauses++; }
  element() { return this as unknown as HTMLVideoElement; }
  frame(timestamp: number, count: number, now: number) {
    const callbacks = [...this.callbacks.values()]; this.callbacks.clear();
    for (const callback of callbacks) callback(now, { presentationTime: timestamp, presentedFrames: count } as VideoFrameCallbackMetadata);
  }
}
function setup(t: any) {
  let now = 0;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'performance', previous);
    else delete (globalThis as any).performance;
  });
  const track = new Track(), stream = new Stream([track]), doc = new OwnerDocument();
  const video = new Video(doc, stream.mediaStream());
  const stop = bindFramePresentation(video.element(), stream.mediaStream());
  t.after(stop);
  const frame = (timestamp: number, count: number, observed = timestamp) => {
    now = observed; video.frame(timestamp, count, observed);
  };
  const fill = (offset = 0, frameOffset = 0) => {
    for (let index = 0; index <= 100; index++) frame(offset + index * 10, frameOffset + index + 1);
  };
  return { track, stream, doc, video, stop, frame, fill,
    read: () => readFramePresentation(track.mediaTrack(), now), setNow: (value: number) => { now = value; } };
}

test('presentation uses compositor timestamps, not delayed main-thread callback times', t => {
  const h = setup(t);
  for (let index = 0; index <= 100; index++) h.frame(index * 10, index + 1, 10_000 + index * 20);
  const sample = h.read()!;
  assert.equal(sample.status, 'ready');
  assert.equal(sample.sampleCount, 100);
  assert.equal(sample.lowFps, 100);
  assert.equal(h.video.callbacks.size, 1);
  assert.equal(h.video.plays, 0); assert.equal(h.video.pauses, 0); assert.equal(h.track.stopCalls, 0);
  assert.equal(h.video.srcObject, h.stream.mediaStream());
});

test('missed compositor callbacks are incomplete rather than fabricated per-frame samples', t => {
  const h = setup(t); h.fill(); h.frame(1020, 103);
  const sample = h.read()!;
  assert.equal(sample.status, 'incomplete');
  assert.equal(sample.missedFrames, 1);
  assert.equal(sample.lowFps, null);
});

test('a waiting stall remains observable and its real long interval is retained after recovery', t => {
  const h = setup(t); h.fill();
  h.video.dispatchEvent(new Event('waiting'));
  h.setNow(2200);
  assert.equal(h.read()?.status, 'stalled');
  assert.equal(h.read()?.lowFps, null);
  h.video.dispatchEvent(new Event('playing'));
  h.frame(2200, 102);
  assert.equal(h.read()?.status, 'ready');
  assert.ok(h.read()!.lowFps! < 10);
  assert.equal(h.read()?.sampleCount, 101);
});

test('pause cancels only the owned callback and playing starts a fresh baseline', t => {
  const h = setup(t); h.fill();
  const late = [...h.video.callbacks.values()][0];
  h.video.paused = true; h.video.dispatchEvent(new Event('pause'));
  assert.equal(h.video.callbacks.size, 0); assert.equal(h.read(), null);
  late(2000, { presentationTime: 2000, presentedFrames: 999 } as VideoFrameCallbackMetadata);
  assert.equal(h.video.callbacks.size, 0);
  h.video.paused = false; h.video.dispatchEvent(new Event('playing'));
  h.frame(3000, 1000);
  assert.equal(h.read()?.sampleCount, 0);
  assert.equal(h.read()?.status, 'sampling');
  assert.equal(h.video.callbacks.size, 1);
});

test('ordinary document hiding cancels and clears history, then resumes without a hidden-time gap', t => {
  const h = setup(t); h.fill();
  h.doc.hidden = true; h.doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(h.read(), null); assert.equal(h.video.callbacks.size, 0);
  h.doc.hidden = false; h.doc.dispatchEvent(new Event('visibilitychange'));
  h.fill(60_000, 6000);
  assert.equal(h.read()?.status, 'ready'); assert.equal(h.read()?.lowFps, 100);
  assert.equal(h.read()?.sampleCount, 100);
});

test('native PiP keeps the same video observable while its document is hidden', t => {
  const h = setup(t); h.fill();
  h.doc.pictureInPictureElement = h.video;
  h.doc.hidden = true; h.doc.dispatchEvent(new Event('visibilitychange'));
  h.video.dispatchEvent(new Event('enterpictureinpicture'));
  h.frame(1010, 102);
  assert.equal(h.read()?.status, 'ready'); assert.equal(h.read()?.sampleCount, 101);
  h.doc.pictureInPictureElement = null;
  h.video.dispatchEvent(new Event('leavepictureinpicture'));
  assert.equal(h.read(), null); assert.equal(h.video.callbacks.size, 0);
});

test('a replacement first track owns a new window and retired callbacks stay inert', t => {
  const h = setup(t); h.fill(); const next = new Track();
  const late = [...h.video.callbacks.values()][0];
  h.stream.tracks = [next]; h.stream.dispatchEvent(new Event('addtrack'));
  assert.equal(h.read(), null); assert.equal(h.track.count(), 0);
  late(1010, { presentationTime: 1010, presentedFrames: 102 } as VideoFrameCallbackMetadata);
  assert.equal(readFramePresentation(next.mediaTrack(), 1010)?.sampleCount, 0);
  assert.equal(h.video.callbacks.size, 1);
  h.frame(2000, 1);
  assert.equal(readFramePresentation(next.mediaTrack(), 2000)?.sampleCount, 0);
  h.stop(); assert.equal(next.count(), 0);
});

test('read reconciles silent stream changes without returning a new track sample for the old key', t => {
  const h = setup(t); h.fill(); const next = new Track();
  h.stream.tracks = [next];
  assert.equal(h.read(), null);
  assert.equal(readFramePresentation(next.mediaTrack(), 1000)?.status, 'sampling');
});

test('ended tracks retire their reader and never stop or reacquire media', t => {
  const h = setup(t); h.fill(); h.track.end();
  assert.equal(h.read(), null); assert.equal(h.video.callbacks.size, 0); assert.equal(h.track.count(), 0);
  assert.equal(h.track.stopCalls, 0); assert.equal(h.video.plays, 0); assert.equal(h.video.pauses, 0);
});

test('srcObject mismatch is unavailable and restoring the binding resets observation', t => {
  const h = setup(t); h.fill();
  h.video.srcObject = new Stream([new Track()]).mediaStream();
  assert.equal(h.read(), null); assert.equal(h.video.callbacks.size, 0);
  h.video.srcObject = h.stream.mediaStream(); h.video.dispatchEvent(new Event('loadedmetadata'));
  h.frame(3000, 3000);
  assert.equal(h.read()?.sampleCount, 0); assert.equal(h.read()?.status, 'sampling');
});

test('nonmonotonic compositor counters and timestamps start a fresh baseline', t => {
  const h = setup(t); h.fill();
  h.frame(1010, 2);
  assert.equal(h.read()?.sampleCount, 0); assert.equal(h.read()?.lowFps, null);
  h.frame(500, 3, 1020);
  assert.equal(h.read()?.sampleCount, 0);
  h.frame(Number.NaN, 4, 1030);
  assert.equal(h.read()?.sampleCount, 0);
  h.frame(1040, 5);
  assert.equal(h.read()?.sampleCount, 0);
});

test('ambiguous video owners fail closed and independent cleanup preserves the survivor', t => {
  const h = setup(t); h.fill();
  const other = new Video(h.doc, h.stream.mediaStream());
  const stopOther = bindFramePresentation(other.element(), h.stream.mediaStream());
  assert.equal(h.read(), null);
  stopOther(); stopOther();
  assert.equal(h.read()?.status, 'ready'); assert.equal(other.callbacks.size, 0); assert.equal(other.count(), 0);
});

test('dispose removes listeners and callbacks without touching unrelated callback registrations', t => {
  const h = setup(t); h.fill();
  const unrelated = h.video.requestVideoFrameCallback(() => {});
  const late = [...h.video.callbacks.values()][0];
  h.stop(); h.stop();
  assert.equal(h.read(), null);
  assert.deepEqual([...h.video.callbacks.keys()], [unrelated]);
  assert.equal(h.video.count(), 0); assert.equal(h.stream.count(), 0);
  assert.equal(h.track.count(), 0); assert.equal(h.doc.count(), 0);
  late(2000, { presentationTime: 2000, presentedFrames: 999 } as VideoFrameCallbackMetadata);
  assert.deepEqual([...h.video.callbacks.keys()], [unrelated]);
});

test('missing rVFC support adds no observer, and registration failure never affects playback', t => {
  const h = setup(t); h.stop();
  Object.defineProperty(h.video, 'requestVideoFrameCallback', { configurable: true, value: undefined });
  const stopUnsupported = bindFramePresentation(h.video.element(), h.stream.mediaStream());
  assert.equal(h.read(), null); assert.equal(h.video.count(), 0); stopUnsupported();
  Object.defineProperty(h.video, 'requestVideoFrameCallback', { configurable: true, value: () => { throw new Error('unsupported'); } });
  const stopFailed = bindFramePresentation(h.video.element(), h.stream.mediaStream());
  assert.equal(h.read(), null); assert.equal(h.video.callbacks.size, 0);
  assert.equal(h.video.count(), 0); assert.equal(h.doc.count(), 0); assert.equal(h.stream.count(), 0);
  assert.equal(h.video.plays, 0); assert.equal(h.video.pauses, 0); assert.equal(h.track.stopCalls, 0);
  stopFailed();
});

test('StrictMode-style disposal and rebinding starts clean and ignores the predecessor callback', t => {
  const h = setup(t); h.fill();
  const late = [...h.video.callbacks.values()][0];
  h.stop();
  const stopAgain = bindFramePresentation(h.video.element(), h.stream.mediaStream());
  t.after(stopAgain);
  assert.equal(h.read()?.status, 'sampling'); assert.equal(h.read()?.sampleCount, 0);
  late(2000, { presentationTime: 2000, presentedFrames: 9000 } as VideoFrameCallbackMetadata);
  assert.equal(h.read()?.sampleCount, 0); assert.equal(h.video.callbacks.size, 1);
  h.fill(3000, 500);
  assert.equal(h.read()?.status, 'ready'); assert.equal(h.read()?.lowFps, 100);
  stopAgain();
  assert.equal(h.video.callbacks.size, 0); assert.equal(h.doc.count(), 0);
});
