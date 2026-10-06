import { socket } from '../connection/socket';
import type { Room } from '../../types';

export type RoomWithAppearance = Room & {
  count?: number;
  avatarUrl?: string | null;
  backgroundTop?: string | null;
  backgroundBottom?: string | null;
  backgroundTopDark?: string | null;
  backgroundBottomDark?: string | null;
};

export function roomColor(value: string | null | undefined, fallback: string) {
  return /^#[0-9a-f]{6}$/i.test(value ?? '') ? value! : fallback;
}

export const ROOM_LIGHT_TOP = '#FFFFFF';

export const ROOM_LIGHT_BOTTOM = '#FFFFFF';

export const ROOM_DARK_TOP = '#111827';

export const ROOM_DARK_BOTTOM = '#0B1220';

export function colorLuminance(value: string) {
  const hex = value.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return 1;
  const channels = [0, 2, 4]
    .map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

export function resolveRoomAvatarUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('data:') || url.startsWith('http:') || url.startsWith('https:')) return url;
  const base = ((socket as any).io?.uri ?? '').replace(/\/$/, '');
  return base ? `${base}${url}` : url;
}
