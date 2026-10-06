import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { BrowserWindow } from 'electron';
import { installNativeResizeState } from '../electron/window-resize';
import { installViewportResizeState } from '../src/viewportResize';

function nativeWindow() {
  const win = new EventEmitter();
  const webContents = new EventEmitter();
  const sent: unknown[][] = [];
  const hooks = new Map<number, () => void>();
  const fake = Object.assign(win, { webContents: Object.assign(webContents, {
    send: (...args: unknown[]) => sent.push(args),
  }), isDestroyed: () => false, hookWindowMessage: (message: number, callback: () => void) => hooks.set(message, callback) });
  return { win: fake as unknown as BrowserWindow, sent, hooks };
}

test('native resize sends state transitions, not bounds or one IPC per step', () => {
  const { win, sent, hooks } = nativeWindow();
  installNativeResizeState(win, 'win32');
  win.emit('will-resize'); win.emit('will-resize'); win.emit('resize');
  assert.deepEqual(sent, [['cove:window-resizing', true]]);
  hooks.get(0x0232)!(); win.emit('resized');
  assert.deepEqual(sent, [['cove:window-resizing', true], ['cove:window-resizing', false]]);
  win.emit('will-resize'); win.webContents.emit('did-finish-load'); win.emit('resized');
  assert.deepEqual(sent.slice(2), [['cove:window-resizing', true], ['cove:window-resizing', true], ['cove:window-resizing', false]]);
});

test('other platforms retain their existing window behavior', () => {
  const { win, sent, hooks } = nativeWindow();
  installNativeResizeState(win, 'darwin');
  win.emit('will-resize'); win.emit('resized');
  assert.equal(win.listenerCount('will-resize'), 0);
  assert.equal(hooks.size, 0); assert.deepEqual(sent, []);
});

function renderer(native: boolean) {
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  const classes = new Set<string>(), timers = new Map<number, () => void>();
  const listeners = new Map<string, () => void>();
  let nextId = 0, nativeListener: ((active: boolean) => void) | undefined, mutations = 0;
  const win = {
    addEventListener: (event: string, callback: () => void) => listeners.set(event, callback),
    removeEventListener: (event: string) => listeners.delete(event),
    setTimeout: (callback: () => void) => { timers.set(++nextId, callback); return nextId; },
    clearTimeout: (id: number) => timers.delete(id),
    coveWindow: native ? { onResize: (listener: (active: boolean) => void) => {
      nativeListener = listener; return () => { nativeListener = undefined; };
    } } : undefined,
  };
  const classList = { contains: (name: string) => classes.has(name),
    add: (name: string) => { mutations++; classes.add(name); },
    remove: (name: string) => { mutations++; classes.delete(name); } };
  Object.assign(globalThis, { window: win, document: { documentElement: { classList } } });
  return { classes, timers, listeners, native: (active: boolean) => nativeListener?.(active),
    get mutations() { return mutations; },
    expire: () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); },
    restore: () => Object.assign(globalThis, { window: previousWindow, document: previousDocument }) };
}

test('native drag enters early and stays lightweight during pauses, including cancellation', () => {
  const state = renderer(true);
  try {
    const cleanup = installViewportResizeState();
    state.native(true);
    assert.ok(state.classes.has('viewport-resizing'));
    for (let i = 0; i < 100; i++) state.listeners.get('resize')!();
    assert.equal(state.mutations, 1); assert.equal(state.timers.size, 0);
    state.expire(); assert.ok(state.classes.has('viewport-resizing'));
    state.native(false); state.expire(); assert.equal(state.classes.size, 0);
    state.native(true); cleanup(); state.native(false);
    assert.equal(state.classes.size, 0); assert.equal(state.listeners.size, 0); assert.equal(state.timers.size, 0);
  } finally { state.restore(); }
});

test('browser / older preloads still settle on ordinary resize events', () => {
  const state = renderer(false);
  try {
    const cleanup = installViewportResizeState();
    state.listeners.get('resize')!(); state.listeners.get('resize')!();
    assert.equal(state.timers.size, 1); assert.equal(state.mutations, 1);
    state.expire(); assert.equal(state.classes.size, 0);
    state.listeners.get('resize')!(); cleanup(); assert.equal(state.timers.size, 0);
  } finally { state.restore(); }
});
