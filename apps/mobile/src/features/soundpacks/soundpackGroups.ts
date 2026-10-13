/** Group boundaries are local preferences; flattened order uses the existing server protocol. */
export interface SoundpackGroup { id: string; soundIds: string[]; }
export const DEFAULT_GROUP_ID = 'default';
export const initialGroups = (): SoundpackGroup[] => [{ id: DEFAULT_GROUP_ID, soundIds: [] }];

export function soundpackScope(serverURL: string, accountId: string) {
  let server = serverURL.replace(/\/+$/, '');
  try { server = new URL(server).href.replace(/\/+$/, ''); } catch { /* Retain custom paths. */ }
  return `${encodeURIComponent(server)}:${encodeURIComponent(accountId)}`;
}
export const groupsStorageKey = (serverURL: string, accountId: string) =>
  `cove:soundpack-groups:v1:${soundpackScope(serverURL, accountId)}`;
export const favoritesStorageKey = (serverURL: string, accountId: string) =>
  `cove:soundpack-favorites:${soundpackScope(serverURL, accountId)}`;

export function readGroups(value: unknown): SoundpackGroup[] {
  const data = value as {version?: unknown; groups?: unknown} | null;
  if (data?.version !== 1 || !Array.isArray(data.groups)) return initialGroups();
  const groupIds = new Set<string>();
  const assigned = new Set<string>();
  const groups: SoundpackGroup[] = [];
  for (const candidate of data.groups) {
    if (!candidate || typeof candidate.id !== 'string' || !candidate.id || groupIds.has(candidate.id) || !Array.isArray(candidate.soundIds)) continue;
    groupIds.add(candidate.id);
    groups.push({id: candidate.id, soundIds: candidate.soundIds.filter((id: unknown): id is string => {
      if (typeof id !== 'string' || !id || assigned.has(id)) return false;
      assigned.add(id);
      return true;
    })});
  }
  return groups.length ? groups : initialGroups();
}

export function reconcileGroups(groups: readonly SoundpackGroup[], availableIds: readonly string[]) {
  const available = new Set(availableIds);
  const assigned = new Set<string>();
  const next = (groups.length ? groups : initialGroups()).map(group => ({
    id: group.id,
    soundIds: group.soundIds.filter(id => {
      if (!available.has(id) || assigned.has(id)) return false;
      assigned.add(id);
      return true;
    }),
  }));
  next[0].soundIds = [...availableIds.filter(id => !assigned.has(id)), ...next[0].soundIds];
  return next;
}
export const flattenGroups = (groups: readonly SoundpackGroup[]) => groups.flatMap(group => group.soundIds);
export const canAddGroup = (groups: readonly SoundpackGroup[]) => groups.length > 0 && groups.every(group => group.soundIds.length > 0);
export function addGroup(groups: readonly SoundpackGroup[], id: string) {
  return canAddGroup(groups) && !groups.some(group => group.id === id)
    ? [...groups, {id, soundIds: []}] : [...groups];
}
export function moveSound(groups: readonly SoundpackGroup[], soundId: string, groupId: string, index: number) {
  if (!groups.some(group => group.soundIds.includes(soundId)) || !groups.some(group => group.id === groupId)) return [...groups];
  return groups.map(group => {
    const soundIds = group.soundIds.filter(id => id !== soundId);
    if (group.id === groupId) soundIds.splice(Math.max(0, Math.min(soundIds.length, index)), 0, soundId);
    return {...group, soundIds};
  });
}
export function swapGroups(groups: readonly SoundpackGroup[], sourceId: string, targetId: string) {
  const next = [...groups];
  const source = next.findIndex(group => group.id === sourceId);
  const target = next.findIndex(group => group.id === targetId);
  if (source >= 0 && target >= 0) [next[source], next[target]] = [next[target], next[source]];
  return next;
}
export function applySoundpackOrder<T extends {id: string}>(packs: readonly T[], orderedIds: readonly string[]) {
  const byId = new Map(packs.map(pack => [pack.id, pack]));
  const next = orderedIds.flatMap(id => {
    const pack = byId.get(id);
    if (!pack) return [];
    byId.delete(id);
    return [pack];
  });
  return [...next, ...byId.values()];
}
export function orderedGroups(groups: readonly SoundpackGroup[], orderedIds: readonly string[]) {
  const rank = new Map(orderedIds.map((id, index) => [id, index]));
  return groups.map(group => ({...group, soundIds: [...group.soundIds].sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity))}));
}
