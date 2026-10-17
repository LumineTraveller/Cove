/** A room instance owns its requests; cancellation cannot affect the next room. */
export function createSoundpackRoomLifetime(roomId: string) {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    active: () => !controller.signal.aborted,
    accepts: (event: unknown) => !controller.signal.aborted && Boolean(roomId) &&
      (event as { roomId?: unknown } | null)?.roomId === roomId,
    cancel: () => controller.abort(),
  };
}

export function soundpackRequestInit(accountToken: string, init: RequestInit = {}): RequestInit {
  if (!accountToken) throw new Error('账号认证已失效，请重新登录');
  const headers = new Headers(init.headers);
  headers.set('X-Cove-Account-Token', accountToken);
  return { ...init, headers, redirect: 'error' };
}

export function soundpackRoomFilePath(soundId: string, roomId: string, variant: 'playback' | 'original'): string {
  if (!soundId || !roomId) throw new Error('语音包房间无效');
  return `/api/soundpacks/${encodeURIComponent(soundId)}/file?${new URLSearchParams({ roomId, variant })}`;
}

/** Bare legacy arrays and mixed/global responses are never a room capability. */
export function readSoundpackRoomList<T extends { roomId: string }>(value: unknown, roomId: string): T[] | null {
  const payload = value as { roomId?: unknown; soundpacks?: unknown } | null;
  if (!roomId || payload?.roomId !== roomId || !Array.isArray(payload.soundpacks) ||
    payload.soundpacks.some(sound => !sound || sound.roomId !== roomId)) return null;
  return payload.soundpacks as T[];
}
