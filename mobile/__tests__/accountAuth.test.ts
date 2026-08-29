import { authenticateAccount, validAccountEmail } from '../src/accountAuth';

beforeEach(() => { globalThis.fetch = jest.fn(); });

test('validates account email format', () => {
  expect(validAccountEmail('alice@example.com')).toBe(true);
  expect(validAccountEmail('alice@example')).toBe(false);
  expect(validAccountEmail('alice @example.com')).toBe(false);
});

test('registers against the normalized Cove server endpoint', async () => {
  jest.mocked(fetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      token: 'token',
      account: { id: 'account', email: 'alice@example.com', username: 'Alice', avatarUrl: null },
    }),
  } as Response);

  const result = await authenticateAccount({
    mode: 'register', username: ' Alice ', email: ' alice@example.com ', password: 'password',
    serverURL: 'server.test:3001/', allowInvalidServerCertificate: false,
  });

  expect(result.token).toBe('token');
  expect(fetch).toHaveBeenCalledWith('http://server.test:3001/api/auth/register', expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({ email: 'alice@example.com', password: 'password', username: 'Alice' }),
  }));
});

test('surfaces server account errors', async () => {
  jest.mocked(fetch).mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: '该邮箱已注册' }) } as Response);
  await expect(authenticateAccount({
    mode: 'login', username: '', email: 'alice@example.com', password: 'password',
    serverURL: 'http://server.test:3001', allowInvalidServerCertificate: false,
  })).rejects.toThrow('该邮箱已注册');
});
