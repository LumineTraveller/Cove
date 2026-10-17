import TestRenderer, {act} from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {Socket} from 'socket.io-client';
import {serverFetch} from '../src/features/connection/serverSecurity';
import {useSoundboard, type SoundboardController, type SoundboardOptions} from '../src/features/soundpacks/useSoundboard';
import {groupsStorageKey, favoritesStorageKey} from '../src/features/soundpacks/soundpackGroups';
import {cancelOperations} from '../src/features/soundpacks/soundpackFiles';
import type {Soundpack} from '../src/types';

jest.mock('../src/features/connection/serverSecurity', () => ({...jest.requireActual('../src/features/connection/serverSecurity'), serverFetch: jest.fn()}));
jest.mock('../src/features/soundpacks/soundpackFiles', () => ({cancelOperations: jest.fn(async () => undefined)}));
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
  const event = async (name: string, payload: unknown) => {await act(async () => events.get(name)!({roomId: options.roomId, ...(payload as object)}));};
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
  test('restored local groups reconcile deleted/new sounds and preserve empty groups', async () => {
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async key => String(key).includes('groups') ? JSON.stringify({version: 1, groups: [{id: 'one', soundIds: ['gone', 'a']}, {id: 'two', soundIds: ['b']}, {id: 'empty', soundIds: []}]}) : null);
    await mount(); expect(board.groups).toEqual([{id: 'one', soundIds: ['a', 'c']}, {id: 'two', soundIds: ['b']}, {id: 'empty', soundIds: []}]);
  });
  test('moving across groups submits complete order only once and commits local membership', async () => {
    await mount(); await act(async () => board.addSoundpackGroup());
    const next = board.groups[1].id; let callback: (value: unknown) => void = () => undefined;
    emit.mockImplementation((_name, _payload, cb) => {callback = cb;});
    await act(async () => {board.moveSound('b', next, 0); board.moveSound('a', next, 0);});
    expect(emit).toHaveBeenCalledTimes(1); expect(emit.mock.calls[0][1]).toEqual({roomId: 'fixture-room', orderedIds: ['a', 'c', 'b']});
    await act(async () => callback({ok: true})); expect(board.groups[1].soundIds).toEqual(['b']); expect(board.busy).toBeNull();
  });
  test('failed reorder retains concurrent addition and deletion while restoring the original order', async () => {
    await mount(); let cb: (value: unknown) => void = () => undefined; emit.mockImplementation((_name, _payload, callback) => {cb = callback;});
    await act(async () => {board.moveSound('a', board.groups[0].id, 2);});
    await event('soundpack:added', sound('new')); await event('soundpack:deleted', {soundId: 'b'});
    await act(async () => cb({ok: false, error: '合成顺序拒绝'}));
    expect(board.packs.map(pack => pack.id)).toEqual(['a', 'c', 'new']); expect(board.groups[0].soundIds).toEqual(['a', 'c', 'new']);
    expect(board.notice).toBe('合成顺序拒绝');
  });
  test('a failed pending reorder cannot overwrite another client authoritative order', async () => {
    await mount(); let cb: (value: unknown) => void = () => undefined; emit.mockImplementation((_name, _payload, callback) => {cb = callback;});
    await act(async () => {board.moveSound('a', board.groups[0].id, 2);});
    await event('soundpack:reordered', {orderedIds: ['b', 'a', 'c']}); await act(async () => cb({error: '拒绝', ok: false}));
    expect(board.packs.map(pack => pack.id)).toEqual(['b', 'a', 'c']); expect(board.groups[0].soundIds).toEqual(['b', 'a', 'c']);
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
  test('switching account ignores old reorder rollback and never overwrites new saved groups', async () => {
    const bobGroups = {version: 1, groups: [{id: 'bob', soundIds: ['c','b','a']}]};
    (AsyncStorage.getItem as jest.Mock).mockImplementation(async key => key === groupsStorageKey(options.serverURL, 'bob', options.roomId) ? JSON.stringify(bobGroups) : null);
    await mount(); let cb: (value: unknown) => void = () => undefined; emit.mockImplementation((_name, _payload, callback) => {cb = callback;});
    await act(async () => {board.moveSound('a', board.groups[0].id, 2);}); await rerender({accountId: 'bob'});
    await act(async () => cb({ok: false, error: '旧账号拒绝'})); expect(board.groups).toEqual([{id: 'bob', soundIds: ['a','b','c']}]); expect(board.notice).toBeNull();
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
    expect(board.groups).toEqual([{id: 'saved-one', soundIds: ['b','a']}, {id: 'saved-two', soundIds: ['c']}]);
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
      ] as const) await act(async () => events.get(name)!(payload));
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
