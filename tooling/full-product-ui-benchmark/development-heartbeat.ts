export interface IntervalOwner { delay: number | null; owner: string }

export function classifyIntervalOwner(stack: string, delay?: number): string {
  if (delay === 30_000 && /http:\/\/127\.0\.0\.1:\d+\/@vite\/client(?:[:?]|$)/.test(stack)) return 'vite-client';
  return ['useAudioMeters.ts', 'useMediaDiagnostics.ts', 'useScreenAnalysis.ts', 'UpdateCenter.tsx']
    .find(name => stack.includes('/' + name)) ?? 'other';
}

/** Dispose only the identified development server ping, after product teardown. */
export function disposeDevelopmentHeartbeat(
  owners: ReadonlyMap<number, IntervalOwner>, active: ReadonlySet<number>, clear: (id: number) => void,
) {
  const owned = [...active].filter(id => {
    const value = owners.get(id);
    return value?.owner === 'vite-client' && value.delay === 30_000;
  });
  if (owned.length > 1) return { observed: owned.length, disposed: 0, passed: false };
  let disposed = 0;
  for (const id of owned) {
    clear(id);
    if (!active.has(id)) disposed++;
  }
  return { observed: owned.length, disposed, passed: disposed === owned.length };
}
