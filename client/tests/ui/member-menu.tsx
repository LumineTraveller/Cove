// Mount the real room with an in-memory socket/API. Never connects or moderates real users.
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ChatRoom from '../../src/pages/ChatRoom';
import { socket } from '../../src/socket';
import '../../src/index.css';

const api = 'https://member-menu-test.invalid';
const actualFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith(api)) return actualFetch(input, init);
  return new Response(JSON.stringify(url.endsWith('/api/rooms/test')
    ? { id: 'test', name: '成员菜单测试', createdAt: 0, ownerName: '房主' } : []), { headers: { 'Content-Type': 'application/json' } });
};
const fake = socket as any;
fake.id = 'self'; fake.connected = true;
let owner = true;
let members = [
  { socketId: 'self', userId: 'self', username: '房主', isOwner: true, isMuted: false },
  { socketId: 'alice', userId: 'alice', username: '小雨', isOwner: false, isMuted: false },
  { socketId: 'protected', userId: 'protected', username: '受保护房主', isOwner: true, isMuted: false },
];
const requests: Array<{ event: string; data: any }> = [];
const publish = () => fake.listeners('room:state').forEach((listener: any) => listener({ roomId: 'test', members: [...members], isOwner: owner, ownerName: '房主' }));
fake.timeout = () => fake;
fake.emit = (event: string, data: any, callback?: any) => {
  if (event === 'room:join') queueMicrotask(publish);
  if (event === 'room:set-muted') {
    requests.push({ event, data });
    members = members.map(member => member.socketId === data.targetSocketId ? { ...member, isMuted: data.muted } : member);
    publish(); callback?.(null, { ok: true });
  }
  if (event === 'room:kick') { requests.push({ event, data }); callback?.(null, { ok: true }); }
  return fake;
};
(window as any).memberMenuTest = {
  requests,
  setOwner(value: boolean) { owner = value; publish(); },
  removeAlice() { members = members.filter(member => member.socketId !== 'alice'); publish(); },
};
createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/room/test']}><Routes><Route path="/room/:roomId" element={
    <ChatRoom profile={{ username: '房主', avatarUrl: null }} onProfileChange={() => {}} serverURL={api} sessionReady />
  } /></Routes></MemoryRouter>,
);
