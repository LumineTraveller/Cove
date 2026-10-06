import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { observeScreenVideoFrame } from '../src/features/media/screen/screenVideoReadiness';
import { bindScreenVideo } from '../src/features/media/screen/screenVideoPlayback';
import { LocalScreenVideo, RemoteScreenVideo } from '../src/features/media/screen/ScreenVideo';
import { initialShareLayout, shareLayoutReducer } from '../src/features/rooms/useShareLayout';

class FakeVideo extends EventTarget {
  srcObject: any = null;
  readyState = 0;
  videoWidth = 0;
  videoHeight = 0;
  paused = true;
  plays = 0;
  pauses = 0;
  nextFrame = 0;
  callbacks = new Map<number, () => void>();
  cancelled: number[] = [];
  playResult: () => Promise<void> = () => Promise.resolve();
  play() { this.plays++; this.paused = false; return this.playResult(); }
  pause() { this.pauses++; this.paused = true; }
  requestVideoFrameCallback(callback: () => void) {
    const id = ++this.nextFrame;
    this.callbacks.set(id, callback);
    return id;
  }
  cancelVideoFrameCallback(id: number) { this.cancelled.push(id); this.callbacks.delete(id); }
  frame() {
    this.readyState = 2; this.videoWidth = 1280; this.videoHeight = 720;
    const callbacks = [...this.callbacks.values()]; this.callbacks.clear();
    for (const callback of callbacks) callback();
  }
  element() { return this as unknown as HTMLVideoElement; }
}
const stream = () => ({ getTracks: () => [] }) as unknown as MediaStream;
const flush = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };
function installDocument(t: any) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const target = new EventTarget();
  const clicks = new Set<any>();
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    addEventListener(type: string, listener: any, options: any) {
      if (type === 'click') clicks.add(listener);
      target.addEventListener(type, listener, options);
    },
    removeEventListener(type: string, listener: any) {
      clicks.delete(listener); target.removeEventListener(type, listener);
    },
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete (globalThis as any).document;
  });
  return { clicks, click: () => target.dispatchEvent(new Event('click')) };
}

test('share mode starts at full layout with chat closed and no transition', () => {
  const normal = initialShareLayout(false);
  assert.equal(normal.chatOpen, true);
  const shared = shareLayoutReducer(normal, { type: 'mode', sharing: true });
  assert.deepEqual(shared, { sharing: true, chatOpen: false, animateChat: false, sidebarOpen: false, animateControls: false });
  assert.deepEqual(initialShareLayout(true), shared);
});

test('intentional chat toggles animate and retain their state in the current share', () => {
  const shared = initialShareLayout(true);
  const open = shareLayoutReducer(shared, { type: 'chat', open: true });
  assert.deepEqual(open, { sharing: true, chatOpen: true, animateChat: true, sidebarOpen: false, animateControls: true });
  assert.equal(shareLayoutReducer(open, { type: 'mode', sharing: true }), open);
  assert.deepEqual(shareLayoutReducer(open, { type: 'chat', open: value => !value }), {
    sharing: true, chatOpen: false, animateChat: true, sidebarOpen: false, animateControls: true,
  });
});

test('ending and starting a share again resets animation and chat in the same update', () => {
  const open = shareLayoutReducer(initialShareLayout(true), { type: 'chat', open: true });
  const ended = shareLayoutReducer(open, { type: 'mode', sharing: false });
  assert.deepEqual(ended, initialShareLayout(false));
  assert.deepEqual(shareLayoutReducer(ended, { type: 'mode', sharing: true }), initialShareLayout(true));
});

test('every share exit restores ordinary chat without inheriting an in-flight chat toggle', () => {
  for (const toggles of [[], [true], [true, false], [true, false, true]]) {
    let state = initialShareLayout(false);
    for (let session = 0; session < 3; session++) {
      state = shareLayoutReducer(state, { type: 'mode', sharing: true });
      for (const open of toggles) state = shareLayoutReducer(state, { type: 'chat', open });
      state = shareLayoutReducer(state, { type: 'mode', sharing: false });
      assert.deepEqual(state, initialShareLayout(false));
      assert.equal(shareLayoutReducer(state, { type: 'mode', sharing: false }), state);
    }
  }
});

test('mode boundaries keep sidebar selection while canceling control motion from prior actions', () => {
  for (const sharing of [false, true]) {
    let state = initialShareLayout(sharing);
    for (const open of [true, false, true]) {
      state = shareLayoutReducer(state, { type: 'navigation', open });
      assert.equal(state.sidebarOpen, open);
      assert.equal(state.animateControls, true);
    }
    state = shareLayoutReducer(state, { type: 'mode', sharing: !sharing });
    assert.deepEqual(state, initialShareLayout(!sharing, true));
    assert.equal(shareLayoutReducer(state, { type: 'navigation', open: true }), state,
      'a no-op navigation update must not re-enable motion after a mode switch');
    state = shareLayoutReducer(state, { type: 'navigation', open: value => !value });
    assert.equal(state.sidebarOpen, false);
    assert.equal(state.animateControls, true, 'the next intentional navigation animates normally');
    assert.equal(state.animateChat, false, 'navigation must not re-enable shared-chat geometry animation');
  }
});

test('non-animated layout rule covers both ordinary and shared modes at both breakpoints', () => {
  const css = postcss.parse(fs.readFileSync(path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '../src/styles/ui-v2.css',
  ), 'utf8'));
  for (const target of ['', ' .chat-slot', ' .chat-edge-toggle-anchor']) {
    const selector = `.cove-shell:not(.share-chat-animated)${target}`;
    const rules: postcss.Rule[] = [];
    css.walkRules(rule => { if (rule.selectors.includes(selector)) rules.push(rule); });
    assert.ok(rules.length, `${selector} must also apply after the shared-mode class is removed`);
    const rule = rules.at(-1)!;
    assert.equal(rule.parent?.type, 'root', 'mode switches must be atomic on wide and narrow windows');
    assert.ok(rule.nodes.some(node => node.type === 'decl' &&
      node.prop === 'transition' && node.value === 'none'), `${selector} disables inherited transitions`);
  }
  let controlsGuard = false;
  let railGuard = false;
  let reducedControls = false;
  css.walkRules(rule => {
    const suppressesTransition = rule.nodes.some(node => node.type === 'decl' &&
      node.prop === 'transition' && node.value === 'none');
    if (rule.selectors.includes('.cove-shell:not(.layout-controls-animated) .control-ball-anchor'))
      controlsGuard = rule.parent?.type === 'root' && suppressesTransition;
    if (rule.selectors.includes('.cove-shell:not(.layout-controls-animated) > .navigation-rail'))
      railGuard = rule.parent?.type === 'root' && suppressesTransition;
    if (rule.selectors.includes('.cove-shell.layout-controls-animated .control-ball-anchor'))
      reducedControls = rule.parent?.type === 'atrule' &&
        rule.parent.params === '(prefers-reduced-motion: reduce)' && suppressesTransition;
  });
  assert.equal(controlsGuard, true, 'dock follows the mode change without overlapping ordinary chat');
  assert.equal(railGuard, true, 'mode changes complete an interrupted rail resize with the dock');
  assert.equal(reducedControls, true, 'reduced motion also applies to intentional dock movement');
});

test('metadata and playing alone do not reveal video when first-frame callbacks exist', () => {
  const video = new FakeVideo(); let ready = 0;
  const dispose = observeScreenVideoFrame(video.element(), () => ready++);
  video.readyState = 1; video.videoWidth = 1280; video.videoHeight = 720;
  video.dispatchEvent(new Event('loadedmetadata'));
  video.dispatchEvent(new Event('playing'));
  assert.equal(ready, 0);
  video.frame(); video.frame();
  assert.equal(ready, 1);
  dispose();
});

test('first-frame cancellation ignores a callback already queued before disposal', () => {
  const video = new FakeVideo(); let ready = 0;
  const dispose = observeScreenVideoFrame(video.element(), () => ready++);
  const late = [...video.callbacks.values()][0];
  dispose(); late();
  assert.deepEqual(video.cancelled, [1]);
  assert.equal(ready, 0);
});

test('fallback requires current frame data and nonzero dimensions, then detaches safely', () => {
  const video = new FakeVideo(); let ready = 0;
  (video as any).requestVideoFrameCallback = undefined;
  const dispose = observeScreenVideoFrame(video.element(), () => ready++);
  video.readyState = 1; video.videoWidth = 1280; video.videoHeight = 720;
  video.dispatchEvent(new Event('loadeddata'));
  assert.equal(ready, 0);
  video.readyState = 2; video.videoWidth = 0;
  video.dispatchEvent(new Event('playing'));
  assert.equal(ready, 0);
  video.videoWidth = 1280;
  video.dispatchEvent(new Event('loadeddata')); video.dispatchEvent(new Event('playing'));
  assert.equal(ready, 1);
  dispose();
});

test('fallback immediately recognizes an already decoded static frame', () => {
  const video = new FakeVideo(); let ready = 0;
  (video as any).requestVideoFrameCallback = undefined;
  video.readyState = 2; video.videoWidth = 640; video.videoHeight = 480;
  const dispose = observeScreenVideoFrame(video.element(), () => ready++);
  assert.equal(ready, 1);
  dispose();
});

test('fallback cannot reveal a disposed or replaced stream', () => {
  const video = new FakeVideo(); let ready = 0;
  (video as any).requestVideoFrameCallback = undefined;
  const dispose = observeScreenVideoFrame(video.element(), () => ready++);
  dispose(); video.frame(); video.dispatchEvent(new Event('loadeddata'));
  assert.equal(ready, 0);
});

test('local and remote markup starts with an accessible preparation state', () => {
  const local = renderToString(React.createElement(LocalScreenVideo, { stream: stream() }));
  const remote = renderToString(React.createElement(RemoteScreenVideo, {
    stream: stream(), controlling: true, onInput() {},
  }));
  assert.doesNotMatch(remote, /remote-video-surface controlling/);
  assert.match(remote, /tabindex="-1"/);
  for (const html of [local, remote]) {
    assert.match(html, /aria-busy="true"/);
    assert.match(html, /role="status"/);
    assert.match(html, /正在准备共享画面/);
    assert.match(html, /<video[^>]+muted/);
  }
});

test('playback binds once, reveals a frame, and releases element without stopping tracks', t => {
  installDocument(t);
  const video = new FakeVideo(); const statuses: string[] = [];
  let stopped = false;
  const source = { getTracks: () => [{ stop: () => { stopped = true; } }] } as unknown as MediaStream;
  const binding = bindScreenVideo(video.element(), source, false, status => statuses.push(status));
  assert.equal(video.srcObject, source);
  assert.deepEqual(statuses, ['loading']);
  assert.equal(video.plays, 1);
  video.frame();
  assert.deepEqual(statuses, ['loading', 'ready']);
  binding.dispose();
  assert.equal(video.srcObject, null); assert.equal(video.pauses, 1); assert.equal(stopped, false);
});

test('old frame and play rejection cannot reveal or retry a replacement stream', async t => {
  const document = installDocument(t);
  const video = new FakeVideo(); const old: string[] = []; const next: string[] = [];
  let reject!: (error: Error) => void;
  video.playResult = () => new Promise((_, fail) => { reject = fail; });
  const first = bindScreenVideo(video.element(), stream(), true, status => old.push(status));
  const lateFrame = [...video.callbacks.values()][0];
  first.dispose();
  video.playResult = () => Promise.resolve();
  const source = stream();
  const second = bindScreenVideo(video.element(), source, true, status => next.push(status));
  lateFrame(); reject(new Error('late failure')); await flush();
  assert.deepEqual(old, ['loading']); assert.deepEqual(next, ['loading']);
  assert.equal(document.clicks.size, 0);
  first.retry(); first.dispose();
  assert.equal(video.srcObject, source); assert.equal(video.plays, 2); assert.equal(video.pauses, 1);
  video.frame(); assert.deepEqual(next, ['loading', 'ready']);
  second.dispose();
});

test('remote rejection offers retry but never leaves a click listener after disposal', async t => {
  const document = installDocument(t);
  const video = new FakeVideo(); const statuses: string[] = [];
  video.playResult = () => Promise.reject(new Error('autoplay failure'));
  const binding = bindScreenVideo(video.element(), stream(), true, status => statuses.push(status));
  await flush(); assert.deepEqual(statuses, ['loading', 'error']);
  assert.equal(document.clicks.size, 1);
  video.playResult = () => Promise.resolve();
  document.click(); await flush(); video.frame();
  assert.deepEqual(statuses, ['loading', 'error', 'loading', 'ready']);
  assert.equal(document.clicks.size, 0);
  binding.dispose(); document.click(); assert.equal(video.plays, 2);
});

test('retry keeps an already presented static frame instead of waiting indefinitely', t => {
  installDocument(t);
  const video = new FakeVideo(); const statuses: string[] = [];
  const binding = bindScreenVideo(video.element(), stream(), false, status => statuses.push(status));
  video.frame(); binding.retry();
  assert.deepEqual(statuses, ['loading', 'ready', 'ready']);
  binding.dispose();
});
