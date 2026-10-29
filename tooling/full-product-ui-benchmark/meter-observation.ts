/** Values come only from the two isolated synthetic accounts; IDs never escape. */
export function createMeterObservation() {
  let previous = new Map<string, number>(), valueChanges = 0, keyChanges = 0;
  let positiveObservations = 0, minimum: number | null = null, maximum: number | null = null;
  let values: number[] = [];
  return {
    observe(levels: Record<string, number> | undefined) {
      const next = new Map(Object.entries(levels ?? {}).filter(([, value]) => Number.isFinite(value)));
      for (const [key, value] of next) {
        if (!previous.has(key)) keyChanges++;
        else if (!Object.is(previous.get(key), value)) valueChanges++;
        if (value > 0) positiveObservations++;
        minimum = minimum === null ? value : Math.min(minimum, value);
        maximum = maximum === null ? value : Math.max(maximum, value);
      }
      for (const key of previous.keys()) if (!next.has(key)) keyChanges++;
      previous = next;
      values = [...next.values()].sort((a, b) => a - b).slice(0, 16);
    },
    snapshot() { return { meterValueChanges: valueChanges, meterKeyChanges: keyChanges,
      meterPositiveObservations: positiveObservations, meterMinimum: minimum, meterMaximum: maximum,
      meterValues: [...values], meaning: 'Product speakingLevels (3x RMS, capped at 1), not raw PCM RMS.' }; },
  };
}
