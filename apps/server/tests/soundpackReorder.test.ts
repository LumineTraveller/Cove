import assert from 'node:assert/strict';
import test from 'node:test';
import { registerSoundpacksSocketHandlers } from '../src/features/soundpacks/socketHandlers';

function fixture(count: number) {
  const current = Array.from({ length: count }, (_, index) => `pack-${index}`);
  const handlers = new Map<string, Function>();
  const writes: string[][] = [];
  const events: unknown[] = [];
  registerSoundpacksSocketHandlers({
    socket: { on: (name: string, handle: Function) => handlers.set(name, handle) },
    access: { socketRoomActor: () => ({ roomId: 'room', clientId: 'account', socketId: 'socket' }) },
    stmtGetSoundpacks: { all: () => current.map(id => ({ id })) },
    reorderSoundpacks: (roomId: string, ids: string[]) => {
      assert.equal(roomId, 'room'); writes.push(ids);
    },
    broadcastSoundpackEvent: (...args: unknown[]) => events.push(args),
  } as any);
  const reorder = (orderedIds: unknown) => {
    let result: { ok: boolean; code?: string } | undefined;
    handlers.get('soundpack:reorder')!({ roomId: 'room', orderedIds }, (response: any) => { result = response; });
    assert.ok(result);
    return result;
  };
  return { current, writes, events, reorder };
}

for (const count of [0, 500, 501, 2000]) {
  test(`a complete room permutation can reorder ${count} soundpacks`, () => {
    const f = fixture(count);
    const ordered = [...f.current].reverse();
    assert.deepEqual(f.reorder(ordered), { ok: true });
    assert.deepEqual(f.writes, [ordered]);
    assert.equal(f.events.length, 1);
  });
}

test('missing, duplicate, stale and foreign IDs never partially reorder a room', () => {
  const f = fixture(501);
  for (const invalid of [f.current.slice(1), [...f.current, 'foreign'], f.current.map(() => f.current[0]), [...f.current.slice(0, -1), 'foreign']]) {
    assert.equal(f.reorder(invalid).code, 'SOUNDPACK_LIST_CHANGED');
  }
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.events, []);
});

test('malformed or unbounded IDs are rejected before a write', () => {
  const f = fixture(1);
  for (const invalid of [null, 'pack-0', [1], [''], ['x'.repeat(129)]]) {
    assert.equal(f.reorder(invalid).code, 'INVALID_REQUEST');
  }
  assert.deepEqual(f.writes, []);
});
