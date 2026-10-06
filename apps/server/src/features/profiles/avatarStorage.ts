import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import {CLIENT_PROTOCOL_VERSION} from '@cove/contracts';

const assetPath = /^\/avatars\/([a-f0-9]{64}\.(?:png|jpg|webp|gif))$/;
const cropPattern = /^#cove-crop=-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?,\d+(?:\.\d+)?$/;
const maxLength = 12 * 1024 * 1024;

/** Immutable files preserve GIF bytes and avoid sending image data over signaling. */
export function createAvatarStorage(dataDir: string) {
  const directory = path.join(dataDir, 'avatars');
  fs.mkdirSync(directory, { recursive: true });

  function reference(value: string): string | null {
    try {
      const url = new URL(value, 'http://avatar.invalid');
      const match = assetPath.exec(url.pathname);
      if (!match || (url.hash && !cropPattern.test(url.hash))) return null;
      if (!fs.existsSync(path.join(directory, match[1]))) return null;
      return url.pathname + url.hash;
    } catch {
      return null;
    }
  }

  function save(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > maxLength) return null;
    if (!value.startsWith('data:')) return reference(value);
    const match =
      /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})(#cove-crop=.*)?$/i.exec(
        value,
      );
    if (!match || (match[3] && !cropPattern.test(match[3]))) return null;
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > 8 * 1024 * 1024 || bytes.toString('base64') !== match[2])
      return null;
    const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
    const filename = `${createHash('sha256').update(bytes).digest('hex')}.${ext}`;
    const destination = path.join(directory, filename);
    const temporary = path.join(directory, `.${randomUUID()}.tmp`);
    try {
      if (!fs.existsSync(destination)) {
        fs.writeFileSync(temporary, bytes, { flag: 'wx' });
        fs.renameSync(temporary, destination);
      }
    } catch (error) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        /* preserve the original failure */
      }
      console.warn('[avatar] file save failed', error);
      return null;
    }
    return `/avatars/${filename}${match[3] ?? ''}`;
  }

  return { directory, save, reference };
}

/** Resolve only server-owned avatar paths, never arbitrary URLs from a client. */
export function mapAvatarUrls<T>(value: T, origin: string, accessToken?: string): T {
  function visit(node: any): any {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(
      Object.entries(node).map(([key, item]) => {
        if (key === 'avatarUrl' && typeof item === 'string' && assetPath.test(item.split('#')[0])) {
          const url = new URL(item, origin);
          if (accessToken) {
            url.searchParams.set('access_token', accessToken);
            url.searchParams.set('client_protocol', String(CLIENT_PROTOCOL_VERSION));
          }
          return [key, url.href];
        }
        return [key, visit(item)];
      }),
    );
  }
  return visit(value);
}

export function avatarOrigin(headers: Record<string, unknown>, encrypted = false): string {
  const configured = process.env.COVE_PUBLIC_BASE_URL?.trim();
  if (configured) {
    const url = new URL(configured);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Invalid COVE_PUBLIC_BASE_URL');
    return url.origin;
  }
  const forwarded =
    typeof headers['x-forwarded-proto'] === 'string'
      ? headers['x-forwarded-proto'].split(',')[0].trim()
      : '';
  const trusted = process.env.COVE_TRUST_PROXY?.trim().toLowerCase() === 'true';
  const protocol = encrypted || (trusted && forwarded === 'https') ? 'https' : 'http';
  const host = typeof headers.host === 'string' ? headers.host : 'localhost';
  // Malformed Host headers must not turn a presence broadcast into an
  // uncaught exception. Normal clients always send a valid host and port.
  try {
    const url = new URL(`${protocol}://${host}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      return `${protocol}://localhost`;
    return url.origin;
  } catch {
    return `${protocol}://localhost`;
  }
}
