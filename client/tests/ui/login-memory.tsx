// Run in a dedicated test profile. Simulated accounts and socket; no external server requests.
import { createRoot } from 'react-dom/client';
import App from '../../src/App';
import { disconnectAccountSession, rememberAccountSession } from '../../src/accountAuth';
import { clearProfile } from '../../src/profile';
import { socket, getServerURL } from '../../src/socket';
import '../../src/index.css';
if (!sessionStorage.getItem('login-test-seeded')) {
  for (const name of ['a', 'b']) rememberAccountSession({ serverUrl: `https://${name}.test`, email: `${name}@test.com`, token: `test-${name}`, accountId: name, profile: { username: name === 'a' ? 'Alice' : 'Bob', avatarUrl: null } });
  disconnectAccountSession(); clearProfile(); localStorage.removeItem('cove_server_url');
  sessionStorage.setItem('login-test-seeded', 'true');
}
const actualFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = String(input);
  if (!/^https:\/\/[ab]\.test\//.test(url)) return actualFetch(input, init);
  if (url.includes('/api/auth/login') || url.includes('/api/auth/register')) throw new Error('Remembered login must not need a password request');
  return new Response(url.endsWith('/logout') ? null : '[]', { status: url.endsWith('/logout') ? 204 : 200, headers: { 'Content-Type': 'application/json' } });
};
const fake = socket as any;
fake.id = 'test-socket'; fake.connected = false;
fake.timeout = () => fake;
fake.connect = () => { fake.connected = true; fake.listeners('connect').forEach((listener: any) => listener()); return fake; };
fake.disconnect = () => { fake.connected = false; return fake; };
fake.emit = (event: string, ...args: any[]) => {
  const callback = args.find(value => typeof value === 'function');
  if (event === 'user:register') callback?.(null, sessionStorage.getItem('expired-server') === getServerURL()
    ? { ok: false, error: '登录已失效，请重新登录' } : { ok: true });
  if (event === 'presence:get') callback?.(null, { ok: true, onlineUsers: [], roomMembers: {}, voiceCounts: {} });
  return fake;
};
createRoot(document.getElementById('root')!).render(<App />);
