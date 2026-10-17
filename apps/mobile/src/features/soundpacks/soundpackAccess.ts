import {
  normalizeServerSecurityURL,
  serverRequestInit,
} from '../connection/serverSecurity';

export interface SoundpackAccessContext {
  serverURL: string;
  accountToken: string;
  roomId: string;
}
export type SoundpackFileVariant = 'playback' | 'original';
export interface SoundpackFileSource {
  uri: string;
  headers: Record<string, string>;
}
function requireContext(context: SoundpackAccessContext) {
  const serverURL = normalizeServerSecurityURL(context.serverURL);
  if (
    !serverURL ||
    !context.roomId ||
    context.roomId.length > 512 ||
    [...context.roomId].some(character => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    }) ||
    !context.accountToken ||
    context.accountToken.length > 4096 ||
    /[\r\n]/.test(context.accountToken)
  )
    throw new Error('需要有效的当前房间账号登录。');
  return serverURL;
}
export function soundpackRequestInit(
  context: SoundpackAccessContext,
  init: RequestInit = {},
): RequestInit {
  requireContext(context);
  const headers = new Headers(init.headers);
  headers.set('X-Cove-Account-Token', context.accountToken);
  return { ...init, headers };
}
/** Auth stays in headers; only room/resource identifiers appear in this same-server URL. */
export function soundpackFileURI(
  context: SoundpackAccessContext,
  soundId: string,
  variant: SoundpackFileVariant,
): string {
  const serverURL = requireContext(context);
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(soundId) ||
    !['playback', 'original'].includes(variant)
  )
    throw new Error('语音包资源无效。');
  return (
    serverURL +
    '/api/soundpacks/' +
    encodeURIComponent(soundId) +
    '/file?roomId=' +
    encodeURIComponent(context.roomId) +
    '&variant=' +
    variant
  );
}
export function soundpackFileSource(
  context: SoundpackAccessContext,
  soundId: string,
  variant: SoundpackFileVariant,
): SoundpackFileSource {
  const serverURL = requireContext(context);
  const uri = soundpackFileURI(context, soundId, variant);
  const init = serverRequestInit(serverURL, soundpackRequestInit(context));
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => {
    headers[name] = value;
  });
  return { uri, headers };
}
