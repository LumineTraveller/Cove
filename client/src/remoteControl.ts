export type RemoteControlInput =
  | { type: 'pointer'; x: number; y: number }
  | { type: 'button'; button: 'left' | 'right' | 'middle'; down: boolean; x: number; y: number }
  | { type: 'wheel'; deltaX: number; deltaY: number; x: number; y: number }
  | { type: 'key'; code: string; down: boolean };

/** Leading/trailing 16ms pointer throttle; every non-pointer is an ordering barrier. */
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
    const remaining = 16 - (this.now() - this.lastSent);
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

export interface VideoSurfaceRect { left: number; top: number; width: number; height: number }

/** Maps a pointer into the actual object-contain video area, excluding letterbox bars. */
export function normalizedVideoPoint(
  clientX: number,
  clientY: number,
  rect: VideoSurfaceRect,
  videoWidth: number,
  videoHeight: number,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0 || videoWidth <= 0 || videoHeight <= 0) return null;
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
  if (clientX < left || clientX > left + width || clientY < top || clientY > top + height) return null;
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
