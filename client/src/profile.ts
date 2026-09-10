import type { UserProfile } from './types';

const USERNAME_KEY = 'cove_username';
const AVATAR_KEY = 'cove_avatar_url';
const MAX_AVATAR_BYTES = 220 * 1024;
const MAX_ANIMATED_AVATAR_BYTES = 8 * 1024 * 1024;
// Keep large animated avatars on the server/in-memory state instead of
// duplicating multi-megabyte data URLs in localStorage and login history.
export const MAX_PERSISTED_AVATAR_DATA_URL_LENGTH = 512 * 1024;

export interface AvatarCrop {
  offsetX: number;
  offsetY: number;
  zoom: number;
  previewSize: number;
}

const AVATAR_CROP_MARKER = "#cove-crop=";

export interface AvatarCropPresentation {
  source: string;
  zoom: number;
  offsetX: number;
  offsetY: number;
}

export function withAvatarCropMetadata(dataUrl: string, crop: AvatarCrop): string {
  const previewSize = Math.max(1, crop.previewSize);
  const x = Math.max(-1, Math.min(1, crop.offsetX / previewSize)).toFixed(5);
  const y = Math.max(-1, Math.min(1, crop.offsetY / previewSize)).toFixed(5);
  const zoom = Math.max(1, Math.min(3, crop.zoom)).toFixed(5);
  return `${dataUrl.split(AVATAR_CROP_MARKER, 1)[0]}${AVATAR_CROP_MARKER}${x},${y},${zoom}`;
}

export function avatarCropPresentation(value: string): AvatarCropPresentation | null {
  const markerIndex = value.indexOf(AVATAR_CROP_MARKER);
  if (markerIndex < 0) return null;
  const [x, y, zoom] = value.slice(markerIndex + AVATAR_CROP_MARKER.length).split(",").map(Number);
  if (![x, y, zoom].every(Number.isFinite)) return null;
  return {
    source: value.slice(0, markerIndex),
    offsetX: Math.max(-1, Math.min(1, x)),
    offsetY: Math.max(-1, Math.min(1, y)),
    zoom: Math.max(1, Math.min(3, zoom)),
  };
}

export function profileForStorage(profile: UserProfile): UserProfile {
  const avatarUrl = profile.avatarUrl && profile.avatarUrl.length <= MAX_PERSISTED_AVATAR_DATA_URL_LENGTH
    ? profile.avatarUrl
    : null;
  return { username: profile.username.trim().slice(0, 64), avatarUrl };
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('无法读取头像图片'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('无法读取头像图片'));
    reader.readAsDataURL(blob);
  });
}

export function readProfile(): UserProfile {
  return {
    username: localStorage.getItem(USERNAME_KEY) ?? '',
    avatarUrl: localStorage.getItem(AVATAR_KEY),
  };
}

export function persistProfile(profile: UserProfile) {
  const saved = profileForStorage(profile);
  try {
    localStorage.setItem(USERNAME_KEY, saved.username);
    if (saved.avatarUrl) localStorage.setItem(AVATAR_KEY, saved.avatarUrl);
    else localStorage.removeItem(AVATAR_KEY);
  } catch {
    // A browser profile may already be close to quota. Preserve the name and
    // let the server-provided avatar hydrate again on the next connection.
    try {
      localStorage.setItem(USERNAME_KEY, saved.username);
      localStorage.removeItem(AVATAR_KEY);
    } catch {
      // The in-memory profile remains usable for the current session.
    }
  }
}

export function clearProfile() {
  localStorage.removeItem(USERNAME_KEY);
  localStorage.removeItem(AVATAR_KEY);
}

export async function prepareAvatar(file: File, crop?: AvatarCrop): Promise<string> {
  const normalizedType = file.type.toLowerCase();
  const isGif = normalizedType === 'image/gif' || /\.gif$/i.test(file.name);
  if (!normalizedType.startsWith('image/') && !isGif) throw new Error('请选择图片文件');
  if (file.size > 8 * 1024 * 1024) throw new Error('原始图片不能超过 8MB');

  // Keep animated GIF data intact. Drawing it through createImageBitmap/canvas
  // would retain only the first frame and silently turn it into a still image.
  if (isGif) {
    if (file.size > MAX_ANIMATED_AVATAR_BYTES) throw new Error('GIF头像不能超过 8MB');
    const bytes = await file.arrayBuffer();
    const dataUrl = await readBlobAsDataUrl(new Blob([bytes], { type: 'image/gif' }));
    return crop ? withAvatarCropMetadata(dataUrl, crop) : dataUrl;
  }

  const bitmap = await createImageBitmap(file);
  const size = 256;
  const cropZoom = Math.max(1, Math.min(4, crop?.zoom ?? 1));
  const previewSize = Math.max(1, crop?.previewSize ?? size);
  const previewScale = Math.max(previewSize / bitmap.width, previewSize / bitmap.height);
  const cropSide = Math.min(bitmap.width, bitmap.height) / cropZoom;
  const centerX = bitmap.width / 2 - ((crop?.offsetX ?? 0) / (previewScale * cropZoom));
  const centerY = bitmap.height / 2 - ((crop?.offsetY ?? 0) / (previewScale * cropZoom));
  const sourceX = Math.max(0, Math.min(bitmap.width - cropSide, centerX - cropSide / 2));
  const sourceY = Math.max(0, Math.min(bitmap.height - cropSide, centerY - cropSide / 2));
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法处理头像图片');
  context.drawImage(bitmap, sourceX, sourceY, cropSide, cropSide, 0, 0, size, size);
  bitmap.close();

  for (const quality of [0.86, 0.74, 0.62]) {
    const dataUrl = canvas.toDataURL('image/webp', quality);
    if (dataUrl.length <= MAX_AVATAR_BYTES) return dataUrl;
  }
  throw new Error('头像压缩后仍然过大，请换一张图片');
}
