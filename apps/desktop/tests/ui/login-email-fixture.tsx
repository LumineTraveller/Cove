// Real App effects, account/password helpers, serverSecurity and fetch wrappers.
// All credentials below are fictional, in-memory data in an isolated profile.
import { createRoot } from 'react-dom/client';

const SERVER_A = 'https://login-a.example.test';
const SERVER_B = 'https://login-b.example.test/tenant';
const ALICE = 'alice@example.test';
const BOB = 'bob@example.test';
const scenario = new URL(location.href).searchParams.get('case') ?? 'typing';
type Grant = { accessToken: string; expiresAt: number };
type Call = { kind: string; server?: string; email?: string; token?: string };
type Held = { id: number; kind: string; server: string; email?: string; release: () => void };
const calls: Call[] = [];
const violations: string[] = [];
const held: Held[] = [];
const passwords = new Map<string, string>();
const grants = new Map<string, Grant>();
let sequence = 0;
let staleStatusResult: string | null = null;
let staleStatusOperation: Promise<unknown> | null = null;
let holdNextStatusBody = false;
const scope = (server: string, email: string) => JSON.stringify([server, email.trim().toLowerCase()]);
const fictionalGrant = (name: string): Grant => ({ accessToken: `fictional-grant-${name}`, expiresAt: Date.now() + 14 * 86400000 });
const defer = <T,>(kind: string, server: string, email: string | undefined, result: T): Promise<T> =>
  new Promise(resolve => { held.push({ id: ++sequence, kind, server, email, release: () => resolve(result) }); });

// The runner creates a unique userData and a fresh renderer per case.
localStorage.clear();
sessionStorage.clear();
localStorage.setItem('cove_server_url', SERVER_A);
passwords.set(scope(SERVER_A, 'saved@example.test'), 'fictional-filled-account-password');
const accounts = ['accounts', 'account-input', 'old-get', 'old-restore'].includes(scenario);
if (accounts) {
  localStorage.setItem('cove_remembered_logins', JSON.stringify([ALICE, BOB].map((email, index) => ({
    serverUrl: SERVER_A, serverKey: 'host:login-a.example.test:443',
    accountId: index ? 'fictional-bob' : 'fictional-alice', email,
  }))));
  passwords.set(scope(SERVER_A, ALICE), 'fictional-alice-account-password');
  passwords.set(scope(SERVER_A, BOB), 'fictional-bob-account-password');
  if (scenario !== 'account-input') {
    grants.set(scope(SERVER_A, ALICE), fictionalGrant('alice'));
    grants.set(scope(SERVER_A, BOB), fictionalGrant('bob'));
  }
}

window.coveAccountPasswords = {
  status: async () => ({ available: true, ok: true }),
  get: async (server, email) => {
    calls.push({ kind: 'password-get', server, email });
    const result = { available: true, ok: true, password: passwords.get(scope(server, email)) ?? null };
    return scenario === 'old-get' && email === ALICE
      ? defer('password-get', server, email, result) : result;
  },
  set: async (server, email, password) => { passwords.set(scope(server, email), password); return { available: true, ok: true }; },
  remove: async (server, email) => { passwords.delete(scope(server, email)); return { available: true, ok: true }; },
  clear: async () => { passwords.clear(); return { available: true, ok: true }; },
};
window.coveServerAccess = {
  get: async (server, email) => {
    calls.push({ kind: 'grant-get', server, email });
    const result = { available: true, ok: true, grant: grants.get(scope(server, email)) ?? null };
    return ['old-get', 'old-restore'].includes(scenario) && email === ALICE
      ? defer('grant-get', server, email, result) : result;
  },
  set: async (server, email, grant) => { grants.set(scope(server, email), grant); return { available: true, ok: true }; },
  remove: async (server, email) => {
    if (email) grants.delete(scope(server, email));
    else for (const key of grants.keys()) if (JSON.parse(key)[0] === server) grants.delete(key);
    return { available: true, ok: true };
  },
  clear: async () => { grants.clear(); return { available: true, ok: true }; },
};
// No DNS, real certificate exceptions, window controls or native credential IPC.
window.coveSecurity = {
  resolveServerAddresses: async () => [],
  setServerCertificateException: async () => true,
} as unknown as NonNullable<Window['coveSecurity']>;

window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const server = url.origin + (url.pathname.startsWith('/tenant/') ? '/tenant' : '');
  const token = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('Authorization')?.replace(/^Bearer /, '') ?? '';
  if (![SERVER_A, SERVER_B].includes(server)) {
    violations.push('unexpected-origin');
    throw new Error('Offline fixture blocked an unexpected request origin');
  }
  const endpoint = url.pathname.replace(/^\/tenant/, '');
  if (endpoint === '/api/security/status') {
    calls.push({ kind: 'status', server, token });
    const payload = {
      enabled: true, configured: true, bootstrapAvailable: false, tokenEpoch: 1,
      authorized: /^fictional-grant-/.test(token), secureTransportRequired: false,
    };
    if (scenario === 'old-probe' && server === SERVER_A) {
      return defer('status', server, undefined, new Response(JSON.stringify({ ...payload, enabled: false, authorized: false }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }
    const response = new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (holdNextStatusBody) {
      holdNextStatusBody = false;
      Object.defineProperty(response, 'json', { value: () => defer('status-body', server, undefined, { ...payload, enabled: false, authorized: false }) });
    }
    return response;
  }
  if (endpoint === '/api/version') {
    calls.push({ kind: 'version', server });
    return new Response(JSON.stringify({ minimumClientVersion: '2.0.0' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  violations.push('unexpected-endpoint');
  throw new Error('Offline fixture blocked an unexpected endpoint');
};

const api = {
  ready: false,
  constants: { SERVER_A, SERVER_B, ALICE, BOB },
  release(kind: string, email?: string) {
    for (let index = held.length - 1; index >= 0; index -= 1) {
      if (held[index].kind === kind && (!email || held[index].email === email)) held.splice(index, 1)[0].release();
    }
  },
  snapshot: () => ({
    scenario, calls: calls.map(call => ({ ...call })), violations: [...violations],
    held: held.map(({ id, kind, server, email }) => ({ id, kind, server, email })),
    email: document.querySelector<HTMLInputElement>('#login-email')?.value,
    server: document.querySelector<HTMLInputElement>('#login-server')?.value,
    serverPassword: document.querySelector<HTMLInputElement>('#login-server-password')?.value,
    accountPassword: document.querySelector<HTMLInputElement>('#login-password')?.value,
    token: security.getServerAccessToken(SERVER_A),
    staleStatusResult,
  }),
  async startOldStatusBody() {
    security.setServerAccessToken(SERVER_A, fictionalGrant('old-status'));
    holdNextStatusBody = true;
    staleStatusOperation = security.readServerSecurityStatus(SERVER_A).then(
      () => { staleStatusResult = 'resolved'; },
      error => { staleStatusResult = error?.name ?? 'rejected'; },
    );
  },
  installNewGrant() { security.setServerAccessToken(SERVER_A, fictionalGrant('new-status')); },
  finishOldStatus: () => staleStatusOperation,
};
// The API is only a test observation/transport-control seam, never a replacement
// for App state handlers. All form edits go through the real controlled inputs.
(window as unknown as { loginEmailQa: typeof api }).loginEmailQa = api;
const security = await import('../../src/features/connection/serverSecurity');
const { default: App } = await import('../../src/app/App');
createRoot(document.getElementById('root')!).render(<App />);
api.ready = true;
