import { randomBytes } from 'crypto';
import { derivePassword, passwordMatches } from './accountAuth';

export class RoomSettingsError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export function parseRoomLimit(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1_000)
    throw new RoomSettingsError('INVALID_SETTINGS', '人数上限应为 1–1000 的整数，或不限人数');
  return value;
}

export function validateRoomPassword(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || !value.trim() || value.length > 128)
    throw new RoomSettingsError('INVALID_SETTINGS', '房间密码应为 1–128 个字符，且不能全为空格');
  return value;
}

export async function hashRoomPassword(value: string | null | undefined) {
  if (value == null) return { passwordHash: null, passwordSalt: null };
  const passwordSalt = randomBytes(16).toString('hex');
  return { passwordSalt, passwordHash: (await derivePassword(value, passwordSalt)).toString('hex') };
}

export async function verifyRoomPassword(password: unknown, hash: string, salt: string): Promise<boolean> {
  if (typeof password !== 'string' || password.length > 128) return false;
  return passwordMatches(password, salt, hash);
}

export function assertRoomCapacity(members: ReadonlySet<string>, socketId: string, limit: number | null) {
  // Existing members (including those in the reconnect grace window) keep their seats.
  if (!members.has(socketId) && limit !== null && members.size >= limit)
    throw new RoomSettingsError('ROOM_FULL', '房间人数已满，请稍后再试');
}
