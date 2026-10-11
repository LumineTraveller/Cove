export type RemoteControlInput =
  | { type: 'pointer'; x: number; y: number }
  | { type: 'button'; button: 'left' | 'right' | 'middle'; down: boolean; x: number; y: number }
  | { type: 'wheel'; deltaX: number; deltaY: number; x: number; y: number }
  | { type: 'key'; code: string; down: boolean };

// 16ms capped native cursor updates near 60Hz even on 120/144Hz controllers.
// Bound mouse traffic to 125Hz, leaving headroom under the server's 240/s
// input limit for button, wheel and keyboard edges. No synthetic positions.
export const REMOTE_POINTER_INTERVAL_MS = 8;

/** Leading/trailing pointer throttle; every non-pointer is an ordering barrier. */
export class RemotePointerSender {
  private lastSent = -Infinity;
  private pending: Extract<RemoteControlInput, { type: 'pointer' }> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly emit: (input: RemoteControlInput) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  send(input: RemoteControlInput) {
    if (input.type !== 'pointer') {
      this.flush();
      this.emit(input);
      return;
    }
    this.pending = input;
    const remaining = REMOTE_POINTER_INTERVAL_MS - (this.now() - this.lastSent);
    if (remaining <= 0) this.flush();
    else if (this.timer === null) this.timer = setTimeout(() => this.flush(), remaining);
  }

  private flush() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const input = this.pending;
    this.pending = null;
    if (!input) return;
    this.lastSent = this.now();
    this.emit(input);
  }

  cancel() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.lastSent = -Infinity;
  }
}

export interface VideoSurfaceRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Maps a pointer into the actual object-contain video area, excluding letterbox bars. */
export function normalizedVideoPoint(
  clientX: number,
  clientY: number,
  rect: VideoSurfaceRect,
  videoWidth: number,
  videoHeight: number,
  devicePixelRatio = 1,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0 || videoWidth <= 0 || videoHeight <= 0) return null;
  if (clientX < rect.left || clientX > rect.left + rect.width ||
      clientY < rect.top || clientY > rect.top + rect.height) return null;
  const videoRatio = videoWidth / videoHeight;
  const containerRatio = rect.width / rect.height;
  let width = rect.width;
  let height = rect.height;
  let left = rect.left;
  let top = rect.top;
  if (containerRatio > videoRatio) {
    width = rect.height * videoRatio;
    left += (rect.width - width) / 2;
  } else {
    height = rect.width / videoRatio;
    top += (rect.height - height) / 2;
  }
  // A fullscreen viewport rounded to CSS pixels can differ slightly from the
  // source aspect ratio (e.g. 1707x1067 vs 2560x1600 at 150% Windows scaling).
  // Its subpixel contain gutter must not discard the entire outer pixel row.
  // Only extend hit testing for gutters at most one physical pixel wide; keep
  // the actual contain geometry for mapping and exclude intentional black bars.
  const ratio = Number.isFinite(devicePixelRatio) ? Math.max(1, devicePixelRatio) : 1;
  const tolerance = 1 / ratio;
  const horizontalRounding = left - rect.left <= tolerance;
  const verticalRounding = top - rect.top <= tolerance;
  const hitLeft = horizontalRounding ? rect.left : left;
  const hitRight = horizontalRounding ? rect.left + rect.width : left + width;
  const hitTop = verticalRounding ? rect.top : top;
  const hitBottom = verticalRounding ? rect.top + rect.height : top + height;
  if (clientX < hitLeft || clientX > hitRight || clientY < hitTop || clientY > hitBottom)
    return null;
  return {
    x: Math.max(0, Math.min(1, (clientX - left) / width)),
    y: Math.max(0, Math.min(1, (clientY - top) / height)),
  };
}

export function remoteMouseButton(button: number): 'left' | 'right' | 'middle' | null {
  if (button === 0) return 'left';
  if (button === 1) return 'middle';
  if (button === 2) return 'right';
  return null;
}
