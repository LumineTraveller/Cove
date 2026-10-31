import type { NativeScreenColorSpace } from '../../../../electron/native-screen-capture-protocol';

/** The existing Producer fixes the codec; this policy changes only CPU input YUV. */
export function nativeScreenColorSpaceForCodecs(codecs: readonly { mimeType: string }[] | undefined): NativeScreenColorSpace | undefined {
  if (!Array.isArray(codecs)) return undefined;
  if (codecs.some(codec => !codec || typeof codec.mimeType !== 'string')) return undefined;
  // A Producer normally has one media codec plus RTX. Ambiguous, absent or
  // unverified media codecs must keep CPU capture on the stock source.
  const media = codecs.filter(codec => typeof codec?.mimeType === 'string' && codec.mimeType.toLowerCase() !== 'video/rtx');
  if (media.length !== 1) return undefined;
  switch (media[0].mimeType.toLowerCase()) {
    // Current SFU does not transport the color-space RTP extension; VP8's
    // receiver fallback is limited SMPTE170M, while validated AV1 uses BT709.
    case 'video/vp8': return 'bt601-limited';
    case 'video/av1': return 'bt709-limited';
    default: return undefined;
  }
}
