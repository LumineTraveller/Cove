import assert from 'node:assert/strict';
import test from 'node:test';

import { ANNOTATION_LIMITS, createAnnotationService } from '../src/features/annotations/annotationService';

const ROOM = 'room-1';
const OWNER = 'owner-1';
const VIEWER = 'viewer-1';

function setup(extraMembers: string[] = []) {
  const activeSessions = new Map([[`${ROOM}:${OWNER}`, 'screen-1']]);
  const members = new Set([OWNER, VIEWER, ...extraMembers]);
  const roomMembers = new Map([[ROOM, members]]);
  const events: Array<{ roomId: string; event: string; payload: any; volatile: boolean }> = [];
  const emittedStops: Array<{ socketId: string; reason: string }> = [];
  let timestamp = 10_000;
  const io = {
    to: (roomId: string) => {
      const emit = (event: string, payload: unknown) =>
        events.push({ roomId, event, payload, volatile: false });
      return {
        emit,
        volatile: {
          emit: (event: string, payload: unknown) =>
            events.push({ roomId, event, payload, volatile: true }),
        },
      };
    },
  };
  const service = createAnnotationService({
    io: io as never,
    roomMembers,
    userNames: new Map([[OWNER, 'Owner'], [VIEWER, 'Viewer']]),
    currentScreenSessionId: (roomId, socketId) =>
      activeSessions.get(`${roomId}:${socketId}`) ?? null,
    stopRemoteControlForSocket: (socketId, reason) => emittedStops.push({ socketId, reason }),
    now: () => timestamp,
  });
  const target = { roomId: ROOM, sharerSocketId: OWNER, sessionId: 'screen-1' };
  const getTarget = { roomId: ROOM, sharerSocketId: OWNER };
  return {
    service,
    activeSessions,
    members,
    events,
    emittedStops,
    target,
    getTarget,
    advanceTime: (ms: number) => { timestamp += ms; },
  };
}

function stroke(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    tool: 'pen' as const,
    color: '#cc3300',
    width: 0.004,
    points: [{ x: 0.25, y: 0.75 }],
    ...extra,
  };
}

function enableRequestMode(s: ReturnType<typeof setup>) {
  s.service.get(s.target, OWNER);
  const ack = s.service.configure(
    { target: s.target, enabled: true, permission: 'request' },
    OWNER,
  ).ack;
  assert.equal(ack.ok, true);
}

test('permissions and author identity are enforced by the server', () => {
  const s = setup(['intruder-1']);
  assert.equal(s.service.get(s.getTarget, OWNER).state?.enabled, false);
  enableRequestMode(s);

  const denied = s.service.draw(
    { target: s.target, stroke: stroke('forged', { authorSocketId: OWNER }) as never },
    VIEWER,
  ).ack;
  assert.equal(denied.ok, false);
  assert.equal(denied.error?.code, 'forbidden');

  assert.equal(s.service.request(s.target, VIEWER).ack.ok, true);
  const notOwner = s.service.respond(
    { target: s.target, requesterSocketId: VIEWER, accepted: true },
    'intruder-1',
  ).ack;
  assert.equal(notOwner.error?.code, 'forbidden');

  const approved = s.service.respond(
    { target: s.target, requesterSocketId: VIEWER, accepted: true },
    OWNER,
  ).ack;
  assert.equal(approved.ok, true);
  assert.equal(approved.state?.grants.includes(VIEWER), true);

  const drawn = s.service.draw(
    { target: s.target, stroke: stroke('forged', { authorSocketId: OWNER }) as never },
    VIEWER,
  ).ack;
  assert.equal(drawn.ok, true);
  const snapshot = s.service.get(s.target, OWNER);
  assert.equal(snapshot.state?.strokes[0]?.authorSocketId, VIEWER);
  assert.equal(snapshot.state?.strokes[0]?.color, '#CC3300');

  const changed = s.service.configure({ target: s.target, permission: 'everyone' }, 'intruder-1').ack;
  assert.equal(changed.error?.code, 'forbidden');
  const outside = s.service.get({ roomId: 'other-room', sharerSocketId: OWNER }, 'intruder-1');
  assert.equal(outside.error?.code, 'forbidden');
});

test('screen generations isolate old operations and cleanup sends a disabled empty snapshot', () => {
  const s = setup();
  enableRequestMode(s);
  s.service.request(s.target, VIEWER);
  s.service.respond({ target: s.target, requesterSocketId: VIEWER, accepted: true }, OWNER);
  assert.equal(s.service.draw({ target: s.target, stroke: stroke('old') }, VIEWER).ack.ok, true);

  s.activeSessions.set(`${ROOM}:${OWNER}`, 'screen-2');
  const stale = s.service.draw({ target: s.target, stroke: stroke('late-old') }, VIEWER).ack;
  assert.equal(stale.error?.code, 'invalid_target');

  const next = s.service.get({ roomId: ROOM, sharerSocketId: OWNER }, OWNER).state;
  assert.equal(next?.sessionId, 'screen-2');
  assert.equal(next?.enabled, false);
  assert.deepEqual(next?.strokes, []);
  assert.deepEqual(next?.grants, []);

  s.service.endForSocket(OWNER, ROOM, 'screen-1');
  assert.equal(s.service.sessionCount(), 1);
  const ended = s.events.filter((event) => event.event === 'annotation:state').at(-1)?.payload;
  assert.equal(ended.sessionId, 'screen-1');
  assert.equal(ended.enabled, false);
  assert.deepEqual(ended.strokes, []);
  assert.deepEqual(ended.grants, []);
  assert.deepEqual(ended.requests, []);

  s.service.endForSocket(OWNER, ROOM, 'screen-2');
  assert.equal(s.service.sessionCount(), 0);
});

test('draw chunks, request lists, point bounds, and per-socket event rates are capped', () => {
  const s = setup(Array.from({ length: 66 }, (_, index) => `requester-${index}`));
  s.service.get(s.target, OWNER);
  s.service.configure({ target: s.target, enabled: true, permission: 'everyone' }, OWNER);
  for (let index = 0; index < ANNOTATION_LIMITS.drawEventsPerSecond; index += 1) {
    const accepted = s.service.draw(
      { target: s.target, stroke: stroke(`stroke-${index}`) },
      OWNER,
    ).ack;
    assert.equal(accepted.ok, true);
  }
  const overRate = s.service.draw(
    { target: s.target, stroke: stroke('stroke-too-fast') },
    OWNER,
  ).ack;
  assert.equal(overRate.error?.code, 'rate_limited');

  const oversized = s.service.draw(
    {
      target: s.target,
      stroke: stroke('oversized', {
        points: Array.from({ length: ANNOTATION_LIMITS.pointsPerChunk + 1 }, () => ({ x: 0, y: 0 })),
      }),
    },
    OWNER,
  ).ack;
  assert.equal(oversized.error?.code, 'invalid_payload');

  s.advanceTime(1_000);
  const invalidCoordinate = s.service.draw(
    { target: s.target, stroke: stroke('invalid', { points: [{ x: Number.NaN, y: 0.5 }] }) },
    OWNER,
  ).ack;
  assert.equal(invalidCoordinate.error?.code, 'invalid_payload');

  s.service.configure({ target: s.target, permission: 'request' }, OWNER);
  let finalCode: string | undefined;
  for (let index = 0; index < ANNOTATION_LIMITS.requests + 1; index += 1) {
    finalCode = s.service.request(s.target, `requester-${index}`).ack.error?.code;
  }
  assert.equal(finalCode, 'limit_reached');
  assert.equal(s.service.get(s.target, OWNER).state?.requests.length, ANNOTATION_LIMITS.requests);
});

test('stroke count, per-stroke points, and aggregate point ceilings are enforced', () => {
  const strokeBounded = setup();
  strokeBounded.service.get(strokeBounded.target, OWNER);
  strokeBounded.service.configure(
    { target: strokeBounded.target, enabled: true, permission: 'everyone' },
    OWNER,
  );
  for (let chunkIndex = 0; chunkIndex < ANNOTATION_LIMITS.pointsPerStroke / ANNOTATION_LIMITS.pointsPerChunk; chunkIndex += 1) {
    if (chunkIndex > 0 && chunkIndex % ANNOTATION_LIMITS.drawEventsPerSecond === 0)
      strokeBounded.advanceTime(1_000);
    assert.equal(
      strokeBounded.service.draw(
        {
          target: strokeBounded.target,
          stroke: stroke('long-stroke', {
            points: Array.from({ length: ANNOTATION_LIMITS.pointsPerChunk }, () => ({ x: 0.5, y: 0.5 })),
          }),
        },
        OWNER,
      ).ack.ok,
      true,
    );
  }
  strokeBounded.advanceTime(1_000);
  assert.equal(
    strokeBounded.service.draw(
      { target: strokeBounded.target, stroke: stroke('long-stroke') },
      OWNER,
    ).ack.error?.code,
    'limit_reached',
  );

  const totalBounded = setup();
  totalBounded.service.get(totalBounded.target, OWNER);
  totalBounded.service.configure(
    { target: totalBounded.target, enabled: true, permission: 'everyone' },
    OWNER,
  );
  for (let chunkIndex = 0; chunkIndex < ANNOTATION_LIMITS.points / ANNOTATION_LIMITS.pointsPerChunk; chunkIndex += 1) {
    if (chunkIndex > 0 && chunkIndex % ANNOTATION_LIMITS.drawEventsPerSecond === 0)
      totalBounded.advanceTime(1_000);
    assert.equal(
      totalBounded.service.draw(
        {
          target: totalBounded.target,
          stroke: stroke(`stroke-${chunkIndex}`, {
            points: Array.from({ length: ANNOTATION_LIMITS.pointsPerChunk }, () => ({ x: 0.5, y: 0.5 })),
          }),
        },
        OWNER,
      ).ack.ok,
      true,
    );
  }
  totalBounded.advanceTime(1_000);
  assert.equal(
    totalBounded.service.draw(
      { target: totalBounded.target, stroke: stroke('one-too-many') },
      OWNER,
    ).ack.error?.code,
    'limit_reached',
  );

  const strokeCountBounded = setup();
  strokeCountBounded.service.get(strokeCountBounded.target, OWNER);
  strokeCountBounded.service.configure(
    { target: strokeCountBounded.target, enabled: true, permission: 'everyone' },
    OWNER,
  );
  for (let index = 0; index < ANNOTATION_LIMITS.strokes; index += 1) {
    if (index > 0 && index % ANNOTATION_LIMITS.drawEventsPerSecond === 0)
      strokeCountBounded.advanceTime(1_000);
    assert.equal(
      strokeCountBounded.service.draw(
        { target: strokeCountBounded.target, stroke: stroke(`stroke-${index}`) },
        OWNER,
      ).ack.ok,
      true,
    );
  }
  strokeCountBounded.advanceTime(1_000);
  assert.equal(
    strokeCountBounded.service.draw(
      { target: strokeCountBounded.target, stroke: stroke('stroke-too-many') },
      OWNER,
    ).ack.error?.code,
    'limit_reached',
  );
});

test('closing annotation tools locally leaves state intact; producer end clears it and remote control toggle is authoritative', () => {
  const s = setup();
  enableRequestMode(s);
  s.service.request(s.target, VIEWER);
  s.service.respond({ target: s.target, requesterSocketId: VIEWER, accepted: true }, OWNER);
  s.service.draw({ target: s.target, stroke: stroke('persist') }, VIEWER);

  // Local tool exit sends no socket event; another viewer can still read the shared state.
  const late = s.service.get(s.target, VIEWER).state;
  assert.equal(late?.enabled, true);
  assert.equal(late?.strokes.length, 1);
  assert.equal(late?.grants.includes(VIEWER), true);

  const blocked = s.service.configure({ target: s.target, remoteControlAllowed: false }, OWNER).ack;
  assert.equal(blocked.ok, true);
  assert.equal(s.service.remoteControlAllowed(ROOM, OWNER), false);
  assert.deepEqual(s.emittedStops.at(-1), { socketId: OWNER, reason: '共享者已关闭远程控制' });
  const reopened = s.service.configure({ target: s.target, remoteControlAllowed: true }, OWNER).ack;
  assert.equal(reopened.ok, true);
  assert.equal(s.service.remoteControlAllowed(ROOM, OWNER), true);

  s.activeSessions.delete(`${ROOM}:${OWNER}`);
  s.service.endForSocket(OWNER, ROOM, 'screen-1');
  assert.equal(s.service.remoteControlAllowed(ROOM, OWNER), false);
  const ended = s.events.filter((event) => event.event === 'annotation:state').at(-1)?.payload;
  assert.equal(ended.enabled, false);
  assert.deepEqual(ended.strokes, []);
});
