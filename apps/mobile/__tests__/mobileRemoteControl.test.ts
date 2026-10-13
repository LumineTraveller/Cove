import {
  MobileRemoteControl,
  type MobileRemoteSocket,
} from '../src/features/remote-control/mobileRemoteControl';
import {
  remoteCharacterKeys,
  remoteShortcut,
  remoteWheel,
  textToRemoteInputs,
} from '../src/features/remote-control/remoteInput';

function fixture() {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const emitted: { event: string; payload: any; ack?: (reply: any) => void }[] =
    [];
  const socket: MobileRemoteSocket = {
    id: 'mobile',
    connected: true,
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
    },
    off: (event, fn) => {
      listeners.get(event)?.delete(fn);
    },
    emit: (event, payload, ack) => {
      emitted.push({ event, payload, ack });
    },
  };
  const state = jest.fn();
  const control = new MobileRemoteControl({
    socket,
    roomId: 'room',
    onState: state,
  });
  control.setTarget('desktop', true);
  const receive = (event: string, payload?: any) => {
    for (const fn of listeners.get(event) ?? []) fn(payload);
  };
  const ack = (requestId = 'request') =>
    [...emitted].reverse().find(e => e.event === 'remote-control:request')!
      .ack!({ ok: true, requestId, expiresAt: Date.now() + 30000 });
  const start = (overrides: object = {}) =>
    receive('remote-control:started', {
      roomId: 'room',
      sessionId: 'session',
      role: 'controller',
      sharerSocketId: 'desktop',
      requestId: 'request',
      ...overrides,
    });
  const activate = () => {
    expect(control.request()).toBe(true);
    ack();
    start();
  };
  const inputs = () =>
    emitted
      .filter(e => e.event === 'remote-control:input')
      .map(e => e.payload.input);
  return {
    socket,
    listeners,
    emitted,
    control,
    receive,
    ack,
    start,
    activate,
    inputs,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1000);
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('server rejection is visible and duplicate requests are blocked', () => {
  const f = fixture();
  expect(f.control.request()).toBe(true);
  expect(f.control.request()).toBe(false);
  f.emitted[0].ack!({ ok: false, error: 'legacy server rejects mobile' });
  expect(f.control.snapshot).toEqual({
    session: null,
    pending: null,
    error: 'legacy server rejects mobile',
  });
  f.control.dispose();
});

test('cancel before ACK cancels the delayed server request and rejects its start', () => {
  const f = fixture();
  f.control.request();
  f.control.cancel();
  f.ack();
  f.start();
  expect(f.control.snapshot.session).toBeNull();
  expect(f.emitted.map(e => e.event)).toEqual([
    'remote-control:request',
    'remote-control:cancel',
    'remote-control:stop',
  ]);
  f.control.dispose();
});

test('dispose before ACK still cancels the delayed server request', () => {
  const f = fixture();
  f.control.request();
  f.control.dispose();
  f.ack();
  expect(f.emitted.at(-1)).toMatchObject({
    event: 'remote-control:cancel',
    payload: { requestId: 'request' },
  });
  expect([...f.listeners.values()].every(s => !s.size)).toBe(true);
});

test('start before ACK cannot authorize input until request correlation is verified', () => {
  const f = fixture();
  f.control.request();
  f.start();
  expect(f.control.pointer({ x: 0, y: 0 })).toBe(false);
  f.ack();
  expect(f.control.snapshot.session?.sessionId).toBe('session');
  expect(f.control.pointer({ x: 0, y: 0 })).toBe(true);
  f.control.dispose();
});

test('an old start cannot attach to a retry for the same target', () => {
  const f = fixture();
  f.control.request();
  f.ack('old');
  f.control.cancel();
  f.control.request();
  f.start({ requestId: 'old', sessionId: 'old-session' });
  f.ack('new');
  expect(f.control.snapshot.session).toBeNull();
  expect(f.emitted).toContainEqual({
    event: 'remote-control:stop',
    payload: { sessionId: 'old-session' },
    ack: undefined,
  });
  f.start({ requestId: 'new' });
  expect(f.control.snapshot.session?.requestId).toBe('new');
  f.control.dispose();
});

test('mobile rejects a sharer role without activating a receiver', () => {
  const f = fixture();
  f.control.request();
  f.ack();
  f.start({ role: 'sharer' });
  expect(f.control.snapshot.session).toBeNull();
  expect(f.control.snapshot.pending).toBeNull();
  expect(f.control.pointer({ x: 0.5, y: 0.5 })).toBe(false);
  expect(f.emitted.some(e => e.event === 'remote-control:stop')).toBe(true);
  f.control.dispose();
});

test('target change and permission withdrawal cancel pending or active control', () => {
  const f = fixture();
  f.control.request();
  f.ack();
  f.control.setTarget('other', true);
  f.start();
  expect(f.control.snapshot.session).toBeNull();
  f.control.setTarget('desktop', true);
  f.activate();
  f.control.setTarget('desktop', false);
  expect(f.control.snapshot.session).toBeNull();
  expect(f.control.request()).toBe(false);
  f.control.dispose();
});

test('disconnect drops unsent moves and recovered starts cannot restore a session', () => {
  const f = fixture();
  f.activate();
  f.control.pointer({ x: 0, y: 0 });
  f.control.pointer({ x: 1, y: 1 });
  f.socket.connected = false;
  f.receive('disconnect');
  f.start();
  f.socket.connected = true;
  f.receive('connect');
  f.start();
  jest.advanceTimersByTime(16);
  expect(f.control.snapshot.session).toBeNull();
  expect(f.inputs()).toHaveLength(1);
  f.control.dispose();
});

test('pointer throttle sends the final tail and button edges are ordering barriers', () => {
  const f = fixture();
  f.activate();
  f.control.pointer({ x: 0, y: 0 });
  f.control.pointer({ x: 0.4, y: 0.1 });
  f.control.pointer({ x: 1, y: 0 });
  expect(f.inputs()).toEqual([{ type: 'pointer', x: 0, y: 0 }]);
  jest.advanceTimersByTime(16);
  expect(f.inputs().at(-1)).toEqual({ type: 'pointer', x: 1, y: 0 });
  f.control.pointer({ x: 0.5, y: 0.3 });
  f.control.click({ x: 0.5, y: 0.3 });
  expect(
    f
      .inputs()
      .slice(-3)
      .map(i => i.type),
  ).toEqual(['pointer', 'button', 'button']);
  expect(
    f
      .inputs()
      .slice(-2)
      .map(i => i.down),
  ).toEqual([true, false]);
  f.control.dispose();
});

test('transport backpressure coalesces moves and sends final move on drain', () => {
  const f = fixture();
  f.activate();
  const listeners = new Map<string, (...args: any[]) => void>();
  const engine = {
    transport: { writable: false },
    writeBuffer: [] as unknown[],
    on: (event: string, fn: any) => listeners.set(event, fn),
    off: (event: string) => listeners.delete(event),
  };
  f.socket.io = { engine };
  f.control.pointer({ x: 0, y: 0 });
  f.control.pointer({ x: 0.9, y: 1 });
  expect(f.inputs()).toEqual([]);
  engine.transport.writable = true;
  listeners.get('drain')!();
  expect(f.inputs()).toEqual([{ type: 'pointer', x: 0.9, y: 1 }]);
  f.control.dispose();
  expect(listeners.size).toBe(0);
});

test('shortcut order and held key/button releases precede stop', () => {
  const f = fixture();
  f.activate();
  f.control.shortcut(['ControlLeft', 'KeyC']);
  expect(f.inputs()).toEqual(remoteShortcut(['ControlLeft', 'KeyC']));
  f.control.key('ShiftLeft', true);
  f.control.button('left', true, { x: 0.1, y: 0 });
  expect(f.control.key('ShiftLeft', true)).toBe(false);
  f.control.stop();
  expect(f.inputs().slice(-2)).toEqual([
    { type: 'button', button: 'left', down: false, x: 0.1, y: 0 },
    { type: 'key', code: 'ShiftLeft', down: false },
  ]);
  expect(f.emitted.at(-1)?.event).toBe('remote-control:stop');
  expect(f.control.key('KeyA', true)).toBe(false);
  f.control.dispose();
});

test('top edge zero is preserved; invalid positions, arbitrary codes and release spam are refused', () => {
  const f = fixture();
  f.activate();
  expect(f.control.click({ x: 0, y: 0 })).toBe(true);
  expect(f.inputs()[0]).toMatchObject({ x: 0, y: 0 });
  expect(f.control.pointer({ x: NaN, y: 0 })).toBe(false);
  expect(f.control.pointer({ x: 0, y: -0.01 })).toBe(false);
  expect(f.control.key('LaunchMalware', true)).toBe(false);
  expect(f.control.key('KeyA', false)).toBe(false);
  expect(f.control.button('right', false, { x: 0, y: 0 })).toBe(false);
  f.control.dispose();
});

test('timeouts reclaim delayed request ACKs and expired requests', () => {
  const f = fixture();
  f.control.request();
  jest.advanceTimersByTime(8000);
  f.ack();
  expect(f.control.snapshot.pending).toBeNull();
  expect(f.emitted.at(-1)?.event).toBe('remote-control:cancel');
  f.control.request();
  f.ack('second');
  jest.advanceTimersByTime(30100);
  expect(f.control.snapshot.pending).toBeNull();
  f.control.dispose();
});

test('request result before ACK is retained and denied without a session', () => {
  const f = fixture();
  f.control.request();
  f.receive('remote-control:request-result', {
    requestId: 'request',
    accepted: false,
    error: 'denied',
  });
  f.ack();
  expect(f.control.snapshot).toEqual({
    session: null,
    pending: null,
    error: 'denied',
  });
  f.control.dispose();
});

test('wheel bounds and representable keyboard characters match existing desktop protocol', () => {
  expect(remoteWheel({ x: 0, y: 0 }, -5000, 5000)).toEqual({
    type: 'wheel',
    x: 0,
    y: 0,
    deltaX: -1200,
    deltaY: 1200,
  });
  expect(remoteWheel({ x: -1, y: 0 }, 0, 1)).toBeNull();
  expect(
    remoteShortcut(['ControlLeft', 'KeyA', 'ControlLeft']).map(
      i => i.type === 'key' && [i.code, i.down],
    ),
  ).toEqual([
    ['ControlLeft', true],
    ['KeyA', true],
    ['KeyA', false],
    ['ControlLeft', false],
  ]);
  expect(remoteCharacterKeys('A')).toEqual(['ShiftLeft', 'KeyA']);
  expect(remoteCharacterKeys('中')).toBeNull();
});

test('ASCII text maps all printable symbols and refuses Unicode atomically', () => {
  const printable = Array.from({ length: 95 }, (_, i) =>
    String.fromCharCode(i + 32),
  ).join('');
  expect(textToRemoteInputs(printable)).not.toBeNull();
  expect(textToRemoteInputs('hello中')).toBeNull();
  expect(textToRemoteInputs('a'.repeat(257))).toBeNull();
  expect(textToRemoteInputs('A!')).toEqual([
    ...remoteShortcut(['ShiftLeft', 'KeyA']),
    ...remoteShortcut(['ShiftLeft', 'Digit1']),
  ]);
});

test('typed text is paced and cancellation stops the remaining key sequence', async () => {
  const f = fixture();
  f.activate();
  const typing = f.control.typeText('A!');
  expect(f.inputs()).toEqual(remoteShortcut(['ShiftLeft', 'KeyA']));
  f.control.stop();
  await jest.advanceTimersByTimeAsync(32);
  expect(await typing).toBe(false);
  expect(f.inputs()).toEqual(remoteShortcut(['ShiftLeft', 'KeyA']));
  f.control.dispose();
});

test('stopping a drag releases at its latest position and malformed stop packets are ignored', () => {
  const f = fixture();
  f.receive('remote-control:stopped');
  f.activate();
  f.control.button('left', true, { x: 0, y: 0 });
  f.control.pointer({ x: 0.8, y: 0.2 });
  f.control.stop();
  expect(f.inputs().at(-1)).toEqual({
    type: 'button',
    button: 'left',
    down: false,
    x: 0.8,
    y: 0.2,
  });
  f.control.dispose();
});

test('pausing input drops pending moves and releases held edges in reverse order without stopping the session', () => {
  const f = fixture();
  f.activate();
  f.control.key('ControlLeft', true);
  f.control.key('KeyA', true);
  f.control.button('left', true, { x: 0, y: 0 });
  f.control.pointer({ x: 0.5, y: 0 });
  f.control.pointer({ x: 0.8, y: 0.4 });
  const session = f.control.snapshot.session;
  f.control.setInputEnabled(false);
  expect(f.inputs().slice(-3)).toEqual([
    { type: 'button', button: 'left', down: false, x: 0.8, y: 0.4 },
    { type: 'key', code: 'KeyA', down: false },
    { type: 'key', code: 'ControlLeft', down: false },
  ]);
  expect(f.control.snapshot.session).toBe(session);
  expect(f.emitted.some(e => e.event === 'remote-control:stop')).toBe(false);
  const count = f.inputs().length;
  jest.advanceTimersByTime(32);
  f.control.setInputEnabled(false);
  expect(f.inputs()).toHaveLength(count);
  f.control.dispose();
});

test('paused input refuses drag, buttons, wheel, shortcuts and typing until a new interaction', async () => {
  const f = fixture();
  f.activate();
  f.control.setInputEnabled(false);
  expect(f.control.pointer({ x: 0.5, y: 0 })).toBe(false);
  expect(f.control.button('left', true, { x: 0.5, y: 0 })).toBe(false);
  expect(f.control.wheel({ x: 0.5, y: 0 }, 0, 120)).toBe(false);
  expect(f.control.key('Enter', true)).toBe(false);
  expect(f.control.shortcut(['ControlLeft', 'KeyC'])).toBe(false);
  expect(await f.control.typeText('abc')).toBe(false);
  expect(f.inputs()).toEqual([]);
  f.control.setInputEnabled(true);
  expect(f.control.button('left', false, { x: 0.5, y: 0 })).toBe(false);
  expect(f.control.click({ x: 0.5, y: 0 })).toBe(true);
  f.control.dispose();
});

test('pausing and resuming cancels an async text sequence without continuing old characters', async () => {
  const f = fixture();
  f.activate();
  const oldTyping = f.control.typeText('AB');
  expect(f.inputs()).toEqual(remoteShortcut(['ShiftLeft', 'KeyA']));
  f.control.setInputEnabled(false);
  f.control.setInputEnabled(true);
  await jest.advanceTimersByTimeAsync(32);
  expect(await oldTyping).toBe(false);
  expect(f.inputs()).toEqual(remoteShortcut(['ShiftLeft', 'KeyA']));
  const newTyping = f.control.typeText('C');
  await jest.advanceTimersByTimeAsync(32);
  expect(await newTyping).toBe(true);
  expect(f.inputs()).toEqual([
    ...remoteShortcut(['ShiftLeft', 'KeyA']),
    ...remoteShortcut(['ShiftLeft', 'KeyC']),
  ]);
  f.control.dispose();
});
