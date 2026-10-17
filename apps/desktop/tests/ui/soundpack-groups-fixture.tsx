// The real panel and styles, with deterministic transport/account data only.
// No live server, account, playback, capture, or microphone is used.
import { StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Socket } from 'socket.io-client';
import { SoundPackPanel } from '../../src/features/soundpacks/components/SoundPackPanel';
import { soundpackGroupsStorageKey, type SoundpackGroup } from '../../src/features/soundpacks/soundpackGroups';
import '../../src/styles/index.css';
import '../../src/styles/ui-v2.css';

const SERVER_URL = 'http://soundpack-fixture.test';
const ACCOUNT_ID = 'fixture-account';
const ROOM_ID = 'soundpack-fixture-room';
const OTHER_ROOM_ID = 'other-fixture-room';
const SERVER_ORDER_KEY = 'cove:qa:soundpack-server-order';
const GROUPS_KEY = soundpackGroupsStorageKey(SERVER_URL, ACCOUNT_ID, ROOM_ID);
const allIds = Array.from({ length: 12 }, (_, index) => `s${index + 1}`);
const packs = allIds.map((id, index) => ({
  id,
  roomId: ROOM_ID,
  name: `${String(index + 1).padStart(2, '0')} · A deliberately long sound name for stable card width and ellipsis ${index + 1}`,
  filename: `${id}.ogg`,
  originalFilename: `${id}.ogg`,
  uploader: 'Fixture uploader with a long display name',
  uploaderUserId: ACCOUNT_ID,
  createdAt: 1_700_000_000_000 + index,
  sortOrder: index,
  canDelete: true,
}));
const initialPacks = packs.map(pack => ({ ...pack }));

let currentAccountId = ACCOUNT_ID;
let currentRoomId = ROOM_ID;
let suspended = false;
let managementOpen = true;
const setAccount = (accountId: string) => {
  currentAccountId = accountId;
  localStorage.setItem('cove_account_session', JSON.stringify({
    serverUrl: SERVER_URL, token: 'fixture-token', accountId,
    email: 'fixture@example.test', profile: { username: 'Sound-pack fixture', avatarUrl: null },
  }));
};
setAccount(ACCOUNT_ID);
localStorage.setItem('cove_server_url', SERVER_URL);

let serverOrder = allIds;
try {
  const stored = JSON.parse(localStorage.getItem(SERVER_ORDER_KEY) ?? 'null');
  if (Array.isArray(stored) && stored.length === allIds.length && allIds.every(id => stored.includes(id))) serverOrder = stored;
} catch { /* Fresh fixture profile. */ }
const fetches: string[] = [];
const requests: { roomId: string | null; accountHeader: boolean; redirect?: RequestRedirect }[] = [];
const emissions: { event: string; payload: unknown }[] = [];
const alerts: string[] = [];
let rejectNextReorder = false;
let holdNextReorder = false;
let heldReorder: { ids: string[]; callback: (...args: any[]) => void } | null = null;
let holdNextFetch = false;
let heldFetch: (() => void) | null = null;
let legacyResponse = false;
const listeners = new Map<string, Set<(...args: any[]) => void>>();
const fixtureSocket = {
  id: 'fixture-socket',
  connected: true,
  on(event: string, listener: (...args: any[]) => void) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(listener);
    return fixtureSocket;
  },
  off(event: string, listener: (...args: any[]) => void) { listeners.get(event)?.delete(listener); return fixtureSocket; },
  timeout() { return fixtureSocket; },
  emit(event: string, ...args: any[]) {
    const payload = args[0];
    const callback = args.find(value => typeof value === 'function');
    emissions.push({ event, payload: JSON.parse(JSON.stringify(payload ?? null)) });
    if (event === 'soundpack:reorder') {
      if (rejectNextReorder) {
        rejectNextReorder = false;
        queueMicrotask(() => callback?.(null, { ok: false, error: 'Fixture reorder rejected' }));
        return fixtureSocket;
      }
      const ids = payload?.orderedIds;
      const valid = payload?.roomId === ROOM_ID && Array.isArray(ids) && ids.length === allIds.length
        && new Set(ids).size === allIds.length && allIds.every(id => ids.includes(id));
      if (!valid) {
        queueMicrotask(() => callback?.(null, { ok: false, error: 'Invalid fixture reorder payload' }));
        return fixtureSocket;
      }
      if (holdNextReorder) {
        holdNextReorder = false;
        heldReorder = { ids: [...ids], callback };
        return fixtureSocket;
      }
      serverOrder = [...ids];
      localStorage.setItem(SERVER_ORDER_KEY, JSON.stringify(serverOrder));
      // Room-scoped flat ordering: broadcast, then acknowledgement.
      queueMicrotask(() => {
        listeners.get('soundpack:reordered')?.forEach(listener => listener({ roomId: ROOM_ID, orderedIds: [...serverOrder] }));
        callback?.(null, { ok: true });
      });
    } else {
      queueMicrotask(() => callback?.(null, { ok: true }));
    }
    return fixtureSocket;
  },
} as unknown as Socket;

window.alert = message => { alerts.push(String(message)); };
window.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  fetches.push(url);
  const parsed = new URL(url, SERVER_URL);
  if (parsed.origin !== SERVER_URL || parsed.pathname !== '/api/soundpacks')
    throw new Error(`Fixture blocked an unexpected request: ${url}`);
  if (new Headers(init?.headers).get('X-Cove-Account-Token') !== 'fixture-token' || init?.redirect !== 'error')
    throw new Error('Fixture requires a header-only account token and redirect:error');
  const requestedRoomId = parsed.searchParams.get('roomId');
  requests.push({ roomId: requestedRoomId, accountHeader: true, redirect: init?.redirect });
  if (requestedRoomId !== ROOM_ID && requestedRoomId !== OTHER_ROOM_ID) throw new Error('Fixture rejected an unknown room');
  const roomPacks = requestedRoomId === ROOM_ID ? serverOrder.map(id => packs.find(pack => pack.id === id)) :
    packs.slice(0, 3).map(pack => ({ ...pack, id: `other-${pack.id}`, roomId: OTHER_ROOM_ID }));
  const body = legacyResponse ? roomPacks : { roomId: requestedRoomId, soundpacks: roomPacks };
  const response = () => new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  if (holdNextFetch) {
    holdNextFetch = false;
    return new Promise<Response>(resolve => { heldFetch = () => { heldFetch = null; resolve(response()); }; });
  }
  return response();
};

const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
let remount: () => void = () => undefined;
let rerender: () => void = () => undefined;
let activePointerId = 1;
document.addEventListener('pointerdown', event => { activePointerId = event.pointerId; }, true);

function Fixture() {
  const anchor = useRef<HTMLButtonElement>(null);
  const [mount, setMount] = useState(0);
  const [, setRevision] = useState(0);
  remount = () => setMount(value => value + 1);
  rerender = () => setRevision(value => value + 1);
  return <main className="soundpack-qa-stage">
    <style>{`
      html,body,#root { background:#eff2f6; }
      .soundpack-qa-stage { min-height:100%; }
      .soundpack-qa-anchor { position:fixed; left:50%; bottom:28px; transform:translateX(-50%); width:72px; height:38px; border:1px solid #d6dbe2; border-radius:12px; background:white; color:#15191f; }
    `}</style>
    <button ref={anchor} className="soundpack-qa-anchor" type="button">声音包</button>
    <SoundPackPanel key={mount} socket={fixtureSocket} roomId={currentRoomId} accountId={currentAccountId} serverURL={SERVER_URL}
      disabled={suspended} inVoice={false} profileRemarks={{}} compact anchorRef={anchor} open={managementOpen} hideTrigger />
  </main>;
}

function snapshot(draggedSoundId?: string) {
  const scroll = document.querySelector<HTMLElement>('[data-soundpack-scroll]');
  const groups = [...(scroll?.querySelectorAll<HTMLElement>('[data-soundpack-group]') ?? [])]
    .map(group => ({
      id: group.dataset.soundpackGroup!,
      soundIds: [...group.querySelectorAll<HTMLElement>('[data-soundpack-id], [data-soundpack-placeholder]')]
        .map(card => card.hasAttribute('data-soundpack-placeholder') ? draggedSoundId ?? '<placeholder>' : card.dataset.soundpackId!),
      rect: group.getBoundingClientRect().toJSON(),
    }));
  const placeholder = scroll?.querySelector<HTMLElement>('[data-soundpack-placeholder]');
  const preview = document.querySelector<HTMLElement>('[data-soundpack-group-preview]');
  const add = document.querySelector<HTMLButtonElement>('[data-soundpack-add-group]');
  return {
    groups,
    placeholder: placeholder ? { groupId: placeholder.dataset.groupId, index: Number(placeholder.dataset.index), rect: placeholder.getBoundingClientRect().toJSON() } : null,
    groupPreview: preview ? { id: preview.dataset.soundpackGroup ?? preview.dataset.soundpackGroupPreview, rect: preview.getBoundingClientRect().toJSON() } : null,
    addDisabled: add?.disabled ?? null,
    dragging: document.body.classList.contains('soundpack-dragging') || document.body.classList.contains('sortable-dragging'),
    scroll: scroll ? { top: scroll.scrollTop, height: scroll.clientHeight, contentHeight: scroll.scrollHeight, rect: scroll.getBoundingClientRect().toJSON() } : null,
    storage: localStorage.getItem(soundpackGroupsStorageKey(SERVER_URL, currentAccountId, currentRoomId)),
    accountId: currentAccountId,
    roomId: currentRoomId,
    pendingFetch: Boolean(heldFetch),
    pendingReorder: Boolean(heldReorder),
    serverOrder: [...serverOrder],
    emissions: [...emissions],
    fetches: [...fetches],
    requests: [...requests],
    alerts: [...alerts],
  };
}

window.soundpackGroupsQa = {
  serverURL: SERVER_URL,
  accountId: ACCOUNT_ID,
  groupsKey: GROUPS_KEY,
  allIds,
  snapshot,
  async reset(groups?: SoundpackGroup[]) {
    setAccount(ACCOUNT_ID);
    currentRoomId = ROOM_ID;
    suspended = false;
    managementOpen = true;
    legacyResponse = false;
    packs.splice(0, packs.length, ...initialPacks.map(pack => ({ ...pack })));
    serverOrder = [...allIds];
    localStorage.setItem(SERVER_ORDER_KEY, JSON.stringify(serverOrder));
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('cove:soundpack-groups:') || key.startsWith('cove:soundpack-favorites:')) localStorage.removeItem(key);
    }
    if (groups) localStorage.setItem(GROUPS_KEY, JSON.stringify({ version: 1, groups }));
    emissions.length = 0;
    alerts.length = 0;
    rejectNextReorder = false;
    holdNextReorder = false;
    holdNextFetch = false;
    heldFetch?.();
    heldReorder?.callback(null, { ok: false, error: 'Fixture reset' });
    heldReorder = null;
    remount();
    await frames();
    await frames();
  },
  cancelPointer() {
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: activePointerId, pointerType: 'mouse', bubbles: true, cancelable: true }));
  },
  failNextReorder() { rejectNextReorder = true; },
  holdNextReorder() { holdNextReorder = true; },
  releaseReorder(ok = false) {
    const pending = heldReorder;
    heldReorder = null;
    if (!pending) return;
    if (ok) {
      serverOrder = [...pending.ids];
      localStorage.setItem(SERVER_ORDER_KEY, JSON.stringify(serverOrder));
      listeners.get('soundpack:reordered')?.forEach(listener => listener({ roomId: ROOM_ID, orderedIds: [...serverOrder] }));
    }
    pending.callback(null, ok ? { ok: true } : { ok: false, error: 'Fixture delayed reorder rejected' });
  },
  async switchAccount(accountId: string, groups: SoundpackGroup[], holdFetch = false) {
    setAccount(accountId);
    const key = soundpackGroupsStorageKey(SERVER_URL, accountId, ROOM_ID);
    localStorage.setItem(key, JSON.stringify({ version: 1, groups }));
    holdNextFetch = holdFetch;
    rerender();
    await frames();
    return key;
  },
  releaseFetch() { heldFetch?.(); },
  async switchRoom(roomId = OTHER_ROOM_ID) { currentRoomId = roomId; rerender(); await frames(); },
  async reloadWithHeldFetch() { holdNextFetch = true; remount(); await frames(); },
  async legacyServer() { legacyResponse = true; remount(); await frames(); },
  async setSuspended(value: boolean) { suspended = value; rerender(); await frames(); },
  async setOpen(value: boolean) { managementOpen = value; rerender(); await frames(); },
  mutateWhileLoading(kind: 'added' | 'deleted' | 'renamed' | 'normalized' | 'reordered' | 'play') {
    let payload: Record<string, unknown> = { roomId: ROOM_ID, soundId: 's1' };
    if (kind === 'added') {
      const sound = { ...initialPacks[0], id: 'added-during-load', name: 'Added while the initial list was pending' };
      packs.push(sound);
      serverOrder = [sound.id, ...serverOrder];
      payload = sound;
    } else if (kind === 'deleted') serverOrder = serverOrder.filter(id => id !== 's1');
    else if (kind === 'renamed') {
      const index = packs.findIndex(pack => pack.id === 's1');
      packs[index] = { ...packs[index], name: 'Renamed while loading' };
      payload.name = packs[index].name;
    } else if (kind === 'normalized') {
      const index = packs.findIndex(pack => pack.id === 's1');
      packs[index] = { ...packs[index], filename: 'normalized-while-loading.ogg' };
      payload.filename = packs[index].filename;
      payload.originalFilename = packs[index].originalFilename;
    } else if (kind === 'reordered') {
      serverOrder = [...serverOrder].reverse();
      payload.orderedIds = [...serverOrder];
    }
    listeners.get(`soundpack:${kind}`)?.forEach(listener => listener(payload));
    return [...serverOrder];
  },
  broadcast(event: string, payload: unknown) { listeners.get(event)?.forEach(listener => listener(payload)); },
  broadcastDelete(soundId: string) {
    serverOrder = serverOrder.filter(id => id !== soundId);
    listeners.get('soundpack:deleted')?.forEach(listener => listener({ roomId: ROOM_ID, soundId }));
  },
};

declare global {
  interface Window { soundpackGroupsQa: {
    serverURL: string; accountId: string; groupsKey: string; allIds: string[];
    snapshot: typeof snapshot;
    reset: (groups?: SoundpackGroup[]) => Promise<void>;
    cancelPointer: () => void;
    failNextReorder: () => void;
    holdNextReorder: () => void;
    releaseReorder: (ok?: boolean) => void;
    switchAccount: (accountId: string, groups: SoundpackGroup[], holdFetch?: boolean) => Promise<string>;
    releaseFetch: () => void;
    switchRoom: (roomId?: string) => Promise<void>;
    reloadWithHeldFetch: () => Promise<void>;
    legacyServer: () => Promise<void>;
    setSuspended: (value: boolean) => Promise<void>;
    setOpen: (value: boolean) => Promise<void>;
    mutateWhileLoading: (kind: 'added' | 'deleted' | 'renamed' | 'normalized' | 'reordered' | 'play') => string[];
    broadcast: (event: string, payload: unknown) => void;
    broadcastDelete: (soundId: string) => void;
  }; }
}

createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>);
