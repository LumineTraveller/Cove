import type { UserProfile } from './types';

const USERNAME_KEY = 'cove_username';
const AVATAR_KEY = 'cove_avatar_url';
const MAX_AVATAR_BYTES = 220 * 1024;

export function readProfile(): UserProfile {
  return {
    username: localStorage.getItem(USERNAME_KEY) ?? '',
    avatarUrl: localStorage.getItem(AVATAR_KEY),
  };
}

export function persistProfile(profile: UserProfile) {
  localStorage.setItem(USERNAME_KEY, profile.username.trim().slice(0, 64));
  if (profile.avatarUrl) localStorage.setItem(AVATAR_KEY, profile.avatarUrl);
  else localStorage.removeItem(AVATAR_KEY);
}

export function clearProfile() {
  localStorage.removeItem(USERNAME_KEY);
  localStorage.removeItem(AVATAR_KEY);
}

export async function prepareAvatar(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件');
  if (file.size > 8 * 1024 * 1024) throw new Error('原始图片不能超过 8MB');

  const bitmap = await createImageBitmap(file);
  const size = 256;
  const scale = Math.max(size / bitmap.width, size / bitmap.height);
  const sourceWidth = size / scale;
  const sourceHeight = size / scale;
  const sourceX = (bitmap.width - sourceWidth) / 2;
  const sourceY = (bitmap.height - sourceHeight) / 2;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法处理头像图片');
  context.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, size, size);
  bitmap.close();

  for (const quality of [0.86, 0.74, 0.62]) {
    const dataUrl = canvas.toDataURL('image/webp', quality);
    if (dataUrl.length <= MAX_AVATAR_BYTES) return dataUrl;
  }
  throw new Error('头像压缩后仍然过大，请换一张图片');
}
