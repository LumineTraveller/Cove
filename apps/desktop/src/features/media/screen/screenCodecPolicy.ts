/** Sending/router capabilities do not describe every viewer. Keep the existing
 * quality preference unless the sharer explicitly requests common VP8 media. */
export function screenPublicationCodecCandidates<T extends { mimeType: string }>(
  negotiatedCodecs: readonly T[],
  compatibilityMode: boolean,
): Array<T | undefined> {
  const find = (mimeType: string) => negotiatedCodecs.find(codec => codec.mimeType.toLowerCase() === mimeType);
  if (compatibilityMode) {
    const vp8 = find('video/vp8');
    if (!vp8) throw new Error('当前设备与服务器未协商到 VP8，无法开启兼容观看。请关闭兼容模式或更换受支持的客户端/服务器。');
    return [vp8];
  }
  return [...[find('video/av1'), find('video/vp9')].filter((codec): codec is T => codec !== undefined), undefined];
}
