import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createScreenPictureInPicture } from '../src/features/media/screen/screenPictureInPicture';

type State = { supported: boolean; active: boolean; pending: boolean; error: string | null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const pictureWindow = {} as PictureInPictureWindow;

function stream() {
  const calls = { stop: 0, clone: 0 };
  const track = { kind: 'video', readyState: 'live', stop() { calls.stop++; } };
  const source = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
    getAudioTracks: () => [],
    clone() { calls.clone++; throw new Error('PiP must reuse the existing stream'); },
  } as unknown as MediaStream;
  return { source, calls };
}

// Node has no DOM bubbling. Dispatch on the document with the real video as
// target, matching native enterpictureinpicture/leavepictureinpicture events.
class FakeDocument extends EventTarget {
  pictureInPictureEnabled = true;
  pictureInPictureElement: HTMLVideoElement | null = null;
  exits = 0;
  listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  exitResult: () => Promise<void> = async () => {
    const video = this.pictureInPictureElement;
    if (video) this.leave(video);
  };
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    if (listener) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }
    super.addEventListener(type, listener, options);
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    if (listener) this.listeners.get(type)?.delete(listener);
    super.removeEventListener(type, listener, options);
  }
  exitPictureInPicture() { this.exits++; return this.exitResult(); }
  nativeEvent(type: string, video: HTMLVideoElement) {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, 'target', { value: video });
    this.dispatchEvent(event);
  }
  enter(video: HTMLVideoElement) {
    this.pictureInPictureElement = video;
    this.nativeEvent('enterpictureinpicture', video);
  }
  leave(video: HTMLVideoElement) {
    if (this.pictureInPictureElement === video) this.pictureInPictureElement = null;
    this.nativeEvent('leavepictureinpicture', video);
  }
  element() { return this as unknown as Document; }
}

class FakeVideo extends EventTarget {
  srcObject: MediaStream | null;
  muted = true;
  readyState = 2;
  videoWidth = 1280;
  videoHeight = 720;
  disablePictureInPicture = false;
  requests = 0;
  plays = 0;
  pauses = 0;
  requestResult: () => Promise<PictureInPictureWindow>;
  constructor(document: FakeDocument, source: MediaStream) {
    super();
    this.srcObject = source;
    this.requestResult = async () => { document.enter(this.element()); return pictureWindow; };
  }
  requestPictureInPicture() { this.requests++; return this.requestResult(); }
  play() { this.plays++; return Promise.resolve(); }
  pause() { this.pauses++; }
  element() { return this as unknown as HTMLVideoElement; }
}

function harness(t: TestContext, configure?: (document: FakeDocument, video: FakeVideo) => void) {
  const document = new FakeDocument();
  const media = stream();
  const video = new FakeVideo(document, media.source);
  configure?.(document, video);
  let currentVideo: HTMLVideoElement | null = video.element();
  const states: State[] = [];
  let returns = 0;
  const controller = createScreenPictureInPicture({
    document: document.element(),
    getVideo: () => currentVideo,
    onState: state => states.push({ ...state }),
    onReturn: () => { returns++; },
  });
  controller.setSource(media.source);
  t.after(() => controller.dispose());
  return {
    controller, document, video, media, states,
    state: () => states.at(-1)!,
    returns: () => returns,
    setVideo: (next: HTMLVideoElement | null) => { currentVideo = next; },
    untouched: () => {
      assert.equal(video.srcObject, media.source, 'presentation must not rebind the player');
      assert.equal(video.muted, true);
      assert.equal(video.plays, 0);
      assert.equal(video.pauses, 0);
      assert.deepEqual(media.calls, { stop: 0, clone: 0 });
    },
  };
}

test('opening presents the existing muted player without taking ownership of playback or tracks', async t => {
  const h = harness(t);
  assert.deepEqual(h.states[0], { supported: true, active: false, pending: false, error: null });
  assert.equal(h.video.requests, 0, 'setting a source does not automatically open a window');
  await h.controller.open();
  assert.equal(h.document.pictureInPictureElement, h.video.element());
  assert.deepEqual(h.state(), { supported: true, active: true, pending: false, error: null });
  assert.equal(h.returns(), 0);
  h.untouched();
});

test('unsupported native PiP reports an error and leaves the main viewer playing', async t => {
  for (const capability of ['disabled', 'missing-request', 'missing-exit'] as const) {
    await t.test(capability, async t => {
      const h = harness(t, (document, video) => {
        if (capability === 'disabled') document.pictureInPictureEnabled = false;
        if (capability === 'missing-request') Object.defineProperty(video, 'requestPictureInPicture', { value: undefined });
        if (capability === 'missing-exit') Object.defineProperty(document, 'exitPictureInPicture', { value: undefined });
      });
      await h.controller.open();
      assert.equal(h.video.requests, 0);
      assert.equal(h.state().supported, false);
      assert.equal(h.state().active, false);
      assert.equal(h.state().pending, false);
      assert.ok(h.state().error);
      assert.equal(h.returns(), 0);
      h.untouched();
    });
  }
});

test('a missing, mismatched, or undecoded player cannot be sent to native PiP', async t => {
  for (const condition of ['no-source', 'no-video', 'different-source', 'metadata-only', 'zero-width', 'zero-height'] as const) {
    await t.test(condition, async t => {
      const h = harness(t);
      if (condition === 'no-source') h.controller.setSource(null);
      if (condition === 'no-video') h.setVideo(null);
      if (condition === 'different-source') h.controller.setSource(stream().source);
      if (condition === 'metadata-only') h.video.readyState = 1;
      if (condition === 'zero-width') h.video.videoWidth = 0;
      if (condition === 'zero-height') h.video.videoHeight = 0;
      await h.controller.open();
      assert.equal(h.video.requests, 0);
      assert.equal(h.state().active, false);
      assert.equal(h.state().pending, false);
      if (condition !== 'no-source') assert.ok(h.state().error);
      h.untouched();
    });
  }
});

test('repeated open clicks share one native request while it is pending or active', async t => {
  const h = harness(t);
  const request = deferred<PictureInPictureWindow>();
  h.video.requestResult = () => request.promise;
  const first = h.controller.open();
  const second = h.controller.open();
  assert.equal(h.video.requests, 1);
  assert.equal(h.state().pending, true);
  h.document.enter(h.video.element());
  request.resolve(pictureWindow);
  await Promise.all([first, second]);
  await h.controller.open();
  assert.equal(h.video.requests, 1);
  assert.equal(h.state().active, true);
  assert.equal(h.state().pending, false);
  h.untouched();
});

test('a rejected native open preserves playback and permits an explicit retry', async t => {
  const h = harness(t);
  h.video.requestResult = () => Promise.reject(new Error('native request rejected'));
  await h.controller.open();
  assert.equal(h.state().active, false);
  assert.equal(h.state().pending, false);
  assert.ok(h.state().error);
  assert.equal(h.document.exits, 0);
  h.untouched();
  h.video.requestResult = async () => { h.document.enter(h.video.element()); return pictureWindow; };
  await h.controller.open();
  assert.equal(h.video.requests, 2);
  assert.equal(h.state().active, true);
  assert.equal(h.state().error, null);
});

test('user return focuses the main viewer once for either native exit event ordering', async t => {
  for (const ordering of ['event-first', 'promise-first'] as const) {
    await t.test(ordering, async t => {
      const h = harness(t);
      await h.controller.open();
      const exit = deferred<void>();
      h.document.exitResult = () => exit.promise;
      const closing = h.controller.close();
      if (ordering === 'event-first') h.document.leave(h.video.element());
      else h.document.pictureInPictureElement = null;
      exit.resolve();
      await closing;
      assert.equal(h.document.exits, 1);
      assert.equal(h.state().active, false);
      assert.equal(h.state().pending, false);
      assert.equal(h.returns(), 1);
      h.document.leave(h.video.element());
      await h.controller.close();
      assert.equal(h.returns(), 1);
      h.untouched();
    });
  }
});

test('the native window close button returns once and ignores unrelated video events', async t => {
  const h = harness(t);
  await h.controller.open();
  const unrelated = new FakeVideo(h.document, stream().source);
  const before = [...h.states];
  h.document.nativeEvent('leavepictureinpicture', unrelated.element());
  h.document.nativeEvent('enterpictureinpicture', unrelated.element());
  assert.deepEqual(h.states, before);
  assert.equal(h.returns(), 0);
  h.document.leave(h.video.element());
  h.document.leave(h.video.element());
  await flush();
  assert.equal(h.state().active, false);
  assert.equal(h.returns(), 1);
  assert.equal(h.document.exits, 0);
  h.controller.setSource(h.media.source);
  h.video.dispatchEvent(new Event('playing'));
  h.video.dispatchEvent(new Event('loadeddata'));
  await flush();
  assert.equal(h.video.requests, 1, 'playback recovery must not reopen a dismissed window');
  h.untouched();
});

test('repeated return clicks share one native exit and one eventual focus return', async t => {
  const h = harness(t);
  await h.controller.open();
  const exit = deferred<void>();
  h.document.exitResult = () => exit.promise;
  const first = h.controller.close();
  const second = h.controller.close();
  assert.equal(second, first);
  assert.equal(h.document.exits, 1);
  assert.equal(h.returns(), 0);
  h.document.leave(h.video.element());
  exit.resolve();
  await Promise.all([first, second]);
  await flush();
  assert.equal(h.state().active, false);
  assert.equal(h.state().pending, false);
  assert.equal(h.returns(), 1);
  h.document.leave(h.video.element());
  await flush();
  assert.equal(h.returns(), 1);
  h.untouched();
});

test('source changes and stopping the watch silently close only the owned window', async t => {
  for (const change of ['replace', 'stop'] as const) {
    await t.test(change, async t => {
      const h = harness(t);
      await h.controller.open();
      h.controller.setSource(change === 'stop' ? null : stream().source);
      await flush();
      assert.equal(h.document.exits, 1);
      assert.equal(h.document.pictureInPictureElement, null);
      assert.equal(h.state().active, false);
      assert.equal(h.returns(), 0);
      assert.equal(h.video.requests, 1);
      h.untouched();
    });
  }
});

test('setting the same live source preserves an active window without opening it again', async t => {
  const h = harness(t);
  await h.controller.open();
  h.controller.setSource(h.media.source);
  await flush();
  assert.equal(h.document.exits, 0);
  assert.equal(h.video.requests, 1);
  assert.equal(h.state().active, true);
});

test('a source change keeps the opening latch until a stale request settles and closes it silently', async t => {
  const h = harness(t);
  const request = deferred<PictureInPictureWindow>();
  h.video.requestResult = () => request.promise;
  const opening = h.controller.open();
  const nextMedia = stream();
  const nextVideo = new FakeVideo(h.document, nextMedia.source);
  h.setVideo(nextVideo.element());
  h.controller.setSource(nextMedia.source);
  const duplicate = h.controller.open();
  assert.equal(h.state().pending, true);
  assert.equal(h.video.requests, 1);
  assert.equal(nextVideo.requests, 0);
  h.document.enter(h.video.element());
  request.resolve(pictureWindow);
  await Promise.all([opening, duplicate]);
  await flush();
  assert.equal(h.document.exits, 1);
  assert.equal(h.document.pictureInPictureElement, null);
  assert.equal(h.state().active, false);
  assert.equal(h.state().pending, false);
  assert.equal(h.returns(), 0);
  assert.equal(nextVideo.requests, 0, 'the replacement stream requires a new user gesture');
  assert.equal(nextVideo.srcObject, nextMedia.source);
  assert.deepEqual(nextMedia.calls, { stop: 0, clone: 0 });
  h.untouched();
  await h.controller.open();
  assert.equal(nextVideo.requests, 1);
  assert.equal(h.state().active, true);
});

test('reusing the same stream object cannot revive an opening invalidated by an intervening watch', async t => {
  const h = harness(t);
  const request = deferred<PictureInPictureWindow>();
  h.video.requestResult = () => request.promise;
  const opening = h.controller.open();
  h.controller.setSource(null);
  h.controller.setSource(h.media.source);
  h.document.enter(h.video.element());
  request.resolve(pictureWindow);
  await opening;
  await flush();
  assert.equal(h.document.exits, 1);
  assert.equal(h.state().active, false);
  assert.equal(h.state().pending, false);
  assert.equal(h.returns(), 0);
  assert.equal(h.video.requests, 1);
});

test('a stale request rejection cannot attach an old error or start a replacement request', async t => {
  const h = harness(t);
  const request = deferred<PictureInPictureWindow>();
  h.video.requestResult = () => request.promise;
  const opening = h.controller.open();
  const nextMedia = stream();
  const nextVideo = new FakeVideo(h.document, nextMedia.source);
  h.setVideo(nextVideo.element());
  h.controller.setSource(nextMedia.source);
  const duplicate = h.controller.open();
  assert.equal(h.state().pending, true);
  request.reject(new Error('failure from the old watch'));
  await Promise.all([opening, duplicate]);
  assert.equal(h.state().active, false);
  assert.equal(h.state().pending, false);
  assert.equal(h.state().error, null);
  assert.equal(nextVideo.requests, 0);
  assert.equal(h.document.exits, 0);
  await h.controller.open();
  assert.equal(nextVideo.requests, 1);
  assert.equal(h.state().active, true);
});

test('a late open result never exits an unrelated video currently in native PiP', async t => {
  const h = harness(t);
  const request = deferred<PictureInPictureWindow>();
  h.video.requestResult = () => request.promise;
  const opening = h.controller.open();
  h.controller.setSource(null);
  const unrelated = new FakeVideo(h.document, stream().source);
  h.document.enter(unrelated.element());
  request.resolve(pictureWindow);
  await opening;
  await flush();
  assert.equal(h.document.pictureInPictureElement, unrelated.element());
  assert.equal(h.document.exits, 0);
  assert.equal(h.state().active, false);
  assert.equal(h.state().pending, false);
  assert.equal(h.returns(), 0);
});

test('a rejected cleanup of a stale opening keeps the remaining owned window actionable', async t => {
  for (const event of ['enter-event', 'promise-first'] as const) {
    await t.test(event, async t => {
      const h = harness(t);
      const request = deferred<PictureInPictureWindow>();
      h.video.requestResult = () => request.promise;
      const opening = h.controller.open();
      h.controller.setSource(stream().source);
      h.document.exitResult = () => Promise.reject(new Error('stale window cleanup rejected'));
      if (event === 'enter-event') h.document.enter(h.video.element());
      else h.document.pictureInPictureElement = h.video.element();
      request.resolve(pictureWindow);
      await opening;
      await flush();
      assert.equal(h.document.pictureInPictureElement, h.video.element());
      assert.equal(h.state().active, true);
      assert.equal(h.state().pending, false);
      assert.ok(h.state().error);
      assert.equal(h.returns(), 0);
      h.untouched();
    });
  }
});

test('user return during an opening waits for that request and closes its late window once', async t => {
  const h = harness(t);
  const request = deferred<PictureInPictureWindow>();
  h.video.requestResult = () => request.promise;
  const opening = h.controller.open();
  const closing = h.controller.close();
  assert.equal(h.returns(), 0);
  assert.equal(h.document.exits, 0);
  h.document.enter(h.video.element());
  request.resolve(pictureWindow);
  await Promise.all([opening, closing]);
  await flush();
  assert.equal(h.document.exits, 1);
  assert.equal(h.state().active, false);
  assert.equal(h.state().pending, false);
  assert.equal(h.returns(), 1);
  h.document.leave(h.video.element());
  assert.equal(h.returns(), 1);
});

test('a later source change cancels focus intent from a return requested during opening', async t => {
  const h = harness(t);
  const request = deferred<PictureInPictureWindow>();
  h.video.requestResult = () => request.promise;
  const opening = h.controller.open();
  const closing = h.controller.close();
  h.controller.setSource(stream().source);
  h.document.enter(h.video.element());
  request.resolve(pictureWindow);
  await Promise.all([opening, closing]);
  await flush();
  assert.equal(h.document.exits, 1);
  assert.equal(h.state().active, false);
  assert.equal(h.returns(), 0);
});

test('a rejected native exit retains accurate active state and an actionable retry', async t => {
  const h = harness(t);
  await h.controller.open();
  h.document.exitResult = () => Promise.reject(new Error('native exit rejected'));
  await h.controller.close();
  assert.equal(h.document.pictureInPictureElement, h.video.element());
  assert.equal(h.state().active, true);
  assert.equal(h.state().pending, false);
  assert.ok(h.state().error);
  assert.equal(h.returns(), 0);
  h.untouched();
  h.document.exitResult = async () => { h.document.leave(h.video.element()); };
  await h.controller.close();
  assert.equal(h.document.exits, 2);
  assert.equal(h.state().active, false);
  assert.equal(h.state().error, null);
  assert.equal(h.returns(), 1);
});

test('a rejected source-change exit keeps its native window visible in state without returning focus', async t => {
  const h = harness(t);
  await h.controller.open();
  h.document.exitResult = () => Promise.reject(new Error('native exit rejected'));
  h.controller.setSource(stream().source);
  await flush();
  assert.equal(h.document.pictureInPictureElement, h.video.element());
  assert.equal(h.state().active, true);
  assert.equal(h.state().pending, false);
  assert.ok(h.state().error);
  assert.equal(h.returns(), 0);
  assert.equal(h.video.requests, 1);
  h.untouched();
});

test('a replacement player cannot open until the previous native exit has settled', async t => {
  for (const result of ['success', 'failure'] as const) {
    await t.test(result, async t => {
      const h = harness(t);
      await h.controller.open();
      const exit = deferred<void>();
      h.document.exitResult = () => exit.promise;
      const closing = h.controller.close();
      const nextMedia = stream();
      const nextVideo = new FakeVideo(h.document, nextMedia.source);
      h.setVideo(nextVideo.element());
      h.controller.setSource(nextMedia.source);
      const blockedOpen = h.controller.open();
      const duplicate = h.controller.open();
      assert.equal(nextVideo.requests, 0);
      if (result === 'success') {
        h.document.leave(h.video.element());
        exit.resolve();
      }
      else exit.reject(new Error('late failure from the old window'));
      await Promise.all([closing, blockedOpen, duplicate]);
      await flush();
      assert.equal(nextVideo.requests, 0, 'waiting for an exit must not consume a later user gesture');
      assert.equal(h.returns(), 0);
      await h.controller.open();
      h.document.nativeEvent('leavepictureinpicture', h.video.element());
      assert.equal(h.document.pictureInPictureElement, nextVideo.element());
      assert.equal(h.state().active, true);
      assert.equal(h.state().pending, false);
      assert.equal(h.state().error, null);
      assert.equal(h.returns(), 0);
      assert.equal(h.document.exits, 1);
      h.document.exitResult = async () => { h.document.leave(nextVideo.element()); };
    });
  }
});

test('reusing the player for a new source cannot race an old exit or auto-open the new watch', async t => {
  const h = harness(t);
  await h.controller.open();
  const exit = deferred<void>();
  h.document.exitResult = () => exit.promise;
  const closing = h.controller.close();
  const nextMedia = stream();
  h.video.srcObject = nextMedia.source;
  h.controller.setSource(nextMedia.source);
  const blockedOpen = h.controller.open();
  assert.equal(h.video.requests, 1);
  h.document.leave(h.video.element());
  exit.resolve();
  await Promise.all([closing, blockedOpen]);
  await flush();
  assert.equal(h.video.requests, 1);
  assert.equal(h.state().active, false);
  assert.equal(h.returns(), 0);
  const request = deferred<PictureInPictureWindow>();
  h.video.requestResult = () => request.promise;
  const opening = h.controller.open();
  const duplicate = h.controller.open();
  assert.equal(h.video.requests, 2);
  assert.equal(h.state().pending, true);
  h.document.enter(h.video.element());
  request.resolve(pictureWindow);
  await Promise.all([opening, duplicate]);
  assert.equal(h.state().active, true);
  assert.equal(h.state().pending, false);
  assert.equal(h.state().error, null);
  h.document.nativeEvent('leavepictureinpicture', h.video.element());
  await flush();
  assert.equal(h.state().active, true, 'an obsolete leave event must not close the new watch on the same player');
  assert.equal(h.returns(), 0);
  h.document.exitResult = async () => { h.document.leave(h.video.element()); };
});

test('disposing during an in-flight exit suppresses both resolution and rejection callbacks', async t => {
  for (const result of ['success', 'failure'] as const) {
    await t.test(result, async t => {
      const h = harness(t);
      await h.controller.open();
      const exit = deferred<void>();
      h.document.exitResult = () => exit.promise;
      const closing = h.controller.close();
      h.controller.dispose();
      const before = [...h.states];
      if (result === 'success') {
        h.document.leave(h.video.element());
        exit.resolve();
      } else exit.reject(new Error('native exit rejected after disposal'));
      await closing;
      await flush();
      assert.deepEqual(h.states, before);
      assert.equal(h.returns(), 0);
      assert.equal(h.document.exits, 1, 'disposal must reuse the native exit already in flight');
      assert.ok([...h.document.listeners.values()].every(listeners => listeners.size === 0));
    });
  }
});

test('dispose removes native listeners, closes its own window, and suppresses late callbacks', async t => {
  const h = harness(t);
  await h.controller.open();
  assert.ok([...h.document.listeners.values()].some(listeners => listeners.size > 0));
  const before = [...h.states];
  h.controller.dispose();
  await flush();
  assert.equal(h.document.exits, 1);
  assert.equal(h.document.pictureInPictureElement, null);
  assert.ok([...h.document.listeners.values()].every(listeners => listeners.size === 0));
  h.document.enter(h.video.element());
  h.document.leave(h.video.element());
  h.controller.setSource(h.media.source);
  await h.controller.open();
  await h.controller.close();
  h.controller.dispose();
  assert.deepEqual(h.states, before);
  assert.equal(h.video.requests, 1);
  assert.equal(h.document.exits, 1);
  assert.equal(h.returns(), 0);
  h.untouched();
});

test('dispose during opening cleans up a late owned window without state or focus callbacks', async t => {
  const h = harness(t);
  const request = deferred<PictureInPictureWindow>();
  h.video.requestResult = () => request.promise;
  const opening = h.controller.open();
  const closing = h.controller.close();
  const before = [...h.states];
  h.controller.dispose();
  h.document.enter(h.video.element());
  request.resolve(pictureWindow);
  await Promise.all([opening, closing]);
  await flush();
  assert.equal(h.document.exits, 1);
  assert.equal(h.document.pictureInPictureElement, null);
  assert.deepEqual(h.states, before);
  assert.equal(h.returns(), 0);
  assert.ok([...h.document.listeners.values()].every(listeners => listeners.size === 0));
  h.untouched();
});

test('disposing an old owner never exits another video after its pending request resolves', async t => {
  const h = harness(t);
  const request = deferred<PictureInPictureWindow>();
  h.video.requestResult = () => request.promise;
  const opening = h.controller.open();
  const before = [...h.states];
  h.controller.dispose();
  const unrelated = new FakeVideo(h.document, stream().source);
  h.document.enter(unrelated.element());
  request.resolve(pictureWindow);
  await opening;
  await flush();
  assert.equal(h.document.pictureInPictureElement, unrelated.element());
  assert.equal(h.document.exits, 0);
  assert.deepEqual(h.states, before);
  assert.equal(h.returns(), 0);
});
