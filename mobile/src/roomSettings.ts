export const ROOM_LIMIT_PRESETS = ['', '2', '5', '10', '20'];

export function roomLimit(value: string): number | null {
  if (!value.trim()) return null;
  if (!/^\d+$/.test(value.trim())) throw new Error('人数上限须为 1–1000 的整数');
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('人数上限须为 1–1000 的整数');
  return limit;
}

export function roomPassword(value: string): string | undefined {
  if (value === '') return undefined;
  if (!value.trim() || value.length > 128) throw new Error('密码须为 1–128 个字符，且不能全为空格');
  return value;
}

export function roomSettingsPayload(roomId: string, limit: string, password: string, clear = false) {
  return { roomId, maxMembers: roomLimit(limit), ...(clear ? { password: null } : { password: roomPassword(password) }) };
}
