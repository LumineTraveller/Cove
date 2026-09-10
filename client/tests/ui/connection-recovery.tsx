// Exercise the real room/effects without connecting to a server or using a microphone.
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ChatRoomV2 from '../../src/pages/ChatRoomV2';
import { socket } from '../../src/socket';
import '../../src/index.css';

const api = 'https://connection-recovery-test.invalid';
const room = { id: 'test', name: '恢复测试', createdAt: 0, ownerName: '测试用户' };
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith(api)) return realFetch(input, init);
  return new Response(JSON.stringify(url.endsWith('/api/rooms/test') ? room : [room]), {
    headers: { 'Content-Type': 'application/json' },
  });
};
const fake = socket as any;
fake.id = 'self';
fake.connected = true;
fake.recovered = true;
fake.connect = () => fake;
fake.timeout = () => fake;
const requests: string[] = [];
const publish = (event: string, ...args: unknown[]) => {
  for (const listener of [...fake.listeners(event)]) listener.apply(fake, args);
};
fake.emit = (event: string, _data: unknown, callback?: (...args: any[]) => void) => {
  requests.push(event);
  if (event === 'room:join') {
    queueMicrotask(() => {
      callback?.(null, { ok: true });
      publish('room:state', { roomId: room.id, members: [], isOwner: true, ownerName: room.ownerName });
    });
  } else if (event === 'room:history') {
    queueMicrotask(() => callback?.(null, { ok: true, messages: [], hasMore: false, nextCursor: null }));
  }
  return fake;
};
let teardowns = 0;
// resetVoice() calls this even when no microphone was captured. This detects
// premature media teardown while still testing the production WebRTC hook.
window.coveApplicationAudio = { stop: async () => { teardowns += 1; } } as any;
const root = createRoot(document.getElementById('root')!);
const render = (sessionReady: boolean) => flushSync(() => root.render(
  <MemoryRouter initialEntries={['/room/test']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
    <Routes><Route path="/room/:roomId" element={<ChatRoomV2
      profile={{ username: '测试用户', avatarUrl: null }} accountId="test"
      onProfileChange={() => {}} onLogout={() => {}} serverURL={api}
      sessionReady={sessionReady} theme="dark" onThemeChange={() => {}}
    />} /></Routes>
  </MemoryRouter>,
));
const settle = () => new Promise(resolve => setTimeout(resolve, 100));
const results: string[] = [];
const check = (condition: boolean, label: string) => {
  if (!condition) throw new Error(`${label}: teardowns=${teardowns}, requests=${JSON.stringify(requests)}`);
  results.push(label);
};

(window as any).connectionRecoveryResult = (async () => {
  render(true);
  await settle();
  check(document.querySelector('.control-ball') !== null, 'real ChatRoomV2 mounted');
  const baseline = teardowns;
  requests.length = 0;

  fake.connected = false;
  publish('disconnect', 'transport close');
  render(false);
  await settle();
  check(teardowns === baseline, 'temporary disconnect does not tear down media');

  fake.connected = true;
  publish('connect');
  render(true);
  await settle();
  check(teardowns === baseline, 'successful recovery does not tear down media');
  check(!requests.includes('room:leave') && !requests.includes('voice:leave'), 'recovery does not send leave requests');

  render(false); // Socket connected, but registration acknowledgement still pending.
  await settle();
  render(true);
  await settle();
  check(teardowns === baseline, 'registration pending/ready does not tear down media');
  check(!requests.includes('room:leave') && !requests.includes('voice:leave'), 're-registration does not leave the room');

  fake.connected = false;
  flushSync(() => root.unmount());
  await settle();
  check(teardowns > baseline, 'actual page exit still tears down media immediately');
  requests.length = 0;
  fake.connected = true;
  publish('connect');
  check(requests.includes('room:leave'), 'offline page exit leaves recovered server room');
  return { passed: true, results };
})().catch(error => ({ passed: false, results, error: String(error?.stack ?? error) }));
