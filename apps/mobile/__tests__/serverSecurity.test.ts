import { MOBILE_RELEASE_VERSION } from '../src/features/connection/clientVersion';
import {
  authorizedResourceURL,
  bootstrapServer,
  clearServerAccessToken,
  ensureServerAccess,
  getServerAccessToken,
  serverRequestInit,
  setServerAccessToken,
  unlockServer,
} from '../src/features/connection/serverSecurity';
import { serverSocketAuth } from '../src/features/connection/socket';

const server = 'https://synthetic.example.test';
const grant = {
  accessToken: 'synthetic-access',
  expiresAt: Date.now() + 60000,
};
const response = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => payload } as Response);
beforeEach(() => {
  clearServerAccessToken(server);
  globalThis.fetch = jest.fn();
});

test('HTTP and Socket requests announce release, platform and unlocked access', () => {
  setServerAccessToken(server, grant);
  const headers = new Headers(serverRequestInit(server).headers);
  expect(headers.get('X-Cove-Client-Version')).toBe(MOBILE_RELEASE_VERSION);
  expect(headers.get('X-Cove-Client-Platform')).toBe('mobile');
  expect(headers.get('Authorization')).toBe('Bearer synthetic-access');
  expect(serverSocketAuth(server)).toEqual({
    serverAccessToken: grant.accessToken,
    clientProtocol: 3,
    clientVersion: MOBILE_RELEASE_VERSION,
    clientPlatform: 'mobile',
  });
});
test('media announces version even without unlock; external images never receive the server token', () => {
  let url = new URL(authorizedResourceURL(server, '/uploads/image.png'));
  expect(url.searchParams.get('client_version')).toBe(MOBILE_RELEASE_VERSION);
  expect(url.searchParams.get('client_platform')).toBe('mobile');
  expect(url.searchParams.get('client_protocol')).toBe('3');
  setServerAccessToken(server, grant);
  url = new URL(authorizedResourceURL(server, '/uploads/image.png'));
  expect(url.searchParams.get('access_token')).toBe(grant.accessToken);
  expect(authorizedResourceURL(server, 'https://external.test/image.png')).toBe(
    'https://external.test/image.png',
  );
});
test('bootstrap uses its own endpoint and retains the process-local grant', async () => {
  jest.mocked(fetch).mockResolvedValue(response(grant));
  await bootstrapServer(server, 'synthetic-bootstrap', 'synthetic-password');
  expect(fetch).toHaveBeenCalledWith(
    `${server}/api/security/bootstrap`,
    expect.objectContaining({
      body: JSON.stringify({
        bootstrapToken: 'synthetic-bootstrap',
        password: 'synthetic-password',
      }),
    }),
  );
  expect(getServerAccessToken(server)).toBe(grant.accessToken);
  clearServerAccessToken(server);
  expect(getServerAccessToken(server)).toBeNull();
});
test('configured server unlocks; uninitialized server requires bootstrap', async () => {
  jest
    .mocked(fetch)
    .mockResolvedValueOnce(response({ enabled: true, configured: true }))
    .mockResolvedValueOnce(response(grant));
  await expect(
    ensureServerAccess({ serverURL: server, password: 'synthetic-password' }),
  ).resolves.toEqual(expect.objectContaining(grant));
  expect(fetch).toHaveBeenLastCalledWith(
    `${server}/api/security/access`,
    expect.objectContaining({
      body: JSON.stringify({ password: 'synthetic-password' }),
    }),
  );
  clearServerAccessToken(server);
  jest
    .mocked(fetch)
    .mockResolvedValue(
      response({ enabled: true, configured: false, bootstrapAvailable: true }),
    );
  await expect(
    ensureServerAccess({ serverURL: server, password: 'synthetic-password' }),
  ).rejects.toMatchObject({ code: 'BOOTSTRAP_REQUIRED' });
});
test('invalid password or expired token cannot grant access', async () => {
  jest
    .mocked(fetch)
    .mockResolvedValue(
      response({ code: 'INVALID_PASSWORD', error: '拒绝合成密码' }, 403),
    );
  await expect(unlockServer(server, 'wrong')).rejects.toMatchObject({
    code: 'INVALID_PASSWORD',
  });
  expect(getServerAccessToken(server)).toBeNull();
  setServerAccessToken(server, { ...grant, expiresAt: Date.now() - 1 });
  expect(getServerAccessToken(server)).toBeNull();
});
test('version policy blocks authentication independently of password switch', async () => {
  jest
    .mocked(fetch)
    .mockResolvedValue(
      response({
        enabled: false,
        minimumClientVersion: '3.0.0',
        upgradeRequired: true,
      }),
    );
  await expect(
    ensureServerAccess({ serverURL: server, password: '' }),
  ).rejects.toMatchObject({ code: 'CLIENT_VERSION_TOO_OLD' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('offline status validation retains a valid grant and never retries password authentication', async () => {
  setServerAccessToken(server, grant);
  jest.mocked(fetch).mockRejectedValue(new TypeError('synthetic offline'));
  await expect(ensureServerAccess({ serverURL: server, password: '' })).rejects.toThrow('synthetic offline');
  expect(getServerAccessToken(server)).toBe(grant.accessToken);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('a late password response cannot resurrect an access token after logout clears it', async () => {
  let release!: (value: Response) => void;
  jest.mocked(fetch).mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const pending = unlockServer(server, 'synthetic-password');
  clearServerAccessToken(server);
  release(response(grant));
  await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  expect(getServerAccessToken(server)).toBeNull();
});
test('only the newest concurrent password exchange can install its server grant', async () => {
  let release!: (value: Response) => void;
  jest.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
    .mockResolvedValueOnce(response({ ...grant, accessToken: 'synthetic-newest-grant' }));
  const earlier = unlockServer(server, 'synthetic-earlier');
  await unlockServer(server, 'synthetic-newest');
  release(response(grant));
  await expect(earlier).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  expect(getServerAccessToken(server)).toBe('synthetic-newest-grant');
});
