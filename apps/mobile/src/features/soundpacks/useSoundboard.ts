import {useCallback, useEffect, useRef, useState} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {request} from '@cove/client-core';
import type {Socket} from 'socket.io-client';
import type {Soundpack} from '../../types';
import {authorizedResourceURL, serverFetch} from '../connection/serverSecurity';
import {addGroup, applySoundpackOrder, canAddGroup, favoritesStorageKey, flattenGroups, groupsStorageKey, initialGroups, moveSound, orderedGroups, readGroups, reconcileGroups, swapGroups, type SoundpackGroup} from './soundpackGroups';

const VOLUME_KEY = 'cove:soundpack-volume';
// Preserve write order even when the previous screen is still finishing a save.
const writes = new Map<string, Promise<unknown>>();
function store(key: string, value: string) {
  const next = (writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => AsyncStorage.setItem(key, value));
  writes.set(key, next);
  next.finally(() => { if (writes.get(key) === next) writes.delete(key); }).catch(() => undefined);
  return next;
}
const message = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;
export interface SoundboardOptions {socket: Socket; roomId: string; serverURL: string; accountId: string; ready: boolean; inVoice: boolean; outputDeviceId?: string;}
export interface SoundpackPlayback {key: number; soundId: string; uri: string;}

export function useSoundboard({socket, roomId, serverURL, accountId, ready, inVoice, outputDeviceId = 'out-speaker'}: SoundboardOptions) {
  const groupKey = groupsStorageKey(serverURL, accountId);
  const favoriteKey = favoritesStorageKey(serverURL, accountId);
  const scope = `${groupKey}:${roomId}`;
  const [packs, setPacks] = useState<Soundpack[]>([]);
  const [groups, setGroups] = useState<SoundpackGroup[]>(initialGroups);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [volume, setVolume] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [listReady, setListReady] = useState(false);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [playback, setPlayback] = useState<SoundpackPlayback | null>(null);
  const packsRef = useRef(packs);
  const groupsRef = useRef(groups);
  const favoritesRef = useRef(favorites);
  const scopeRef = useRef(scope);
  const readyRef = useRef(ready);
  const voiceRef = useRef(inVoice);
  const mounted = useRef(true);
  const revision = useRef(0);
  const operation = useRef(0);
  const busyRef = useRef<string | null>(null);
  const playPending = useRef(false);
  const playRequestToken = useRef(0);
  const playSequence = useRef(0);
  const playbackRef = useRef(playback);
  playbackRef.current = playback;
  const preferenceRevision = useRef(0);
  const volumeRevision = useRef(0);
  const preferenceScope = useRef<string | null>(null);
  const listScope = useRef<string | null>(null);
  const authoritativeOrder = useRef(0);
  scopeRef.current = scope;
  readyRef.current = ready;
  voiceRef.current = inVoice;
  const updatePacks = useCallback((update: (current: Soundpack[]) => Soundpack[]) => {
    const next = update(packsRef.current);
    packsRef.current = next;
    setPacks(next);
  }, []);
  const saveGroups = useCallback((next: SoundpackGroup[]) => {
    groupsRef.current = next;
    setGroups(next);
    const activeScope = scope;
    store(groupKey, JSON.stringify({version: 1, groups: next})).catch(() => {
      if (mounted.current && scopeRef.current === activeScope) setNotice('分组暂时无法保存，关闭后可能丢失。');
    });
  }, [groupKey, scope]);
  const saveFavorites = useCallback((next: string[]) => {
    favoritesRef.current = next;
    setFavorites(next);
    const activeScope = scope;
    store(favoriteKey, JSON.stringify(next)).catch(() => {
      if (mounted.current && scopeRef.current === activeScope) setNotice('收藏暂时无法保存。');
    });
  }, [favoriteKey, scope]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operation.current += 1; };
  }, []);
  useEffect(() => {
    let active = true;
    preferenceRevision.current += 1;
    const version = preferenceRevision.current;
    operation.current += 1;
    busyRef.current = null;
    playPending.current = false;
    playRequestToken.current += 1;
    setBusy(null);
    setNotice(null);
    setPlayback(null);
    setPreferencesReady(false);
    preferenceScope.current = null;
    const initialVolumeRevision = volumeRevision.current;
    groupsRef.current = initialGroups();
    favoritesRef.current = [];
    setGroups(groupsRef.current);
    setFavorites([]);
    Promise.all([groupKey, favoriteKey, VOLUME_KEY].map(async key => {
      await writes.get(key)?.catch(() => undefined);
      return AsyncStorage.getItem(key);
    })).then(([savedGroups, savedFavorites, savedVolume]) => {
      if (!active || version !== preferenceRevision.current) return;
      let nextGroups = initialGroups();
      let nextFavorites: string[] = [];
      try { nextGroups = readGroups(JSON.parse(savedGroups ?? 'null')); } catch { /* Defaults. */ }
      try {
        const list = JSON.parse(savedFavorites ?? '[]');
        if (Array.isArray(list)) nextFavorites = [...new Set(list.filter((id): id is string => typeof id === 'string'))].slice(0, 6);
      } catch { /* Defaults. */ }
      groupsRef.current = nextGroups;
      favoritesRef.current = nextFavorites;
      setGroups(nextGroups);
      setFavorites(nextFavorites);
      const value = savedVolume === null ? 1 : Number(savedVolume);
      if (volumeRevision.current === initialVolumeRevision) setVolume(Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1);
      preferenceScope.current = scope;
      setPreferencesReady(true);
    }).catch(() => {
      if (active) { preferenceScope.current = scope; setPreferencesReady(true); setNotice('本地语音包设置读取失败，本次仍可使用。'); }
    });
    return () => { active = false; };
  }, [groupKey, favoriteKey, scope]);
  useEffect(() => {
    setListReady(false);
    listScope.current = null;
    updatePacks(() => []);
    setLoading(ready);
    setLoadError(null);
    if (!ready || !socket.id) return;
    let active = true;
    const socketId = socket.id;
    const load = async () => {
      const startRevision = revision.current;
      try {
        const response = await serverFetch(serverURL, `/api/soundpacks?socketId=${encodeURIComponent(socketId)}&roomId=${encodeURIComponent(roomId)}`);
        if (!response.ok) throw new Error(`语音包加载失败（HTTP ${response.status}）`);
        const list = await response.json() as Soundpack[];
        if (!Array.isArray(list)) throw new Error('服务器返回了无效的语音包列表');
        if (!active) return;
        if (startRevision !== revision.current) { load(); return; }
        updatePacks(() => list);
        listScope.current = scope;
        setListReady(true);
        setLoading(false);
      } catch (cause) {
        if (active) { setLoadError(message(cause, '语音包加载失败，点按重试')); setLoading(false); }
      }
    };
    load();
    return () => { active = false; };
  }, [ready, roomId, serverURL, socket, scope, retry, updatePacks]);
  useEffect(() => {
    if (!listReady || !preferencesReady || preferenceScope.current !== scope || listScope.current !== scope) return;
    const next = orderedGroups(reconcileGroups(groupsRef.current, packs.map(pack => pack.id)), packs.map(pack => pack.id));
    if (JSON.stringify(next) !== JSON.stringify(groupsRef.current)) saveGroups(next);
    const nextFavorites = favoritesRef.current.filter(id => packs.some(pack => pack.id === id));
    if (nextFavorites.length !== favoritesRef.current.length) saveFavorites(nextFavorites);
  }, [packs, listReady, preferencesReady, saveGroups, saveFavorites, scope]);
  useEffect(() => { if (!inVoice || !ready) setPlayback(null); }, [inVoice, ready, scope]);
  useEffect(() => {
    if (ready) return;
    operation.current += 1;
    busyRef.current = null;
    playPending.current = false;
    playRequestToken.current += 1;
    setBusy(null);
  }, [ready]);
  useEffect(() => {
    const onAdded = (sound: Soundpack) => {
      revision.current += 1;
      updatePacks(current => [sound, ...current.filter(item => item.id !== sound.id)]);
    };
    const onDeleted = ({soundId}: {soundId: string}) => {
      revision.current += 1;
      updatePacks(current => current.filter(item => item.id !== soundId));
      setPlayback(current => current?.soundId === soundId ? null : current);
    };
    const onRenamed = ({soundId, name}: {soundId: string; name: string}) => {
      revision.current += 1;
      updatePacks(current => current.map(item => item.id === soundId ? {...item, name} : item));
    };
    const onNormalized = ({soundId, filename, originalFilename}: {soundId: string; filename: string; originalFilename?: string}) => {
      revision.current += 1;
      updatePacks(current => current.map(item => item.id === soundId ? {...item, filename, ...(originalFilename ? {originalFilename} : {})} : item));
    };
    const onReordered = ({orderedIds}: {orderedIds: string[]}) => {
      revision.current += 1;
      authoritativeOrder.current += 1;
      updatePacks(current => applySoundpackOrder(current, orderedIds));
      if (preferenceScope.current === scope) saveGroups(orderedGroups(groupsRef.current, orderedIds));
    };
    const onPlay = ({soundId, filename}: {soundId: string; filename?: string}) => {
      if (!readyRef.current || !voiceRef.current) return;
      const sound = packsRef.current.find(pack => pack.id === soundId);
      // The server supplies the authoritative file, even if its add event is still loading.
      const file = filename ?? sound?.filename;
      if (!file) return;
      setPlayback({key: ++playSequence.current, soundId, uri: authorizedResourceURL(serverURL, `/sounds/${encodeURIComponent(file)}`)});
    };
    socket.on('soundpack:added', onAdded);
    socket.on('soundpack:deleted', onDeleted);
    socket.on('soundpack:renamed', onRenamed);
    socket.on('soundpack:normalized', onNormalized);
    socket.on('soundpack:reordered', onReordered);
    socket.on('soundpack:play', onPlay);
    return () => {
      socket.off('soundpack:added', onAdded);
      socket.off('soundpack:deleted', onDeleted);
      socket.off('soundpack:renamed', onRenamed);
      socket.off('soundpack:normalized', onNormalized);
      socket.off('soundpack:reordered', onReordered);
      socket.off('soundpack:play', onPlay);
    };
  }, [socket, serverURL, saveGroups, updatePacks, scope]);

  const ack = useCallback(async (event: string, payload: object) => {
    const result = await request<{ok: boolean; name?: string}>(socket, event, payload, {
      timeoutMs: 7_500, timeoutMessage: () => '语音包操作超时，请重试',
    });
    if (!result?.ok) throw new Error('语音包操作失败，请重试');
    return result;
  }, [socket]);
  const triggerSound = async (sound: Soundpack) => {
    if (!readyRef.current || !voiceRef.current || playPending.current) return;
    playPending.current = true;
    const token = ++playRequestToken.current;
    const activeScope = scope;
    setNotice(null);
    try { await ack('soundpack:play', {soundId: sound.id, roomId}); }
    catch (cause) { if (mounted.current && scopeRef.current === activeScope && playRequestToken.current === token) setNotice(message(cause, '播放失败')); }
    finally { if (scopeRef.current === activeScope && playRequestToken.current === token) playPending.current = false; }
  };
  const commitGroups = async (nextGroups: SoundpackGroup[]) => {
    if (!readyRef.current || !listReady || !preferencesReady || busyRef.current || preferenceScope.current !== scope || listScope.current !== scope) return;
    const previous = packsRef.current;
    const previousGroups = groupsRef.current;
    const orderedIds = flattenGroups(nextGroups);
    if (orderedIds.length !== previous.length || new Set(orderedIds).size !== previous.length || previous.some(pack => !orderedIds.includes(pack.id))) return;
    saveGroups(nextGroups);
    if (orderedIds.every((id, index) => id === previous[index]?.id)) return;
    const activeScope = scope;
    const token = ++operation.current;
    const startingOrder = authoritativeOrder.current;
    const active = () => mounted.current && scopeRef.current === activeScope && operation.current === token;
    busyRef.current = 'reorder';
    setBusy('reorder');
    setNotice(null);
    revision.current += 1;
    updatePacks(current => applySoundpackOrder(current, orderedIds));
    try { await ack('soundpack:reorder', {roomId, orderedIds}); }
    catch (cause) {
      if (!active()) return;
      revision.current += 1;
      if (startingOrder === authoritativeOrder.current) updatePacks(current => applySoundpackOrder(current, previous.map(pack => pack.id)));
      const restored = reconcileGroups(previousGroups, packsRef.current.map(pack => pack.id));
      saveGroups(startingOrder === authoritativeOrder.current ? restored : orderedGroups(restored, packsRef.current.map(pack => pack.id)));
      setNotice(message(cause, '调整顺序失败'));
    } finally { if (active()) {busyRef.current = null; setBusy(null);} }
  };
  const manageSound = async (kind: 'rename' | 'delete', soundId: string, name?: string) => {
    const sound = packsRef.current.find(pack => pack.id === soundId);
    if (!readyRef.current || busyRef.current || !sound?.canDelete || (kind === 'rename' && !name?.trim())) return false;
    const activeScope = scope;
    const token = ++operation.current;
    const active = () => mounted.current && scopeRef.current === activeScope && operation.current === token;
    busyRef.current = `${kind}:${soundId}`;
    setBusy(busyRef.current);
    setNotice(null);
    try {
      const result = await ack(`soundpack:${kind}`, {soundId, roomId, ...(kind === 'rename' ? {name: name!.trim().slice(0, 64)} : {})});
      if (!active()) return false;
      revision.current += 1;
      updatePacks(current => kind === 'delete' ? current.filter(pack => pack.id !== soundId) : current.map(pack => pack.id === soundId ? {...pack, name: result.name ?? name!.trim().slice(0, 64)} : pack));
      if (kind === 'delete') setPlayback(current => current?.soundId === soundId ? null : current);
      return true;
    } catch (cause) { if (active()) setNotice(message(cause, '语音包操作失败')); return false; }
    finally { if (active()) {busyRef.current = null; setBusy(null);} }
  };
  const updateVolume = (value: number) => {
    volumeRevision.current += 1;
    const next = Math.max(0, Math.min(1, value));
    setVolume(next);
    store(VOLUME_KEY, String(next)).catch(() => { if (mounted.current) setNotice('音量暂时无法保存。'); });
  };
  const toggleFavorite = (id: string) => {
    if (!preferencesReady || !packsRef.current.some(pack => pack.id === id)) return;
    const current = favoritesRef.current;
    if (!current.includes(id) && current.length >= 6) {setNotice('最多收藏 6 个语音包，请先取消一个收藏。'); return;}
    saveFavorites(current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  };
  const addSoundpackGroup = () => {
    if (readyRef.current && listReady && preferencesReady && !busyRef.current) saveGroups(addGroup(groupsRef.current, `mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`));
  };
  return {packs, groups, favorites, volume, playback, loading, loadError, notice, busy,
    canManage: ready && listReady && preferencesReady && !busy && preferenceScope.current === scope && listScope.current === scope,
    ready, inVoice, canAddGroup: canAddGroup(groups), serverURL, roomId, socket, scope, outputDeviceId,
    reload: () => setRetry(value => value + 1), setNotice, triggerSound, updateVolume, toggleFavorite, addSoundpackGroup,
    moveSound: (id: string, groupId: string, index: number) => commitGroups(moveSound(groupsRef.current, id, groupId, index)),
    swapGroups: (sourceId: string, targetId: string) => commitGroups(swapGroups(groupsRef.current, sourceId, targetId)),
    renameSound: (id: string, name: string) => manageSound('rename', id, name),
    deleteSound: (id: string) => manageSound('delete', id),
    playbackEnded: (key: number, failed = false) => {
      if (playbackRef.current?.key !== key) return;
      setPlayback(current => current?.key === key ? null : current);
      if (failed) setNotice('播放失败，请检查语音包文件和服务器连接');
    },
  };
}
export type SoundboardController = ReturnType<typeof useSoundboard>;
