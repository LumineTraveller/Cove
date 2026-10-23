/** Personal layout only. Room snapshots supply membership and the first seed order. */
export interface PersonalSoundpackGroup { id: string; soundIds: readonly string[]; }

export function reconcilePersonalSoundpackGroups(groups: readonly PersonalSoundpackGroup[], availableIds: readonly string[]) {
  const available = new Set(availableIds);
  const assigned = new Set<string>();
  const next = (groups.length ? groups : [{ id: 'default', soundIds: [] }]).map(group => ({
    id: group.id,
    soundIds: group.soundIds.filter(id => {
      if (!available.has(id) || assigned.has(id)) return false;
      assigned.add(id);
      return true;
    }),
  }));
  // Preserve group membership and existing personal positions. New sounds join
  // the end of the first group; an empty installation seeds from the snapshot.
  for (const id of availableIds) {
    if (!assigned.has(id)) { next[0].soundIds.push(id); assigned.add(id); }
  }
  return next;
}

/** Validate local drag results without the legacy server's 500-item limit. */
export function isCompleteSoundpackOrder(orderedIds: readonly string[], availableIds: readonly string[]): boolean {
  if (orderedIds.length !== availableIds.length) return false;
  const remaining = new Set(availableIds);
  if (remaining.size !== availableIds.length) return false;
  for (const id of orderedIds) if (!remaining.delete(id)) return false;
  return remaining.size === 0;
}

export function orderSoundpacks<T extends { id: string }>(packs: readonly T[], orderedIds: readonly string[]): T[] {
  const remaining = new Map(packs.map(pack => [pack.id, pack]));
  const next: T[] = [];
  for (const id of orderedIds) {
    const pack = remaining.get(id);
    if (pack) { next.push(pack); remaining.delete(id); }
  }
  return [...next, ...remaining.values()];
}
