import {soundpackFileSource, soundpackRequestInit} from '../src/features/soundpacks/soundpackAccess';
import {clearServerAccessToken, getServerAccessGrant, setServerAccessToken} from '../src/features/connection/serverSecurity';
const serverURL = 'https://synthetic.example.test/cove';
const context = {serverURL, roomId: 'room-a', accountToken: 'synthetic-account-secret'};
afterEach(() => clearServerAccessToken(serverURL));
test('protected file uses account/server headers without putting credentials or static paths in the URL', () => {
  const expiresAt = Date.now() + 60000;
  setServerAccessToken(serverURL, {accessToken: 'synthetic-server-secret', expiresAt});
  const source = soundpackFileSource(context, 'sound-a', 'playback');
  expect(source.uri).toBe(serverURL + '/api/soundpacks/sound-a/file?roomId=room-a&variant=playback');
  const headers = new Headers(source.headers);
  expect(headers.get('X-Cove-Account-Token')).toBe(context.accountToken);
  expect(headers.get('Authorization')).toBe('Bearer synthetic-server-secret');
  expect(headers.get('X-Cove-Client-Platform')).toBe('mobile');
  expect(source.uri).not.toMatch(/secret|access_token|accountToken|\/sounds\//);
  expect(getServerAccessGrant(serverURL)?.expiresAt).toBe(expiresAt);
});
test('original file and opaque room contexts stay in the normalized selected server path', () => {
  const source = soundpackFileSource({...context, serverURL: serverURL + '/', roomId: 'room #?中'}, 'sound_b', 'original');
  const url = new URL(source.uri);
  expect(url.pathname).toBe('/cove/api/soundpacks/sound_b/file');
  expect(url.searchParams.get('roomId')).toBe('room #?中');
  expect(url.searchParams.get('variant')).toBe('original');
  expect([...url.searchParams.keys()]).toEqual(['roomId', 'variant']);
});
test.each(['../x', 'x/y', 'x\\y', 'https://external.test', 'x?access_token=secret', ''])('invalid resource id %s cannot become a credential-bearing URL', soundId => {
  expect(() => soundpackFileSource(context, soundId, 'original')).toThrow();
});
test.each([{serverURL: 'https://user:pass@synthetic.test'}, {roomId: ''}, {roomId: 'bad\nroom'}, {accountToken: ''}, {accountToken: 'bad\r\ntoken'}])('invalid request context fails closed', override => {
  expect(() => soundpackFileSource({...context, ...override}, 'sound-a', 'original')).toThrow();
});
test('list/upload preserve cancellation and account headers without changing caller data', () => {
  const abort = new AbortController();
  const init = soundpackRequestInit(context, {method: 'POST', signal: abort.signal, headers: {'Content-Type': 'application/json'}, body: '{}'});
  expect(new Headers(init.headers).get('X-Cove-Account-Token')).toBe(context.accountToken);
  expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
  expect(init.signal).toBe(abort.signal);
  expect(init.body).toBe('{}');
});
