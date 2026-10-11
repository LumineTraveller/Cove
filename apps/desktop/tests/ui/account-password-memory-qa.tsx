// Isolated Electron profile and fictional accounts only. No real authentication service.
const serverUrl = 'http://127.0.0.1:3317';
const history = ['alice', 'bob'].map(accountId => ({
  serverUrl, serverKey: 'synthetic-server', accountId, email: `${accountId}@example.test`,
}));
localStorage.setItem('cove_server_url', serverUrl);
localStorage.setItem('cove_remembered_logins', JSON.stringify(history));
localStorage.removeItem('cove_account_session');
localStorage.removeItem('cove_username');
window.fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith(serverUrl + '/api/')) throw new Error('Unexpected synthetic endpoint');
  let status = 200;
  let body: object;
  if (url.endsWith('/security/status')) body = { enabled: true, configured: true, bootstrapAvailable: false, tokenEpoch: 1, authorized: false, secureTransportRequired: false };
  else if (url.endsWith('/security/access')) body = { accessToken: 'fictional-access-token', expiresAt: Date.now() + 60000 };
  else if (url.endsWith('/auth/login')) {
    const request = JSON.parse(String(init?.body));
    if (request.password === 'fictional-alice-new-password') body = { token: 'fictional-account-token', account: { id: 'alice', email: 'alice@example.test', username: 'Synthetic Alice', avatarUrl: null } };
    else { status = 401; body = { error: '邮箱或密码错误' }; }
  } else if (url.endsWith('/version')) body = { upgradeRequired: false };
  else throw new Error('Unexpected synthetic request');
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
};
// Exercise the production entry, including StrictMode and scrollbar handling.
await import('../../src/main');
