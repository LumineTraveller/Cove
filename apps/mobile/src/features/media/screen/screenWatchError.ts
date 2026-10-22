export function screenWatchError(cause: unknown, screenVideo: boolean): string {
  const message = cause instanceof Error ? cause.message : '无法接收媒体流';
  if (screenVideo && /cannot consume|unsupported codec|no compatible.*codec/i.test(message))
    return '无法接收此共享编码。请共享者启用“兼容观看（VP8）”后重新共享。';
  return message;
}
