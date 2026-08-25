export const CHAT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const CHAT_IMAGE_MAX_BATCH = 5;

const CHAT_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

const CHAT_IMAGE_EXTENSION_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

export function chatImageMimeType(file: Pick<File, 'name' | 'type'>): string | null {
  const normalizedType = file.type.toLowerCase();
  if (CHAT_IMAGE_MIME_TYPES.has(normalizedType)) return normalizedType;
  if (normalizedType) return null;
  const extension = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return extension ? CHAT_IMAGE_EXTENSION_TYPES[extension] ?? null : null;
}

export function collectChatImageFiles(files: ArrayLike<File>): File[] {
  return Array.from(files).filter(file => file.type.toLowerCase().startsWith('image/') || chatImageMimeType(file) !== null);
}

export function validateChatImageFile(file: Pick<File, 'name' | 'size' | 'type'>): string | null {
  if (!chatImageMimeType(file)) return `${file.name || '该文件'}：仅支持 PNG、JPEG、WebP 或 GIF 图片`;
  if (file.size <= 0) return `${file.name || '该文件'}：图片内容为空`;
  if (file.size > CHAT_IMAGE_MAX_BYTES) return `${file.name || '该文件'}：图片不能超过 5MB`;
  return null;
}
