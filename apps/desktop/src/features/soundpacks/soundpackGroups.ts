import { groupRowsIntoLines, type SortableRowGeometry } from '../sorting/sortableList';

export interface SoundpackGroup {
  id: string;
  soundIds: string[];
}

export interface SoundpackGroupSettings {
  version: 1;
  groups: SoundpackGroup[];
}

export const DEFAULT_SOUNDPACK_GROUP_ID = 'default';

export function soundpackGroupsStorageKey(serverURL: string, accountId: string): string {
  let server = serverURL.replace(/\/+$/, '');
  try { server = new URL(server).href.replace(/\/+$/, ''); } catch { /* Keep custom server paths. */ }
  return `cove:soundpack-groups:v1:${encodeURIComponent(server)}:${encodeURIComponent(accountId)}`;
}

/** Old installations have no grouping settings: retain their server order in one group. */
export function readSoundpackGroups(value: unknown): SoundpackGroup[] {
  const settings = value as Partial<SoundpackGroupSettings> | null;
  if (settings?.version !== 1 || !Array.isArray(settings.groups))
    return [{ id: DEFAULT_SOUNDPACK_GROUP_ID, soundIds: [] }];
  const groupIds = new Set<string>();
  const soundIds = new Set<string>();
  const groups: SoundpackGroup[] = [];
  for (const candidate of settings.groups) {
    if (!candidate || typeof candidate.id !== 'string' || !candidate.id || groupIds.has(candidate.id) || !Array.isArray(candidate.soundIds)) continue;
    groupIds.add(candidate.id);
    groups.push({
      id: candidate.id, soundIds: candidate.soundIds.filter((id): id is string => {
        if (typeof id !== 'string' || soundIds.has(id)) return false;
        soundIds.add(id);
        return true;
      })
    });
  }
  return groups.length ? groups : [{ id: DEFAULT_SOUNDPACK_GROUP_ID, soundIds: [] }];
}

/** Deleted sounds are removed; empty groups survive. New sounds join the first group. */
export function reconcileSoundpackGroups(groups: readonly SoundpackGroup[], availableIds: readonly string[]): SoundpackGroup[] {
  const available = new Set(availableIds);
  const assigned = new Set<string>();
  const next = (groups.length ? groups : [{ id: DEFAULT_SOUNDPACK_GROUP_ID, soundIds: [] }]).map((group) => ({
    id: group.id,
    soundIds: group.soundIds.filter((id) => {
      if (!available.has(id) || assigned.has(id)) return false;
      assigned.add(id);
      return true;
    }),
  }));
  next[0].soundIds = [...availableIds.filter((id) => !assigned.has(id)), ...next[0].soundIds];
  return next;
}

export const flattenSoundpackGroups = (groups: readonly SoundpackGroup[]) => groups.flatMap((group) => group.soundIds);
export const canAddSoundpackGroup = (groups: readonly SoundpackGroup[]) => groups.length > 0 && groups.every((group) => group.soundIds.length > 0);

export function addSoundpackGroup(groups: readonly SoundpackGroup[], id: string): SoundpackGroup[] {
  if (!canAddSoundpackGroup(groups) || groups.some((group) => group.id === id)) return [...groups];
  return [...groups, { id, soundIds: [] }];
}

export interface SoundpackDropTarget { groupId: string; index: number; }

export function moveSoundpackToGroup(groups: readonly SoundpackGroup[], soundId: string, target: SoundpackDropTarget): SoundpackGroup[] {
  if (!groups.some((group) => group.soundIds.includes(soundId)) || !groups.some((group) => group.id === target.groupId)) return [...groups];
  return groups.map((group) => {
    const soundIds = group.soundIds.filter((id) => id !== soundId);
    if (group.id === target.groupId) soundIds.splice(Math.min(soundIds.length, Math.max(0, target.index)), 0, soundId);
    return { ...group, soundIds };
  });
}

/** The divider belongs to the group below it. Dropping it on another group swaps both. */
export function swapSoundpackGroups(groups: readonly SoundpackGroup[], sourceId: string, targetId: string): SoundpackGroup[] {
  const next = [...groups];
  const source = next.findIndex((group) => group.id === sourceId);
  const target = next.findIndex((group) => group.id === targetId);
  if (source < 0 || target < 0 || source === target) return next;
  [next[source], next[target]] = [next[target], next[source]];
  return next;
}

export interface SoundpackGroupGeometry {
  id: string;
  top: number;
  left: number;
  width: number;
  height: number;
  rows: SortableRowGeometry[];
}

export function resolveSoundpackGroup(geometry: readonly SoundpackGroupGeometry[], y: number): SoundpackGroupGeometry | undefined {
  let nearest: SoundpackGroupGeometry | undefined;
  let distance = Infinity;
  for (const group of geometry) {
    const current = y < group.top ? group.top - y : y > group.top + group.height ? y - group.top - group.height : 0;
    if (current < distance) { nearest = group; distance = current; }
  }
  return nearest;
}

/**
 * One pointer-based hit result drives the rendered placeholder and final drop.
 * Within the source group, every cell is a destination slot (including its edges),
 * so entering a neighbouring cell immediately moves into that visible slot.
 * Cross-group placement uses cell halves to expose an insertion slot, including append.
 * Geometry is captured before preview reflow, preventing oscillation under a still pointer.
 */
export function resolveSoundpackDrop(geometry: readonly SoundpackGroupGeometry[], sourceGroupId: string, soundId: string, x: number, y: number): SoundpackDropTarget | null {
  const group = resolveSoundpackGroup(geometry, y);
  if (!group) return null;
  const lines = groupRowsIntoLines(group.rows);
  if (!lines.length) return { groupId: group.id, index: 0 };
  let lineIndex = 0;
  let best = Infinity;
  lines.forEach((line, index) => {
    const top = Math.min(...line.map((row) => row.top));
    const bottom = Math.max(...line.map((row) => row.top + row.height));
    const distance = y < top ? top - y : y > bottom ? y - bottom : 0;
    if (distance < best) { best = distance; lineIndex = index; }
  });
  const line = lines[lineIndex];
  const prefix = lines.slice(0, lineIndex).reduce((count, rows) => count + rows.length, 0);
  if (group.id === sourceGroupId) {
    let slot = 0;
    let distance = Infinity;
    line.forEach((row, index) => {
      const current = x < row.left ? row.left - x : x > row.left + row.width ? x - row.left - row.width : 0;
      if (current < distance) { distance = current; slot = index; }
    });
    return { groupId: group.id, index: prefix + slot };
  }
  const rows = line.filter((row) => row.id !== soundId);
  return { groupId: group.id, index: prefix + rows.filter((row) => x > row.left + row.width / 2).length };
}
