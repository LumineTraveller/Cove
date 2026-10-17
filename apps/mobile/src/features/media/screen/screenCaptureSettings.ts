export const SCREEN_CAPTURE_SCALES = [
  { value: 1, label: '原始 (100%)' },
  { value: 0.75, label: '75%' },
  { value: 0.5, label: '50%' },
] as const;

export type ScreenCaptureScale =
  (typeof SCREEN_CAPTURE_SCALES)[number]['value'];

// Never forward malformed persisted values or unsupported caller values into
// native capture. Each choice scales both dimensions of the captured display.
export function normalizeScreenCaptureScale(
  value: unknown,
): ScreenCaptureScale {
  if (value === 0.75 || value === '0.75') return 0.75;
  if (value === 0.5 || value === '0.5') return 0.5;
  return 1;
}
