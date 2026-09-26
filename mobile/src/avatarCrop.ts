const AVATAR_CROP_MARKER = '#cove-crop=';

export interface AvatarCropPresentation {
  source: string;
  zoom: number;
  offsetX: number;
  offsetY: number;
}

/** Strip the desktop crop suffix and return display offsets for the avatar image. */
export function avatarCropPresentation(value: string): AvatarCropPresentation | null {
  const markerIndex = value.indexOf(AVATAR_CROP_MARKER);
  if (markerIndex < 0) return null;
  const [x, y, zoom] = value.slice(markerIndex + AVATAR_CROP_MARKER.length).split(',').map(Number);
  if (![x, y, zoom].every(Number.isFinite)) return null;
  return {
    source: value.slice(0, markerIndex),
    offsetX: Math.max(-1, Math.min(1, x)),
    offsetY: Math.max(-1, Math.min(1, y)),
    zoom: Math.max(1, Math.min(3, zoom)),
  };
}

export function avatarImageSource(value?: string | null): string | null {
  if (!value) return null;
  return avatarCropPresentation(value)?.source ?? value;
}
