export type ControlBallFit = 'full' | 'compact' | 'ball';

export type MiddleDockSpace = {
  workspaceLeft: number;
  workspaceRight: number;
  dockCenter: number;
  leftContentRight: number;
  actionsLeft: number;
  safetyGap?: number;
};

/**
 * Width available to a dock centered in its current workspace position.
 * The left boundary comes from visible status content, not the flexing status
 * container, and the right boundary comes from the interactive action group.
 */
export function availableMiddleDockWidth({
  workspaceLeft,
  workspaceRight,
  dockCenter,
  leftContentRight,
  actionsLeft,
  safetyGap = 10,
}: MiddleDockSpace): number {
  const values = [workspaceLeft, workspaceRight, dockCenter, leftContentRight, actionsLeft, safetyGap];
  if (values.some(value => !Number.isFinite(value)) || workspaceRight <= workspaceLeft) return 0;

  const leftEdge = Math.max(workspaceLeft, leftContentRight) + Math.max(0, safetyGap);
  const rightEdge = Math.min(workspaceRight, actionsLeft) - Math.max(0, safetyGap);
  if (rightEdge <= leftEdge || dockCenter <= leftEdge || dockCenter >= rightEdge) return 0;

  return Math.max(0, Math.min(dockCenter - leftEdge, rightEdge - dockCenter) * 2);
}

/**
 * Pick a stable dock presentation. Tighter states apply as soon as they are
 * needed; upgrades need extra room so an animated layout does not chatter.
 */
export function resolveControlBallFit(
  availableWidth: number,
  fullWidth: number,
  compactWidth: number,
  current: ControlBallFit,
  hysteresis = 16,
): ControlBallFit {
  if (![availableWidth, fullWidth, compactWidth, hysteresis].every(Number.isFinite)) return 'ball';

  const full = Math.max(0, fullWidth);
  const compact = Math.max(0, Math.min(compactWidth, full));
  const available = Math.max(0, availableWidth);
  const recoveryRoom = Math.max(0, hysteresis);

  if (current === 'full') {
    if (available >= full) return 'full';
    return available >= compact ? 'compact' : 'ball';
  }
  if (current === 'compact') {
    if (available >= full + recoveryRoom) return 'full';
    return available < compact ? 'ball' : 'compact';
  }

  if (available < compact + recoveryRoom) return 'ball';
  return available >= full + recoveryRoom ? 'full' : 'compact';
}
