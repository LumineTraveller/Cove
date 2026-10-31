import TestRenderer, {act} from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {Socket} from 'socket.io-client';
import {serverFetch} from '../src/features/connection/serverSecurity';
import {useSoundboard, type SoundboardController, type SoundboardOptions} from '../src/features/soundpacks/useSoundboard';
import {groupsStorageKey, favoritesStorageKey} from '../src/features/soundpacks/soundpackGroups';
import {cancelOperations} from '../src/features/soundpacks/soundpackFiles';
import {preparedSoundpacks} from '../src/features/soundpacks/preparedSoundpacks';
import type {Soundpack} from '../src/types';

jest.mock('../src/features/connection/serverSecurity', () => ({...jest.requireActual('../src/features/connection/serverSecurity'), serverFetch: jest.fn()}));
jest.mock('../src/features/soundpacks/soundpackFiles', () => ({cancelOperations: jest.fn(async () => undefined)}));
jest.mock('../src/features/soundpacks/preparedSoundpacks', () => ({preparedSoundpacks: {configure: jest.fn(), clear: jest.fn(), prepare: jest.fn(async () => false)}}));
const sound = (id: string, canDelete = true, roomId = 'fixture-room'): Soundpack & {roomId: string} => ({id, roomId, name: id, filename: `${id}.normalized.mp3`, originalFilename: `${id}.wav`, uploader: 'Synthetic', sortOrder: 0, createdAt: 0, canDelete});
const deferred = <T,>() => {let resolve!: (value: T) => void; const promise = new Promise<T>(yes => {resolve = yes;}); return {promise, resolve};};
const response = (list: Soundpack[], roomId = 'fixture-room') => ({ok: true, json: async () => ({roomId, soundpacks: list})});

describe('soundboard existing wire protocol and lifecycle', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  let board: SoundboardController;
  let options: SoundboardOptions;
  let events: Map<string, (...args: any[]) => void>;
  let emit: jest.Mock;
  function Harness() {board = useSoundboard(options); return null;}
  const mount = async () => {await act(async () => {renderer = TestRenderer.create(<Harness/>);});};
  const rerender = async (next: Partial<SoundboardOptions>) => {options = {...options, ...next}; await act(async () => renderer.update(<Harness/>));};
  const event = async (name: string, payload: unknown) => {await act(async () => events.get(name)?.({roomId: options.roomId, ...(payload as object)}));};
  beforeEach(() => {
    jest.clearAllMocks();
    events = new Map();
    emit = jest.fn((_event, _payload, callback) => callback({ok: true}));
    const socket = {id: 'synthetic-self', connected: true, emit, on: jest.fn((name, fn) => events.set(name, fn)), off: jest.fn((name, fn) => {if (events.get(name) === fn) events.delete(name);})} as unknown as Socket;
    options = {socket, roomId: 'fixture-room', serverURL: 'http://fixture.test/cove', accountId: 'alice', accountToken: 'synthetic-account-token', ready: true, inVoice: false};
    (serverFetch as jest.Mock).mockResolvedValue(response([sound('a'), sound('b'), sound('c')]));
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
    (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
  });
  afterEach(async () => {if (renderer) await act(async () => renderer.unmount()); jest.useRealTimers();});

  test('list management is available without microphone while playback remains gated', async () => {
    await mount(); expect(board.canManage).toBe(true); expect(board.groups[0].soundIds).toEqual(['a', 'b', 'c']);
    await act(async () => board.triggerSound(board.packs[0])); expect(emit).not.toHaveBeenCalled();
    await act(async () => {await board.renameSound('a', '中文新名称');}); expect(emit).toHaveBeenCalledWith('soundpack:rename', {roomId: 'fixture-room', soundId: 'a', name: '中文新名称'}, expect.any(Function));
    expect(board.packs[0].name).toBe('中文新名称');
  });
  test('prepares a bounded set only after joining voice and revokes the old credential session', async () => {
    (serverFetch as jest.Mock).mockResolvedValue(response(Array.from({length: 12}, (_, index) => sound(`s${index}`))));
    await mount();
    expect(preparedSoundpacks!.prepare).not.toHaveBeenCalled();
    await rerender({inVoice: true});
    const oldSession = board.playbackSession;
    expect(preparedSoundpacks!.configure).toHaveBeenCalledWith(oldSession);
    expect(preparedSoundpacks!.prepare).toHaveBeenCalledTimes(6);
    expect(preparedSoundpacks!.prepare).toHaveBeenCalledWith(oldSession, expect.objectContaining({roomId: 'fixture-room', soundId: 's0', version: 's0.normalized.mp3', headers: expect.objectContaining({'x-cove-account-token': 'synthetic-account-token'})}));
    await event('soundpack:play', {soundId: 's0'});
    expect(board.playback?.soundId).toBe('s0');
    const stalePlay = events.get('soundpack:play')!;
    await rerender({accountToken: 'renewed-token'});
    expect(board.playback).toBeNull();
    await act(async () => stalePlay({roomId: 'fixture-room', soundId: 's0'}));
    expect(board.playback).toBeNull();
    expect(board.playbackSession).not.toBe(oldSession);
    expect(preparedSoundpacks!.clear).toHaveBeenCalledWith(oldSession);
    const last = (preparedSoundpacks!.prepare as jest.Mock).mock.calls.at(-1)!;
    expect(last[0]).toBe(board.playbackSession);
    expect(last[1].headers['x-cove-account-token']).toBe('renewed-token');
    const nextSession = board.playbackSession;
    await rerender({inVoice: false});
    expect(preparedSoundpacks!.clear).toHaveBeenCalledWith(nextSession);
    const calls = (preparedSoundpacks!.prepare as jest.Mock).mock.calls.length;
    await act(async () => board.warmSound(board.packs[0]));
    expect(preparedSoundpacks!.prepare).toHaveBeenCalledTimes(calls);
  });
  test('restored local groups reconcile deleted/new sounds and preserve empty groups', async () => {
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async key => String(key).includes('groups') ? JSON.stringify({version: 1, groups: [{id: 'one', soundIds: ['gone', 'a']}, {id: 'two', soundIds: ['b']}, {id: 'empty', soundIds: []}]}) : null);
    await mount(); expect(board.groups).toEqual([{id: 'one', soundIds: ['a', 'c']}, {id: 'two', soundIds: ['b']}, {id: 'empty', soundIds: []}]);
  });
  test('moving sounds and exchanging groups are immediate personal preferences with no reorder emission', async () => {
    await mount(); await act(async () => board.addSoundpackGroup());
    const next = board.groups[1].id;
    await act(async () => {board.moveSound('b', next, 0); board.moveSound('a', next, 0);});
    expect(board.groups[1].soundIds).toEqual(['a', 'b']);
    expect(board.packs.map(pack => pack.id)).toEqual(['c', 'a', 'b']);
    await act(async () => board.swapGroups(board.groups[0].id, next));
    expect(board.packs.map(pack => pack.id)).toEqual(['a', 'b', 'c']);
    expect(emit).not.toHaveBeenCalled(); expect(board.busy).toBeNull();
  });
  test('a personally reordered sound retains prepared playback and server version handling', async () => {
    await mount(); await rerender({inVoice: true});
    await act(async () => board.moveSound('c', board.groups[0].id, 0));
    expect(board.packs.map(pack => pack.id)).toEqual(['c', 'a', 'b']);
    const session = board.playbackSession;
    await act(async () => board.triggerSound(board.packs[0]));
    expect(preparedSoundpacks!.prepare).toHaveBeenCalledWith(session, expect.objectContaining({soundId: 'c', version: 'c.normalized.mp3'}));
    expect(emit).toHaveBeenCalledWith('soundpack:play', {soundId: 'c', roomId: options.roomId}, expect.any(Function));
    expect(emit.mock.calls.every(([name]) => name !== 'soundpack:reorder')).toBe(true);
    await event('soundpack:play', {soundId: 'c', filename: 'server-c.normalized.mp3'});
    expect(board.playback).toMatchObject({soundId: 'c', version: 'server-c.normalized.mp3', requestedAt: expect.any(Number)});
    await event('soundpack:normalized', {soundId: 'c', filename: 'new-c.normalized.mp3'});
    expect(board.playback).toBeNull();
    expect(board.packs[0].filename).toBe('new-c.normalized.mp3');
  });
  test('local reorder survives legacy shared reorder, addition and deletion broadcasts', async () => {
    await mount();
    await act(async () => board.moveSound('a', board.groups[0].id, 2));
    await event('soundpack:reordered', {orderedIds: ['c', 'a', 'b']});
    await event('soundpack:added', sound('new')); await event('soundpack:deleted', {soundId: 'b'});
    expect(board.groups[0].soundIds).toEqual(['c', 'a', 'new']);
    expect(board.packs.map(pack => pack.id)).toEqual(['c', 'a', 'new']);
    expect(emit).not.toHaveBeenCalled();
  });
  test('refreshing an old server snapshot retains the personal order and appends new content', async () => {
    await mount(); await act(async () => board.moveSound('a', board.groups[0].id, 2));
    (serverFetch as jest.Mock).mockResolvedValue(response([sound('new'), sound('a'), sound('c')]));
    await act(async () => board.reload());
    expect(board.groups[0].soundIds).toEqual(['c', 'a', 'new']);
    expect(board.packs.map(pack => pack.id)).toEqual(['c', 'a', 'new']);
    expect(emit).not.toHaveBeenCalled();
  });
  test('two simultaneous members customize independently while receiving the same content changes', async () => {
    const secondEvents = new Map<string, (...args: any[]) => void>();
    const secondEmit = jest.fn();
    const secondOptions = {...options, accountId: 'bob', socket: {
      ...options.socket, id: 'synthetic-bob', emit: secondEmit,
      on: jest.fn((name, fn) => secondEvents.set(name, fn)),
      off: jest.fn((name, fn) => {if (secondEvents.get(name) === fn) secondEvents.delete(name);}),
    } as unknown as Socket};
    let bob!: SoundboardController;
    function Bob() {bob = useSoundboard(secondOptions); return null;}
    await mount();
    let bobRenderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {bobRenderer = TestRenderer.create(<Bob/>);});
    try {
      await act(async () => board.moveSound('a', board.groups[0].id, 2));
      expect(bob.groups[0].soundIds).toEqual(['a', 'b', 'c']);
      await act(async () => bob.moveSound('c', bob.groups[0].id, 0));
      expect(board.groups[0].soundIds).toEqual(['b', 'c', 'a']);
      expect(bob.groups[0].soundIds).toEqual(['c', 'a', 'b']);
      await act(async () => {
        for (const handlers of [events, secondEvents]) {
          handlers.get('soundpack:reordered')?.({roomId: options.roomId, orderedIds: ['a', 'b', 'c']});
          handlers.get('soundpack:added')!(sound('new'));
          handlers.get('soundpack:deleted')!({roomId: options.roomId, soundId: 'b'});
          handlers.get('soundpack:renamed')!({roomId: options.roomId, soundId: 'a', name: 'Shared name'});
        }
      });
      expect(board.groups[0].soundIds).toEqual(['c', 'a', 'new']);
      expect(bob.groups[0].soundIds).toEqual(['c', 'a', 'new']);
      expect(board.packs.find(pack => pack.id === 'a')?.name).toBe('Shared name');
      expect(bob.packs.find(pack => pack.id === 'a')?.name).toBe('Shared name');
      expect(emit).not.toHaveBeenCalled(); expect(secondEmit).not.toHaveBeenCalled();
    } finally {await act(async () => bobRenderer.unmount());}
  });
  test('lists beyond 500 sounds reorder locally and remain intact after server refresh', async () => {
    const ids = Array.from({length: 751}, (_, index) => `sound-${index}`);
    (serverFetch as jest.Mock).mockResolvedValue(response(ids.map(id => sound(id))));
    await mount(); await act(async () => board.moveSound(ids[0], board.groups[0].id, ids.length - 1));
    await act(async () => board.reload());
    expect(board.groups[0].soundIds).toEqual([...ids.slice(1), ids[0]]);
    expect(board.packs).toHaveLength(ids.length); expect(emit).not.toHaveBeenCalled();
  });
  test('rename and normalize broadcasts retain original audio and deleted playing sound stops', async () => {
    await mount(); await rerender({inVoice: true}); await event('soundpack:renamed', {soundId: 'a', name: '重命名'});
    await event('soundpack:normalized', {soundId: 'a', filename: 'new.mp3'}); expect(board.packs[0]).toMatchObject({name: '重命名', filename: 'new.mp3', originalFilename: 'a.wav'});
    await event('soundpack:play', {soundId: 'a', filename: 'new.mp3'}); expect(board.playback?.uri).toBe('http://fixture.test/cove/api/soundpacks/a/file?roomId=fixture-room&variant=playback');
    await event('soundpack:deleted', {soundId: 'a'}); expect(board.playback).toBeNull();
  });
  test('plays only server broadcast and rejects stale native completion/error callbacks', async () => {
    await mount(); await rerender({inVoice: true}); await act(async () => board.triggerSound(board.packs[0])); expect(board.playback).toBeNull();
    await event('soundpack:play', {soundId: 'a', filename: 'a.mp3'}); const oldKey = board.playback!.key; const oldEnd = board.playbackEnded;
    await event('soundpack:play', {soundId: 'b', filename: 'b.mp3'}); await act(async () => oldEnd(oldKey, true));
    expect(board.playback?.soundId).toBe('b'); expect(board.notice).toBeNull();
  });
  test('leaving voice stops sound and ignores queued play until a new voice session', async () => {
    await mount(); await rerender({inVoice: true}); await event('soundpack:play', {soundId: 'a', filename: 'a.mp3'});
    await rerender({inVoice: false}); await event('soundpack:play', {soundId: 'b', filename: 'b.mp3'}); expect(board.playback).toBeNull();
    await rerender({ready: false}); expect(board.canManage).toBe(false);
  });
  test('ACK timeout shows recoverable error and releases duplicate-play guard', async () => {
    await mount(); await rerender({inVoice: true}); jest.useFakeTimers(); emit.mockImplementation(() => undefined);
    await act(async () => {board.triggerSound(board.packs[0]); board.triggerSound(board.packs[0]);}); expect(emit).toHaveBeenCalledTimes(1);
    await act(async () => {jest.advanceTimersByTime(7500);}); expect(board.notice).toContain('超时');
    emit.mockImplementation((_name, _payload, cb) => cb({ok: true})); await act(async () => board.triggerSound(board.packs[0])); expect(emit).toHaveBeenCalledTimes(2);
  });
  test('favorites cap at six and deletion removes obsolete preference', async () => {
    (serverFetch as jest.Mock).mockResolvedValue(response(['a','b','c','d','e','f','g'].map(id => sound(id))));
    await mount(); await act(async () => ['a','b','c','d','e','f','g'].forEach(id => board.toggleFavorite(id)));
    expect(board.favorites).toEqual(['a','b','c','d','e','f']); expect(board.notice).toContain('最多收藏');
    await event('soundpack:deleted', {soundId: 'a'}); expect(board.favorites).not.toContain('a');
  });
  test('stale HTTP list reloads after a live event rather than overwriting it', async () => {
    const pending = deferred<any>(); (serverFetch as jest.Mock).mockReturnValueOnce(pending.promise).mockResolvedValue(response([sound('new'), sound('a')]));
    await mount(); await event('soundpack:added', sound('new')); await act(async () => pending.resolve(response([sound('a')])));
    expect(serverFetch).toHaveBeenCalledTimes(2); expect(board.packs.map(pack => pack.id)).toEqual(['new','a']);
  });
  test('switching account retains each saved order and rejects departed callbacks and content events', async () => {
    const values = new Map<string, string>([[groupsStorageKey(options.serverURL, 'bob', options.roomId), JSON.stringify({version: 1, groups: [{id: 'bob', soundIds: ['c','b','a']}]})]]);
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async key => values.get(key) ?? null);
    (AsyncStorage.setItem as jest.Mock).mockImplementation(async (key, value) => {values.set(key, value);});
    await mount(); await act(async () => board.moveSound('a', board.groups[0].id, 2));
    const oldMove = board.moveSound;
    const oldAdded = events.get('soundpack:added')!;
    await rerender({accountId: 'bob'});
    await act(async () => {oldMove('a', 'bob', 0); oldAdded(sound('late'));});
    expect(board.groups).toEqual([{id: 'bob', soundIds: ['c','b','a']}]);
    await rerender({accountId: 'alice'});
    await act(async () => oldAdded(sound('late-again')));
    expect(board.groups[0].soundIds).toEqual(['b','c','a']);
    expect(emit).not.toHaveBeenCalled(); expect(board.notice).toBeNull();
  });
  test('permissions returned by server gate rename/delete and duplicate management requests', async () => {
    (serverFetch as jest.Mock).mockResolvedValue(response([sound('a', false), sound('b')])); await mount();
    await act(async () => {await board.deleteSound('a');}); expect(emit).not.toHaveBeenCalled();
    let cb: (value: unknown) => void = () => undefined; emit.mockImplementation((_name, _payload, callback) => {cb = callback;});
    await act(async () => {board.deleteSound('b'); board.deleteSound('b');}); expect(emit).toHaveBeenCalledTimes(1);
    await act(async () => cb({ok: true})); expect(board.packs.map(pack => pack.id)).toEqual(['a']);
  });
  test('volume is bounded, persisted and can reach silence', async () => {
    await mount(); await act(async () => board.updateVolume(0)); expect(board.volume).toBe(0); expect(AsyncStorage.setItem).toHaveBeenCalledWith('cove:soundpack-volume', '0');
    await act(async () => board.updateVolume(2)); expect(board.volume).toBe(1);
  });
  test('reorder before preference hydration cannot replace stored group boundaries', async () => {
    const saved = deferred<string>();
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async key => String(key).includes('groups') ? saved.promise : null);
    await mount(); await event('soundpack:reordered', {orderedIds: ['b','a','c']});
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    await act(async () => saved.resolve(JSON.stringify({version: 1, groups: [{id: 'saved-one', soundIds: ['a','b']}, {id: 'saved-two', soundIds: ['c']}]})));
    expect(board.groups).toEqual([{id: 'saved-one', soundIds: ['a','b']}, {id: 'saved-two', soundIds: ['c']}]);
  });
  test('old play ACK after reconnect cannot release the new pending-play guard', async () => {
    await mount(); await rerender({inVoice: true}); const callbacks: ((value: unknown) => void)[] = [];
    emit.mockImplementation((_name, _payload, cb) => callbacks.push(cb));
    await act(async () => {board.triggerSound(board.packs[0]);}); await rerender({ready: false}); await rerender({ready: true});
    await act(async () => {board.triggerSound(board.packs[0]);});
    await act(async () => callbacks[0]({ok: false, error: '旧会话错误'}));
    await act(async () => {board.triggerSound(board.packs[0]);});
    expect(emit).toHaveBeenCalledTimes(2); expect(board.notice).toBeNull();
    await act(async () => callbacks[1]({ok: true}));
  });
  test('room A to B to A retains independent groups and favorites without assigning old global preferences', async () => {
    const values = new Map<string, string>();
    const oldGroups = 'cove:soundpack-groups:v1:' + encodeURIComponent(options.serverURL) + ':alice';
    const oldFavorites = 'cove:soundpack-favorites:' + encodeURIComponent(options.serverURL) + ':alice';
    values.set(oldGroups, JSON.stringify({version: 1, groups: [{id: 'unassigned', soundIds: ['a']}]}));
    values.set(oldFavorites, JSON.stringify(['a']));
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async key => values.get(key) ?? null);
    (AsyncStorage.setItem as jest.Mock).mockImplementation(async (key, value) => { values.set(key, value); });
    (serverFetch as jest.Mock).mockImplementation(async (_base, path) => String(path).includes('roomId=second-room')
      ? response([sound('b', true, 'second-room')], 'second-room') : response([sound('a')]));
    await mount();
    expect(board.favorites).toEqual([]);
    expect(board.groups[0].id).toBe('default');
    await act(async () => { board.toggleFavorite('a'); board.addSoundpackGroup(); });
    const firstGroups = board.groups;
    await rerender({roomId: 'second-room'});
    expect(board.packs.map(pack => pack.id)).toEqual(['b']);
    expect(board.favorites).toEqual([]);
    expect(board.groups).toEqual([{id: 'default', soundIds: ['b']}]);
    await act(async () => board.toggleFavorite('b'));
    await rerender({roomId: 'fixture-room'});
    expect(board.favorites).toEqual(['a']);
    expect(board.groups).toEqual(firstGroups);
    expect(JSON.parse(values.get(oldFavorites)!)).toEqual(['a']);
    expect(JSON.parse(values.get(oldGroups)!).groups[0].id).toBe('unassigned');
    expect(AsyncStorage.getItem).not.toHaveBeenCalledWith(oldGroups);
    expect(AsyncStorage.getItem).not.toHaveBeenCalledWith(oldFavorites);
    expect(values.get(favoritesStorageKey(options.serverURL, 'alice', 'second-room'))).toBe(JSON.stringify(['b']));
  });
  test('all unscoped or other-room events are ignored including authoritative playback', async () => {
    await mount(); await rerender({inVoice: true});
    const before = JSON.stringify(board.packs);
    for (const roomId of [undefined, 'another-room']) {
      for (const [name, payload] of [
        ['soundpack:added', {...sound('intruder'), roomId}], ['soundpack:deleted', {soundId: 'a', roomId}],
        ['soundpack:renamed', {soundId: 'a', name: 'foreign', roomId}], ['soundpack:normalized', {soundId: 'a', filename: 'foreign.mp3', roomId}],
        ['soundpack:reordered', {orderedIds: ['c', 'b', 'a'], roomId}], ['soundpack:play', {soundId: 'a', filename: 'foreign.mp3', roomId}],
      ] as const) await act(async () => events.get(name)?.(payload));
    }
    expect(JSON.stringify(board.packs)).toBe(before);
    expect(board.playback).toBeNull();
    await event('soundpack:play', {soundId: 'a'});
    expect(new Headers(board.playback!.headers).get('X-Cove-Account-Token')).toBe(options.accountToken);
    expect(board.playback!.uri).toContain('/api/soundpacks/a/file?roomId=fixture-room');
  });
  test('switching rooms clears visible state and native work before the next list arrives', async () => {
    await mount(); await rerender({inVoice: true});
    await act(async () => board.toggleFavorite('a'));
    await event('soundpack:play', {soundId: 'a'});
    const stalePlay = events.get('soundpack:play')!;
    const staleSource = board.fileSource;
    const staleDelete = board.deleteSound;
    const pending = deferred<any>();
    (serverFetch as jest.Mock).mockReturnValueOnce(pending.promise);
    const previousCancels = (cancelOperations as jest.Mock).mock.calls.length;
    await rerender({roomId: 'second-room'});
    expect(board.packs).toEqual([]); expect(board.favorites).toEqual([]);
    expect(board.groups.every(group => group.soundIds.length === 0)).toBe(true);
    expect(board.playback).toBeNull(); expect(board.ready).toBe(false);
    expect(cancelOperations).toHaveBeenCalledTimes(previousCancels + 1);
    await act(async () => stalePlay({roomId: 'fixture-room', soundId: 'a'}));
    expect(board.playback).toBeNull();
    expect(() => staleSource('a', 'original')).toThrow();
    await act(async () => pending.resolve(response([sound('a', true, 'second-room')], 'second-room')));
    expect(board.packs.map(pack => pack.id)).toEqual(['a']);
    await act(async () => expect(staleDelete('a')).resolves.toBe(false));
    expect(emit).not.toHaveBeenCalled();
  });
  test('an aborted old-room HTTP list cannot refill a new room or its preferences', async () => {
    const old = deferred<any>();
    (serverFetch as jest.Mock).mockReturnValueOnce(old.promise).mockResolvedValue(response([sound('second', true, 'second-room')], 'second-room'));
    await mount();
    const oldSignal = (serverFetch as jest.Mock).mock.calls[0][2].signal;
    await rerender({roomId: 'second-room'});
    expect(oldSignal.aborted).toBe(true);
    await act(async () => old.resolve(response([sound('old')])));
    expect(board.packs.map(pack => pack.id)).toEqual(['second']);
    expect(board.groups[0].soundIds).toEqual(['second']);
  });
  test.each(['legacy-array', 'wrong-room', 'mixed-room'])('unconfirmed server list %s fails closed and disables uploads/management', async kind => {
    const body = kind === 'legacy-array' ? [] : kind === 'wrong-room'
      ? {roomId: 'another-room', soundpacks: []} : {roomId: options.roomId, soundpacks: [sound('x', true, 'another-room')]};
    (serverFetch as jest.Mock).mockResolvedValue({ok: true, json: async () => body});
    await mount();
    expect(board.ready).toBe(false); expect(board.canManage).toBe(false); expect(board.packs).toEqual([]);
    expect(board.loadError).toContain('隔离');
    expect(() => board.requestInit({method: 'POST'})).toThrow();
    expect(emit).not.toHaveBeenCalled();
  });

});
