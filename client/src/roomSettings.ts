export type RoomSettingsPassword = string | null | undefined;

export function parseMaxMembers(value: string): number | null {
  if (!value) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 1000 ? number : NaN;
}

export function validRoomPassword(password: string): boolean {
  return password.length >= 1 && password.length <= 128 && password.trim().length > 0;
}

export function createRoomPayload(name: string, maxMembers: string, password: string) {
  const limit = parseMaxMembers(maxMembers);
  if (Number.isNaN(limit)) throw new Error('人数上限必须是 1 到 1000 的整数');
  if (password && !validRoomPassword(password)) throw new Error('密码必须为 1 到 128 个字符且不能全为空白');
  return {
    name: name.trim(),
    maxMembers: limit,
    password: validRoomPassword(password) ? password : undefined,
  };
}

export function updateRoomPayload(roomId: string, maxMembers: string, passwordAction: 'keep' | 'set' | 'clear', password: string) {
  const limit = parseMaxMembers(maxMembers);
  if (Number.isNaN(limit)) throw new Error('人数上限必须是 1 到 1000 的整数');
  if (passwordAction === 'set' && !validRoomPassword(password)) throw new Error('密码必须为 1 到 128 个字符且不能全为空白');
  return {
    roomId,
    maxMembers: limit,
    password: passwordAction === 'keep' ? undefined : passwordAction === 'clear' ? null : password,
  };
}
