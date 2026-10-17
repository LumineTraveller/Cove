import assert from 'node:assert/strict';
import test from 'node:test';
import { registerRemoteControlSocketHandlers } from '../src/features/remote-control/socketHandlers';
import { RemoteControlRegistry } from '../src/features/remote-control/remoteControl';
import { registerAccountsSocketHandlers } from '../src/features/accounts/socketHandlers';

function fixture() {
  const messages: { to: string; event: string; payload: any }[] = [];
  const socket = (id: string) => ({
    id,
    connected: true,
    data: {} as any,
    handlers: new Map<string, (...args: any[]) => void>(),
    on(event: string, fn: (...args: any[]) => void) {
      this.handlers.set(event, fn);
    },
    emit(event: string, payload: any) {
      messages.push({ to: id, event, payload });
    },
  });
  const mobile = socket('mobile');
  const desktop = socket('desktop');
  const stranger = socket('stranger');
  const sockets = new Map([
    [mobile.id, mobile],
    [desktop.id, desktop],
    [stranger.id, stranger],
  ]);
  const io: any = {
    sockets: { sockets },
    to: (id: string) => ({
      emit: (event: string, payload: any) => messages.push({ to: id, event, payload }),
    }),
  };
  const receiverCapabilities = new Set<string>(['desktop']);
  const ids = ['request', 'session'];
  const registry = new RemoteControlRegistry(() => ids.shift()!);
  const members = new Set(['mobile', 'desktop', 'stranger']);
  const allowed = { value: true };
  const sharing = { value: true };
  const cancelled: any[] = [];
  const stopped: any[] = [];
  const deps: any = {
    roomMembers: new Map([['room', members]]),
    remoteControlCapabilities: receiverCapabilities,
    isSharingScreen: () => sharing.value,
    isRemoteControlAllowed: () => allowed.value,
    remoteControls: registry,
    io,
    userNames: new Map(),
    publicUserId: (id: string) => id,
    emitRemoteRequestCancelled: (request: any, reason: string) =>
      cancelled.push({ request, reason }),
    emitRemoteControlStopped: (session: any, reason: string) => stopped.push({ session, reason }),
  };
  for (const peer of sockets.values())
    registerRemoteControlSocketHandlers({ ...deps, socket: peer });
  const call = (peer: typeof mobile, event: string, payload: any) => {
    let reply: any;
    peer.handlers.get(event)!(payload, (value: any) => {
      reply = value;
    });
    return reply;
  };
  const request = (peer = mobile, target = desktop.id) =>
    call(peer, 'remote-control:request', { roomId: 'room', sharerSocketId: target });
  const accept = () =>
    call(desktop, 'remote-control:respond', { requestId: 'request', accepted: true });
  const register = (
    peer: typeof mobile,
    platform: unknown,
    receiver: unknown,
    controller: unknown,
  ) => {
    const userNames = new Map<string, string>();
    const userAvatars = new Map<string, string | null>();
    const accountSockets = new Map<string, string>();
    registerAccountsSocketHandlers({
      socket: peer,
      io,
      accounts: { accountForToken: () => ({ id: peer.id, username: peer.id, avatarUrl: null }) },
      accountSockets,
      userNames,
      userAvatars,
      userClientIds: new Map(),
      userPlatforms: new Map(),
      remoteControlCapabilities: receiverCapabilities,
      socketAvatarPayload: (_: any, payload: any) => payload,
      cleanupDisconnectedPeer: () => {},
      migrateLegacyIdentity: () => {},
      stmtMigrateLegacyOwnersByName: { run: () => ({ changes: 0 }) },
      stmtUpdateOwnerName: { run: () => ({ changes: 0 }) },
      stmtGetRooms: { all: () => [] },
      emitAvatarPayload: () => {},
      sanitizeProfileAvatar: () => null,
      refreshProfileViews: () => {},
      voiceCounts: () => ({}),
    } as any);
    return call(peer, 'user:register', {
      authToken: 'synthetic-token',
      platform,
      remoteControlSupported: receiver,
      remoteControlControllerSupported: controller,
    });
  };
  return {
    mobile,
    desktop,
    stranger,
    registry,
    receiverCapabilities,
    members,
    allowed,
    sharing,
    cancelled,
    stopped,
    messages,
    call,
    request,
    accept,
    register,
  };
}

test('mobile controller registration is separate from desktop receiver registration', () => {
  const f = fixture();
  assert.equal(f.register(f.mobile, 'mobile', true, true).ok, true);
  assert.equal(f.mobile.data.remoteControlControllerSupported, true);
  assert.equal(f.receiverCapabilities.has('mobile'), false);
  f.register(f.desktop, 'desktop', true, undefined);
  assert.equal(f.receiverCapabilities.has('desktop'), true);
  assert.equal(f.desktop.data.remoteControlControllerSupported, false);
});

test('controller capability is strict boolean and a recognized platform', () => {
  for (const [platform, controller] of [
    ['mobile', 'true'],
    ['unknown', true],
    [null, true],
    ['desktop', false],
  ]) {
    const f = fixture();
    f.register(f.mobile, platform, false, controller);
    assert.equal(f.mobile.data.remoteControlControllerSupported, false);
  }
});

test('disconnect revokes controller capability and valid idempotent registration renegotiates it', () => {
  const f = fixture();
  f.register(f.mobile, 'mobile', false, true);
  f.mobile.handlers.get('disconnect')!();
  assert.equal(f.mobile.data.remoteControlControllerSupported, false);
  f.call(f.mobile, 'user:register', {
    authToken: 'synthetic-token',
    platform: 'mobile',
    remoteControlControllerSupported: true,
  });
  assert.equal(f.mobile.data.remoteControlControllerSupported, true);
});

test('legacy desktop controller still works without a new registration field', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.receiverCapabilities.add('mobile');
  assert.equal(f.request().ok, true);
  assert.equal(f.accept().ok, true);
  assert.equal(
    f.messages.find((m) => m.to === 'mobile' && m.event === 'remote-control:started')?.payload.role,
    'controller',
  );
});

test('controller-only mobile requests desktop control but must wait for desktop acceptance', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.mobile.data.remoteControlControllerSupported = true;
  const request = f.request();
  assert.equal(request.ok, true);
  f.call(f.mobile, 'remote-control:input', {
    sessionId: 'session',
    input: { type: 'pointer', x: 0, y: 0 },
  });
  assert.equal(
    f.messages.some((m) => m.event === 'remote-control:input'),
    false,
  );
  assert.equal(f.accept().ok, true);
  assert.equal(
    f.messages.find((m) => m.event === 'remote-control:started')?.payload.requestId,
    'request',
  );
  f.call(f.mobile, 'remote-control:input', {
    sessionId: 'session',
    input: { type: 'button', button: 'left', down: true, x: 0, y: 0 },
  });
  f.call(f.mobile, 'remote-control:input', {
    sessionId: 'session',
    input: { type: 'button', button: 'left', down: false, x: 0, y: 0 },
  });
  assert.deepEqual(
    f.messages.filter((m) => m.event === 'remote-control:input').map((m) => m.payload.input.down),
    [true, false],
  );
});

test('controller-only mobile cannot become a receiver and unsupported controllers are refused', () => {
  const f = fixture();
  f.mobile.data.remoteControlControllerSupported = true;
  assert.equal(f.request(f.desktop, 'mobile').ok, false);
  assert.equal(f.request(f.stranger).ok, false);
  f.members.delete('mobile');
  assert.equal(f.request().ok, false);
});

test('capability, sharing and permission are rechecked before acceptance', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const revoke of ['controller', 'receiver', 'sharing', 'permission']) {
    const f = fixture();
    f.mobile.data.remoteControlControllerSupported = true;
    assert.equal(f.request().ok, true);
    if (revoke === 'controller') f.mobile.data.remoteControlControllerSupported = false;
    if (revoke === 'receiver') f.receiverCapabilities.delete('desktop');
    if (revoke === 'sharing') f.sharing.value = false;
    if (revoke === 'permission') f.allowed.value = false;
    assert.equal(f.accept().ok, false);
    assert.equal(f.cancelled.length, 1);
    assert.equal(
      f.messages.some((m) => m.event === 'remote-control:started'),
      false,
    );
  }
});

test('input cannot cross participants and revoked controller/receiver stops a live session', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const revoke of ['controller', 'receiver']) {
    const f = fixture();
    f.mobile.data.remoteControlControllerSupported = true;
    f.request();
    f.accept();
    const payload = { sessionId: 'session', input: { type: 'pointer', x: 0.3, y: 0 } };
    f.call(f.stranger, 'remote-control:input', payload);
    assert.equal(
      f.messages.some((m) => m.event === 'remote-control:input'),
      false,
    );
    if (revoke === 'controller') f.mobile.data.remoteControlControllerSupported = false;
    else f.receiverCapabilities.delete('desktop');
    f.call(f.mobile, 'remote-control:input', payload);
    assert.equal(f.stopped.length, 1);
    assert.equal(
      f.messages.some((m) => m.event === 'remote-control:input'),
      false,
    );
  }
});

test('cancelled and declined requests never create sessions', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.mobile.data.remoteControlControllerSupported = true;
  f.request();
  assert.equal(f.call(f.mobile, 'remote-control:cancel', { requestId: 'request' }).ok, true);
  assert.equal(f.accept().ok, false);
  const g = fixture();
  g.mobile.data.remoteControlControllerSupported = true;
  g.request();
  assert.equal(
    g.call(g.desktop, 'remote-control:respond', { requestId: 'request', accepted: false }).ok,
    true,
  );
  assert.equal(
    g.messages.some((m) => m.event === 'remote-control:started'),
    false,
  );
});

test('idempotent capability changes revoke a legacy receiver without affecting independent controller support', () => {
  const f = fixture();
  f.register(f.desktop, 'desktop', true, true);
  f.call(f.desktop, 'user:register', {
    authToken: 'synthetic-token',
    platform: 'desktop',
    remoteControlSupported: false,
    remoteControlControllerSupported: true,
  });
  assert.equal(f.receiverCapabilities.has('desktop'), false);
  assert.equal(f.desktop.data.remoteControlControllerSupported, true);
  f.call(f.desktop, 'user:register', {
    authToken: 'synthetic-token',
    platform: 'desktop',
    remoteControlSupported: true,
    remoteControlControllerSupported: false,
  });
  assert.equal(f.receiverCapabilities.has('desktop'), true);
  assert.equal(f.desktop.data.remoteControlControllerSupported, false);
});
