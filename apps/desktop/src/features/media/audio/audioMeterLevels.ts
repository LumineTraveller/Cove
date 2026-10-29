/** Preserve React state identity only when every own meter key/value is unchanged. */
export function reuseAudioMeterLevels(
  previous: Record<string, number>,
  next: Record<string, number>,
): Record<string, number> {
  const keys = Object.keys(next);
  if (keys.length !== Object.keys(previous).length) return next;
  return keys.every(key => Object.prototype.hasOwnProperty.call(previous, key) &&
    Object.is(previous[key], next[key])) ? previous : next;
}
