import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import {
  initMediasoup, router, webRtcServer,
  peers, createPeer, removePeer, getRoomProducers,
  MS_IP, MS_PORT,
} from './ms';
import { createLobbyPresenceSnapshot } from './presence';
import { soundpackVoiceAudience } from './soundpackAudience';
import { createVoicePresenceEvent, voicePresenceMessage, type VoicePresenceAction } from './voicePresence';

const app = express();
const httpServer = createServer(app);

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '12mb' })); // 语音包 base64 最大约 8MB 文件

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ── SQLite ────────────────────────────────────────────────────────────────────

const dataDir = process.env.COVE_DATA_DIR?.trim() || path.join(os.homedir(), '.cove');
const dbPath = path.join(dataDir, 'cove.db');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    ownerId TEXT,
    ownerName TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    roomId TEXT NOT NULL,
    author TEXT NOT NULL,
    content TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'chat',
    timestamp INTEGER NOT NULL,
    FOREIGN KEY (roomId) REFERENCES rooms(id)
  );
  CREATE TABLE IF NOT EXISTS soundpacks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    filename TEXT NOT NULL,
    uploader TEXT NOT NULL,
    uploaderId TEXT,
    createdAt INTEGER NOT NULL,
    sortOrder INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS room_mutes (
    roomId TEXT NOT NULL,
    clientId TEXT NOT NULL,
    username TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    PRIMARY KEY (roomId, clientId)
  );
`);

// 兼容升级前已经创建的数据库。SQLite 的 CREATE TABLE IF NOT EXISTS 不会补列，
// 因此启动时显式检查并迁移。旧房间的 ownerId 为空，首次进入时会由该成员认领。
const roomColumns = db.prepare('PRAGMA table_info(rooms)').all() as { name: string }[];
if (!roomColumns.some(column => column.name === 'ownerId'))
  db.exec('ALTER TABLE rooms ADD COLUMN ownerId TEXT');
if (!roomColumns.some(column => column.name === 'ownerName'))
  db.exec('ALTER TABLE rooms ADD COLUMN ownerName TEXT');
const messageColumns = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
if (!messageColumns.some(column => column.name === 'type'))
  db.exec("ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'chat'");
const soundpackColumns = db.prepare('PRAGMA table_info(soundpacks)').all() as { name: string }[];
if (!soundpackColumns.some(column => column.name === 'uploaderId'))
  db.exec('ALTER TABLE soundpacks ADD COLUMN uploaderId TEXT');
if (!soundpackColumns.some(column => column.name === 'sortOrder')) {
  db.exec('ALTER TABLE soundpacks ADD COLUMN sortOrder INTEGER NOT NULL DEFAULT 0');
  const existing = db.prepare('SELECT id FROM soundpacks ORDER BY createdAt DESC').all() as { id: string }[];
  const updateOrder = db.prepare('UPDATE soundpacks SET sortOrder = ? WHERE id = ?');
  db.transaction((rows: { id: string }[]) => {
    rows.forEach((row, index) => updateOrder.run(index, row.id));
  })(existing);
}

// ownerId 是本地持久身份凭据，不通过 API 或 Socket 广播给其他客户端。
const stmtGetRooms       = db.prepare('SELECT id, name, createdAt, ownerName FROM rooms ORDER BY createdAt ASC');
const stmtGetRoom        = db.prepare('SELECT id, name, createdAt, ownerName FROM rooms WHERE id = ?');
const stmtGetRoomPrivate = db.prepare('SELECT id, name, createdAt, ownerId, ownerName FROM rooms WHERE id = ?');
const stmtInsertRoom     = db.prepare('INSERT INTO rooms (id, name, createdAt, ownerId, ownerName) VALUES (?, ?, ?, ?, ?)');
const stmtClaimRoom      = db.prepare('UPDATE rooms SET ownerId = ?, ownerName = ? WHERE id = ? AND ownerId IS NULL');
const stmtUpdateOwnerName = db.prepare('UPDATE rooms SET ownerName = ? WHERE ownerId = ? AND ownerName IS NOT ?');
const stmtDeleteRoom     = db.prepare('DELETE FROM rooms WHERE id = ?');
const stmtDeleteRoomMessages = db.prepare('DELETE FROM messages WHERE roomId = ?');
const stmtDeleteRoomMutes = db.prepare('DELETE FROM room_mutes WHERE roomId = ?');
const stmtGetMessages    = db.prepare('SELECT * FROM messages WHERE roomId = ? ORDER BY timestamp ASC');
const stmtInsertMsg      = db.prepare('INSERT INTO messages (id, roomId, author, content, type, timestamp) VALUES (?, ?, ?, ?, ?, ?)');
const stmtIsRoomMuted    = db.prepare('SELECT 1 FROM room_mutes WHERE roomId = ? AND clientId = ?');
const stmtMuteMember     = db.prepare('INSERT OR REPLACE INTO room_mutes (roomId, clientId, username, createdAt) VALUES (?, ?, ?, ?)');
const stmtUnmuteMember   = db.prepare('DELETE FROM room_mutes WHERE roomId = ? AND clientId = ?');
const stmtGetSoundpacks  = db.prepare('SELECT * FROM soundpacks ORDER BY sortOrder ASC, createdAt DESC');
const stmtGetSoundpack   = db.prepare('SELECT * FROM soundpacks WHERE id = ?');
const stmtGetNextSoundpackOrder = db.prepare('SELECT COALESCE(MIN(sortOrder), 0) - 1 AS sortOrder FROM soundpacks');
const stmtInsertSoundpack = db.prepare('INSERT INTO soundpacks (id, name, filename, uploader, uploaderId, createdAt, sortOrder) VALUES (?, ?, ?, ?, ?, ?, ?)');
const stmtUpdateSoundpackOrder = db.prepare('UPDATE soundpacks SET sortOrder = ? WHERE id = ?');
const stmtRenameSoundpack = db.prepare('UPDATE soundpacks SET name = ? WHERE id = ?');
const stmtDeleteSoundpack = db.prepare('DELETE FROM soundpacks WHERE id = ?');
const reorderSoundpacks = db.transaction((orderedIds: string[]) => {
  orderedIds.forEach((id, index) => stmtUpdateSoundpackOrder.run(index, id));
});
const deleteRoomData = db.transaction((roomId: string) => {
  stmtDeleteRoomMessages.run(roomId);
  stmtDeleteRoomMutes.run(roomId);
  stmtDeleteRoom.run(roomId);
});

interface Room      { id: string; name: string; createdAt: number; ownerName: string | null }
interface PrivateRoom extends Room { ownerId: string | null }
interface Message   { id: string; roomId: string; author: string; content: string; type: 'chat' | 'soundpack' | 'image' | 'system'; timestamp: number }
interface SoundpackRecord { id: string; name: string; filename: string; uploader: string; uploaderId: string | null; createdAt: number; sortOrder: number }
interface PublicSoundpack { id: string; name: string; filename: string; uploader: string; createdAt: number; sortOrder: number; canDelete: boolean }
interface RoomMember {
  socketId: string;
  userId: string;
  username: string;
  avatarUrl: string | null;
  isOwner: boolean;
  isMuted: boolean;
}

// ── 语音包文件目录 ─────────────────────────────────────────────────────────────
const SOUNDS_DIR = path.join(dataDir, 'sounds');
fs.mkdirSync(SOUNDS_DIR, { recursive: true });
const CHAT_IMAGES_DIR = path.join(dataDir, 'chat-images');
fs.mkdirSync(CHAT_IMAGES_DIR, { recursive: true });

const userNames   = new Map<string, string>();
const userAvatars = new Map<string, string | null>();
const userClientIds = new Map<string, string>(); // socketId → 持久客户端身份（不广播）
const voiceRooms  = new Map<string, Set<string>>(); // roomId → Set<socketId>
const roomMembers = new Map<string, Set<string>>();  // roomId → Set<socketId>
const selfMutedVoiceMembers = new Set<string>(); // 主动关闭麦克风的 socketId，仅在本次语音会话有效

function publicUserId(socketId: string): string {
  const stableId = userClientIds.get(socketId) ?? `socket:${socketId}`;
  // 房主凭据本身绝不能广播；只暴露不可逆摘要供客户端保存个人音量。
  return createHash('sha256').update(stableId).digest('hex').slice(0, 24);
}

function isRoomOwner(roomId: string | undefined, socketId: string | undefined): boolean {
  if (!roomId || !socketId || !roomMembers.get(roomId)?.has(socketId)) return false;
  const room = stmtGetRoomPrivate.get(roomId) as PrivateRoom | undefined;
  const clientId = userClientIds.get(socketId);
  return !!room?.ownerId && !!clientId && room.ownerId === clientId;
}

function toPublicSoundpack(pack: SoundpackRecord, requesterSocketId?: string, roomId?: string): PublicSoundpack {
  const requesterClientId = requesterSocketId ? userClientIds.get(requesterSocketId) : undefined;
  const requesterName = requesterSocketId ? userNames.get(requesterSocketId) : undefined;
  const ownsPack = !!requesterClientId && (
    pack.uploaderId ? pack.uploaderId === requesterClientId : pack.uploader === requesterName
  );
  const canDelete = ownsPack || isRoomOwner(roomId, requesterSocketId);
  return {
    id: pack.id,
    name: pack.name,
    filename: pack.filename,
    uploader: pack.uploader,
    createdAt: pack.createdAt,
    sortOrder: pack.sortOrder,
    canDelete,
  };
}

function broadcastSoundpackAdded(pack: SoundpackRecord) {
  for (const targetSocket of io.sockets.sockets.values()) {
    targetSocket.emit('soundpack:added', toPublicSoundpack(
      pack,
      targetSocket.id,
      peers.get(targetSocket.id)?.roomId ?? undefined,
    ));
  }
}

// ── 语音包静态文件（必须在 catch-all 之前）────────────────────────────────────
app.use('/sounds', express.static(SOUNDS_DIR));
app.use('/chat-images', express.static(CHAT_IMAGES_DIR, {
  fallthrough: false,
  maxAge: '7d',
  immutable: true,
}));

// ── Static frontend ───────────────────────────────────────────────────────────

const distPath = path.join(__dirname, '../../client/dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// ── REST API ──────────────────────────────────────────────────────────────────

// ── 语音包 REST ───────────────────────────────────────────────────────────────

app.get('/api/soundpacks', (req, res) => {
  const requesterSocketId = typeof req.query.socketId === 'string' ? req.query.socketId : undefined;
  const roomId = typeof req.query.roomId === 'string' ? req.query.roomId : undefined;
  const packs = stmtGetSoundpacks.all() as SoundpackRecord[];
  res.json(packs.map(pack => toPublicSoundpack(pack, requesterSocketId, roomId)));
});

app.post('/api/soundpacks', (req, res) => {
  const { name, data, mimeType, socketId, roomId } = req.body as {
    name?: string; data?: string; mimeType?: string; socketId?: string; roomId?: string;
  };
  if (!name?.trim() || !data || !mimeType) {
    res.status(400).json({ error: 'name, data, mimeType 均为必填' }); return;
  }
  if (!mimeType.startsWith('audio/')) {
    res.status(400).json({ error: '只允许上传音频文件' }); return;
  }
  const uploaderId = socketId ? userClientIds.get(socketId) : undefined;
  const uploader = socketId ? userNames.get(socketId) : undefined;
  if (!socketId || !uploaderId || !uploader) {
    res.status(401).json({ error: '请先连接并注册用户' }); return;
  }
  // base64 → Buffer，限制 8MB
  const buf = Buffer.from(data, 'base64');
  if (buf.length > 8 * 1024 * 1024) {
    res.status(400).json({ error: '文件过大，最大支持 8MB' }); return;
  }
  const ext = mimeType.split('/')[1]?.replace('mpeg', 'mp3') ?? 'audio';
  const id  = Math.random().toString(36).slice(2, 9);
  const filename = `${id}.${ext}`;
  try {
    fs.writeFileSync(path.join(SOUNDS_DIR, filename), buf);
  } catch {
    res.status(500).json({ error: '文件保存失败' }); return;
  }
  const nextOrder = (stmtGetNextSoundpackOrder.get() as { sortOrder: number }).sortOrder;
  const sp: SoundpackRecord = { id, name: name.trim(), filename, uploader, uploaderId, createdAt: Date.now(), sortOrder: nextOrder };
  stmtInsertSoundpack.run(sp.id, sp.name, sp.filename, sp.uploader, sp.uploaderId, sp.createdAt, sp.sortOrder);
  broadcastSoundpackAdded(sp);
  res.json(toPublicSoundpack(sp, socketId, roomId));
});

// ── 房间 REST ─────────────────────────────────────────────────────────────────

app.get('/api/rooms', (_req, res) => { res.json(stmtGetRooms.all()); });

app.post('/api/rooms', (req, res) => {
  const { name, socketId } = req.body as { name?: string; socketId?: string };
  if (!name?.trim()) { res.status(400).json({ error: 'Name required' }); return; }
  const ownerId = socketId ? userClientIds.get(socketId) : undefined;
  const ownerName = socketId ? userNames.get(socketId) : undefined;
  if (!ownerId || !ownerName) {
    res.status(401).json({ error: '请先连接并注册用户' }); return;
  }
  const id = Math.random().toString(36).slice(2, 9);
  const room: Room = { id, name: name.trim(), createdAt: Date.now(), ownerName };
  stmtInsertRoom.run(room.id, room.name, room.createdAt, ownerId, ownerName);
  io.emit('rooms:updated', stmtGetRooms.all());
  res.json(room);
});

app.get('/api/rooms/:id', (req, res) => {
  const room = stmtGetRoom.get(req.params.id) as Room | undefined;
  if (!room) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(room);
});

app.get('/api/rooms/:id/messages', (req, res) => {
  res.json(stmtGetMessages.all(req.params.id));
});

const CHAT_IMAGE_TYPES = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);

function validChatImage(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === 'image/webp') return buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
  if (mimeType === 'image/gif') return ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString());
  return false;
}

app.post('/api/rooms/:id/images', (req, res) => {
  const roomId = req.params.id;
  const { data, mimeType, socketId } = req.body as { data?: string; mimeType?: string; socketId?: string };
  const extension = mimeType ? CHAT_IMAGE_TYPES.get(mimeType) : undefined;
  if (!data || !mimeType || !extension) {
    res.status(400).json({ error: '仅支持 PNG、JPEG、WebP 或 GIF 图片' }); return;
  }
  if (!socketId || !userClientIds.has(socketId) || !roomMembers.get(roomId)?.has(socketId)) {
    res.status(403).json({ error: '请先进入该房间' }); return;
  }
  const buffer = Buffer.from(data, 'base64');
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) {
    res.status(400).json({ error: '图片大小必须在 5MB 以内' }); return;
  }
  if (!validChatImage(buffer, mimeType)) {
    res.status(400).json({ error: '图片内容与文件类型不匹配' }); return;
  }

  const filename = `${randomUUID()}.${extension}`;
  const roomDirectory = path.join(CHAT_IMAGES_DIR, roomId);
  try {
    fs.mkdirSync(roomDirectory, { recursive: true });
    fs.writeFileSync(path.join(roomDirectory, filename), buffer, { flag: 'wx' });
  } catch {
    res.status(500).json({ error: '图片保存失败' }); return;
  }

  const msg: Message = {
    id: Math.random().toString(36).slice(2, 9),
    roomId,
    author: userNames.get(socketId) ?? 'Unknown',
    content: `/chat-images/${roomId}/${filename}`,
    type: 'image',
    timestamp: Date.now(),
  };
  try {
    stmtInsertMsg.run(msg.id, msg.roomId, msg.author, msg.content, msg.type, msg.timestamp);
    io.to(roomId).emit('message:new', msg);
    res.json(msg);
  } catch {
    fs.rmSync(path.join(roomDirectory, filename), { force: true });
    res.status(500).json({ error: '图片消息保存失败' });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

type OnDemandMediaType = 'screen' | 'screen-audio';

function onDemandMediaType(value: unknown): OnDemandMediaType | null {
  return value === 'screen' || value === 'screen-audio' ? value : null;
}

function findProducerOwner(producerId: string) {
  for (const [socketId, peer] of peers) {
    const producer = peer.producers.get(producerId);
    if (producer) return { socketId, peer, producer };
  }
  return null;
}

/**
 * 屏幕流只在至少有一个真实 Consumer 时传输。服务端 Producer.pause() 负责
 * 停止向观看者转发，同时通知发送端暂停本地 Producer，避免远程分享者仍把
 * 无人观看的 RTP 经 FRP 发到服务器。
 */
function syncOnDemandProducer(producerId: string) {
  const owner = findProducerOwner(producerId);
  if (!owner) return;
  const sourceType = onDemandMediaType((owner.producer.appData as Record<string, unknown>).type);
  if (!sourceType) return;

  let viewerCount = 0;
  for (const peer of peers.values()) {
    for (const consumer of peer.consumers.values()) {
      if (!consumer.closed && consumer.producerId === producerId) viewerCount += 1;
    }
  }
  const forceMuted = sourceType === 'screen-audio' && !!owner.peer.roomId &&
    isSocketMuted(owner.peer.roomId, owner.socketId);
  const active = viewerCount > 0 && !forceMuted;
  if (active) owner.producer.resume().catch(() => {});
  else owner.producer.pause().catch(() => {});

  io.to(owner.socketId).emit('screen:demand', {
    producerId,
    sourceType,
    active,
    viewerCount,
  });
  if (sourceType === 'screen' && owner.peer.roomId) {
    io.to(owner.peer.roomId).emit('screen:viewers', {
      peerId: owner.socketId,
      viewerCount,
    });
  }
}

function closePeerConsumer(socketId: string, consumerId: string) {
  const peer = peers.get(socketId);
  const consumer = peer?.consumers.get(consumerId);
  if (!peer || !consumer) return;
  const producerId = consumer.producerId;
  consumer.close();
  peer.consumers.delete(consumerId);
  syncOnDemandProducer(producerId);
}

function currentVoiceList(roomId: string) {
  const members = voiceRooms.get(roomId) ?? new Set<string>();
  return [...members].map(id => ({
    socketId: id,
    userId: publicUserId(id),
    username: userNames.get(id) ?? id,
    avatarUrl: userAvatars.get(id) ?? null,
    isMuted: isSocketMuted(roomId, id) || selfMutedVoiceMembers.has(id),
  }));
}

function broadcastVoiceList(roomId: string) {
  io.to(roomId).emit('voice:members-updated', currentVoiceList(roomId));
}

function voiceCounts() {
  return Object.fromEntries([...voiceRooms].map(([roomId, members]) => [roomId, members.size]));
}

function broadcastVoiceCounts() {
  io.emit('voice:counts', voiceCounts());
}

function announceVoicePresence(
  roomId: string,
  socketId: string,
  username: string,
  action: VoicePresenceAction,
  audience: Iterable<string>,
) {
  const event = createVoicePresenceEvent(action, socketId, username);
  for (const audienceSocketId of audience) io.to(audienceSocketId).emit('voice:presence', event);

  const msg: Message = {
    id: Math.random().toString(36).slice(2, 9),
    roomId,
    author: 'Cove',
    content: voicePresenceMessage(username, action),
    type: 'system',
    timestamp: event.timestamp,
  };
  stmtInsertMsg.run(msg.id, msg.roomId, msg.author, msg.content, msg.type, msg.timestamp);
  io.to(roomId).emit('message:new', msg);
}

function handleVoiceLeave(socketId: string, roomId: string) {
  const members = voiceRooms.get(roomId);
  if (!members?.has(socketId)) return;
  members.delete(socketId);
  selfMutedVoiceMembers.delete(socketId);
  const username = userNames.get(socketId) ?? socketId;
  // 客户端异常退出、快速离开再加入时，也必须由服务端关闭旧 Producer。
  // 否则旧麦克风仍会被其他成员消费，形成双声和“静音后仍有一路”。
  const peer = peers.get(socketId);
  if (peer?.roomId === roomId) {
    // 先关闭该成员正在观看的流，及时把分享者的观众数减掉。
    for (const consumerId of [...peer.consumers.keys()])
      closePeerConsumer(socketId, consumerId);
    for (const [producerId, producer] of peer.producers) {
      producer.close();
      peer.producers.delete(producerId);
    }
  }
  [...members].forEach(mid => io.to(mid).emit('voice:user-left', { socketId }));
  announceVoicePresence(roomId, socketId, username, 'leave', members);
  broadcastVoiceList(roomId);
  broadcastVoiceCounts();
}

function broadcastRoomMembers(roomId: string) {
  const members = roomMembers.get(roomId) ?? new Set();
  const room = stmtGetRoomPrivate.get(roomId) as PrivateRoom | undefined;
  if (!room) return;
  const list: RoomMember[] = [...members].map(id => {
    const clientId = userClientIds.get(id);
    return {
      socketId: id,
      userId: publicUserId(id),
      username: userNames.get(id) ?? id,
      avatarUrl: userAvatars.get(id) ?? null,
      isOwner: !!clientId && clientId === room.ownerId,
      isMuted: !!clientId && isClientMuted(roomId, clientId),
    };
  });

  // room:state 对每个连接单独发送，isOwner 由服务端计算，不能由客户端声明。
  for (const socketId of members) {
    const clientId = userClientIds.get(socketId);
    io.to(socketId).emit('room:state', {
      roomId,
      ownerName: room.ownerName,
      isOwner: !!clientId && clientId === room.ownerId,
      members: list,
    });
  }
  // 保留旧事件兼容旧客户端；全局列表只用于大厅显示人数。
  const names = list.map(member => member.username);
  io.to(roomId).emit('room:members', names);
  io.emit('room:members:global', { roomId, members: names });
}

function announceRoomPresence(roomId: string, username: string, action: 'join' | 'leave') {
  const msg: Message = {
    id: Math.random().toString(36).slice(2, 9),
    roomId,
    author: 'Cove',
    content: `[${username}] ${action === 'join' ? '加入' : '离开'}了房间`,
    type: 'system',
    timestamp: Date.now(),
  };
  stmtInsertMsg.run(msg.id, msg.roomId, msg.author, msg.content, msg.type, msg.timestamp);
  io.to(roomId).emit('message:new', msg);
  io.to(roomId).emit('room:presence', { roomId, username, action });
}

function isClientMuted(roomId: string, clientId: string): boolean {
  return !!stmtIsRoomMuted.get(roomId, clientId);
}

function isSocketMuted(roomId: string, socketId: string): boolean {
  const clientId = userClientIds.get(socketId);
  return !!clientId && isClientMuted(roomId, clientId);
}

function emitForcedMuteState(socketId: string, roomId: string) {
  io.to(socketId).emit('room:force-muted', {
    roomId,
    muted: isSocketMuted(roomId, socketId),
  });
}

function pausePeerAudio(socketId: string, paused: boolean) {
  const peer = peers.get(socketId);
  if (!peer) return;
  for (const [producerId, producer] of peer.producers) {
    if (producer.kind !== 'audio') continue;
    if (paused) producer.pause().catch(() => {});
    else if ((producer.appData as Record<string, unknown>).type === 'screen-audio')
      syncOnDemandProducer(producerId);
    else if (selfMutedVoiceMembers.has(socketId)) producer.pause().catch(() => {});
    else producer.resume().catch(() => {});
  }
}

function pausePeerMicrophone(socketId: string, paused: boolean) {
  const peer = peers.get(socketId);
  if (!peer) return;
  for (const producer of peer.producers.values()) {
    if (producer.kind !== 'audio') continue;
    const sourceType = (producer.appData as Record<string, unknown>).type;
    if (sourceType === 'screen-audio') continue;
    if (paused) producer.pause().catch(() => {});
    else producer.resume().catch(() => {});
  }
}

// ── Socket.io ─────────────────────────────────────────────────────────────────

io.on('connection', socket => {
  console.log(`[+] ${socket.id}`);
  createPeer(socket.id);

  function broadcastOnlineUsers() {
    io.emit('users:online', createLobbyPresenceSnapshot(
      userNames, userAvatars, roomMembers, voiceRooms,
    ).onlineUsers);
  }

  const sanitizeAvatarUrl = (value: unknown): string | null => {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || value.length > 240 * 1024) return null;
    return /^data:image\/(?:png|jpeg|webp);base64,/i.test(value) ? value : null;
  };

  const refreshProfileViews = () => {
    broadcastOnlineUsers();
    for (const [roomId, members] of roomMembers) {
      if (!members.has(socket.id)) continue;
      broadcastRoomMembers(roomId);
      broadcastVoiceList(roomId);
    }
  };

  socket.on('user:register', (
    registration: string | { username?: string; clientId?: string; avatarUrl?: unknown },
    cb?: (result: { ok: boolean; error?: string }) => void,
  ) => {
    const username = (typeof registration === 'string' ? registration : registration?.username)?.trim();
    const suppliedClientId = typeof registration === 'string' ? '' : registration?.clientId?.trim();
    if (!username) { cb?.({ ok: false, error: '用户名不能为空' }); return; }

    // 旧客户端没有 clientId 时仍可聊天，但它的身份只在本次连接内有效。
    const clientId = suppliedClientId && suppliedClientId.length >= 16 && suppliedClientId.length <= 128
      ? suppliedClientId
      : `socket:${socket.id}`;
    userNames.set(socket.id, username.slice(0, 64));
    userAvatars.set(socket.id, sanitizeAvatarUrl(typeof registration === 'string' ? null : registration.avatarUrl));
    userClientIds.set(socket.id, clientId);

    // 同一设备更改用户名后，同步更新它所拥有房间的公开房主名。
    const updated = stmtUpdateOwnerName.run(username.slice(0, 64), clientId, username.slice(0, 64));
    if (updated.changes > 0) io.emit('rooms:updated', stmtGetRooms.all());
    refreshProfileViews();
    socket.emit('voice:counts', voiceCounts());
    cb?.({ ok: true });
  });

  socket.on('user:update-profile', (
    update: { username?: string; avatarUrl?: unknown },
    cb?: (result: { ok: boolean; error?: string }) => void,
  ) => {
    const username = update?.username?.trim().slice(0, 64);
    const clientId = userClientIds.get(socket.id);
    if (!username || !clientId) { cb?.({ ok: false, error: '用户尚未注册' }); return; }
    userNames.set(socket.id, username);
    userAvatars.set(socket.id, sanitizeAvatarUrl(update.avatarUrl));
    const updated = stmtUpdateOwnerName.run(username, clientId, username);
    if (updated.changes > 0) io.emit('rooms:updated', stmtGetRooms.all());
    refreshProfileViews();
    cb?.({ ok: true });
  });

  socket.on('presence:get', (
    cb?: (result: ReturnType<typeof createLobbyPresenceSnapshot> & { ok: true }) => void,
  ) => {
    if (!userNames.has(socket.id)) return;
    cb?.({
      ok: true,
      ...createLobbyPresenceSnapshot(userNames, userAvatars, roomMembers, voiceRooms),
    });
  });

  socket.on('room:create', (
    { name }: { name?: string },
    cb?: (result: { room?: Room; error?: string }) => void,
  ) => {
    const ownerId = userClientIds.get(socket.id);
    const ownerName = userNames.get(socket.id);
    if (!name?.trim()) { cb?.({ error: '请输入房间名称' }); return; }
    if (!ownerId || !ownerName) { cb?.({ error: '用户尚未注册，请重新连接' }); return; }

    const room: Room = {
      id: Math.random().toString(36).slice(2, 9),
      name: name.trim().slice(0, 80),
      createdAt: Date.now(),
      ownerName,
    };
    stmtInsertRoom.run(room.id, room.name, room.createdAt, ownerId, ownerName);
    io.emit('rooms:updated', stmtGetRooms.all());
    cb?.({ room });
  });

  socket.on('room:join', (roomId: string, cb?: (result: { ok: boolean; error?: string }) => void) => {
    let room = stmtGetRoomPrivate.get(roomId) as PrivateRoom | undefined;
    const clientId = userClientIds.get(socket.id);
    const username = userNames.get(socket.id);
    if (!room || !clientId || !username) { cb?.({ ok: false, error: '房间不存在或用户尚未注册' }); return; }

    // 升级前的旧房间没有 ownerId：服务端只允许首次进入者原子认领一次。
    if (!room.ownerId) {
      const claim = stmtClaimRoom.run(clientId, username, roomId);
      if (claim.changes > 0) {
        io.emit('rooms:updated', stmtGetRooms.all());
        room = stmtGetRoomPrivate.get(roomId) as PrivateRoom;
      }
    }
    socket.join(roomId);
    if (!roomMembers.has(roomId)) roomMembers.set(roomId, new Set());
    const members = roomMembers.get(roomId)!;
    const newlyJoined = !members.has(socket.id);
    members.add(socket.id);
    broadcastRoomMembers(roomId);
    // 新进入频道的客户端可能错过之前的语音广播，进入时必须补发当前完整列表。
    broadcastVoiceList(roomId);
    emitForcedMuteState(socket.id, roomId);
    // Track room for mediasoup
    const peer = peers.get(socket.id);
    if (peer) peer.roomId = roomId;
    if (newlyJoined) announceRoomPresence(roomId, username, 'join');
    cb?.({ ok: true });
  });

  socket.on('room:leave', (roomId: string) => {
    handleVoiceLeave(socket.id, roomId);
    const leftRoom = roomMembers.get(roomId)?.delete(socket.id) ?? false;
    socket.leave(roomId);
    if (leftRoom) announceRoomPresence(roomId, userNames.get(socket.id) ?? socket.id, 'leave');
    broadcastRoomMembers(roomId);
    const peer = peers.get(socket.id);
    if (peer) peer.roomId = null;
  });

  // ── 房主操作 ─────────────────────────────────────────────────────────────

  socket.on('room:set-muted', (
    { roomId, targetSocketId, muted }:
      { roomId: string; targetSocketId: string; muted: boolean },
    cb?: (result: { ok: boolean; error?: string }) => void,
  ) => {
    const room = stmtGetRoomPrivate.get(roomId) as PrivateRoom | undefined;
    const actorClientId = userClientIds.get(socket.id);
    const targetClientId = userClientIds.get(targetSocketId);
    const targetName = userNames.get(targetSocketId);
    const members = roomMembers.get(roomId);

    if (!room || !actorClientId || room.ownerId !== actorClientId) {
      cb?.({ ok: false, error: '只有房主可以禁言成员' }); return;
    }
    if (!members?.has(socket.id) || !members.has(targetSocketId) || !targetClientId || !targetName) {
      cb?.({ ok: false, error: '目标成员不在房间中' }); return;
    }
    if (targetClientId === room.ownerId) {
      cb?.({ ok: false, error: '不能禁言房主' }); return;
    }

    if (muted) stmtMuteMember.run(roomId, targetClientId, targetName, Date.now());
    else stmtUnmuteMember.run(roomId, targetClientId);

    // 同一客户端重连或开了多个窗口时，对它在该房间的所有连接同时生效。
    for (const memberSocketId of members) {
      if (userClientIds.get(memberSocketId) !== targetClientId) continue;
      pausePeerAudio(memberSocketId, muted);
      emitForcedMuteState(memberSocketId, roomId);
    }
    broadcastRoomMembers(roomId);
    broadcastVoiceList(roomId);
    cb?.({ ok: true });
  });

  socket.on('room:kick', (
    { roomId, targetSocketId }: { roomId: string; targetSocketId: string },
    cb?: (result: { ok: boolean; error?: string }) => void,
  ) => {
    const room = stmtGetRoomPrivate.get(roomId) as PrivateRoom | undefined;
    const actorClientId = userClientIds.get(socket.id);
    const targetClientId = userClientIds.get(targetSocketId);
    const targetName = userNames.get(targetSocketId);
    const members = roomMembers.get(roomId);

    if (!room || !actorClientId || room.ownerId !== actorClientId) {
      cb?.({ ok: false, error: '只有房主可以移除成员' }); return;
    }
    if (!members?.has(socket.id) || !members.has(targetSocketId) || !targetClientId || !targetName) {
      cb?.({ ok: false, error: '目标成员不在房间中' }); return;
    }
    if (targetClientId === room.ownerId || targetSocketId === socket.id) {
      cb?.({ ok: false, error: '不能移除房主' }); return;
    }

    handleVoiceLeave(targetSocketId, roomId);
    members.delete(targetSocketId);
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    targetSocket?.leave(roomId);
    const peer = peers.get(targetSocketId);
    if (peer?.roomId === roomId) peer.roomId = null;
    io.to(targetSocketId).emit('room:kicked', { roomId, by: userNames.get(socket.id) ?? '房主' });
    announceRoomPresence(roomId, targetName, 'leave');
    broadcastRoomMembers(roomId);
    cb?.({ ok: true });
  });

  socket.on('room:delete', (
    { roomId }: { roomId: string },
    cb?: (result: { ok: boolean; error?: string }) => void,
  ) => {
    const room = stmtGetRoomPrivate.get(roomId) as PrivateRoom | undefined;
    const actorClientId = userClientIds.get(socket.id);
    if (!room || !actorClientId || room.ownerId !== actorClientId) {
      cb?.({ ok: false, error: '只有房主可以删除房间' }); return;
    }

    const members = [...(roomMembers.get(roomId) ?? new Set<string>())];
    io.to(roomId).emit('room:deleted', { roomId });
    for (const memberSocketId of members) {
      handleVoiceLeave(memberSocketId, roomId);
      const peer = peers.get(memberSocketId);
      if (peer?.roomId === roomId) peer.roomId = null;
      io.sockets.sockets.get(memberSocketId)?.leave(roomId);
    }
    roomMembers.delete(roomId);
    voiceRooms.delete(roomId);
    broadcastVoiceCounts();
    deleteRoomData(roomId);
    fs.rmSync(path.join(CHAT_IMAGES_DIR, roomId), { recursive: true, force: true });
    io.emit('rooms:updated', stmtGetRooms.all());
    io.emit('room:members:global', { roomId, members: [] });
    cb?.({ ok: true });
  });

  // ── Messages ──────────────────────────────────────────────────────────────

  socket.on('message:send', ({ roomId, content }: { roomId: string; content: string }) => {
    if (!content?.trim() || !stmtGetRoom.get(roomId) || !roomMembers.get(roomId)?.has(socket.id)) return;
    const msg: Message = {
      id: Math.random().toString(36).slice(2, 9),
      roomId,
      author: userNames.get(socket.id) ?? 'Unknown',
      content: content.trim(),
      type: 'chat',
      timestamp: Date.now(),
    };
    stmtInsertMsg.run(msg.id, msg.roomId, msg.author, msg.content, msg.type, msg.timestamp);
    io.to(roomId).emit('message:new', msg);
  });

  // ── Voice member tracking (UI only) ───────────────────────────────────────

  socket.on('voice:join', (roomId: string) => {
    if (!stmtGetRoom.get(roomId) || !roomMembers.get(roomId)?.has(socket.id)) return;
    if (!voiceRooms.has(roomId)) voiceRooms.set(roomId, new Set());
    const members = voiceRooms.get(roomId)!;
    if (members.has(socket.id)) {
      socket.emit('voice:members-updated', currentVoiceList(roomId));
      return;
    }
    const existing = [...members];
    selfMutedVoiceMembers.delete(socket.id);

    socket.emit('voice:existing-members', existing.map(id => ({
      socketId: id, userId: publicUserId(id), username: userNames.get(id) ?? id,
      avatarUrl: userAvatars.get(id) ?? null,
    })));

    existing.forEach(mid =>
      io.to(mid).emit('voice:user-joined', {
        socketId: socket.id, username: userNames.get(socket.id) ?? socket.id,
        avatarUrl: userAvatars.get(socket.id) ?? null,
      })
    );

    members.add(socket.id);
    announceVoicePresence(
      roomId,
      socket.id,
      userNames.get(socket.id) ?? socket.id,
      'join',
      members,
    );
    broadcastVoiceList(roomId);
    broadcastVoiceCounts();
  });

  socket.on('voice:leave', (roomId: string) => {
    handleVoiceLeave(socket.id, roomId);
  });

  socket.on('voice:mute-state', (
    { roomId, muted }: { roomId: string; muted: boolean },
  ) => {
    const voiceMembers = voiceRooms.get(roomId);
    if (!voiceMembers?.has(socket.id) || !roomMembers.get(roomId)?.has(socket.id)) return;

    if (muted) selfMutedVoiceMembers.add(socket.id);
    else selfMutedVoiceMembers.delete(socket.id);

    const effectivelyMuted = muted || isSocketMuted(roomId, socket.id);
    pausePeerMicrophone(socket.id, effectivelyMuted);
    broadcastVoiceList(roomId);
  });

  // ── mediasoup 信令 ────────────────────────────────────────────────────────
  // 所有 ms:* 事件都带回调（callback），客户端用 socket.emitWithAck() 接收结果

  /** 1. 客户端请求 router 的编解码能力 */
  // 注意：客户端 emitAsync 不带 data 时，Socket.io 会把 ack 回调放在参数列表里，
  // 位置不固定。必须从 args 中找出函数本身，不能假定它是第一个参数。
  socket.on('ms:capabilities', (...args: unknown[]) => {
    const cb = args.find(a => typeof a === 'function') as ((caps: unknown) => void) | undefined;
    if (!cb) return;
    if (!router) { cb({ error: 'mediasoup 未就绪' }); return; }
    cb(router.rtpCapabilities);
  });

  /** 2. 创建 WebRTC transport（发送 or 接收） */
  socket.on('ms:create-transport', async (
    data: unknown,
    cb: (params: unknown) => void,
  ) => {
    try {
      const transport = await router.createWebRtcTransport({
        webRtcServer,
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        // 让 1080p 动态共享不必从 1.2 Mbps 缓慢爬升。这只是拥塞控制的
        // 初始估计而不是硬限速，后续仍会按接收端反馈自动升降。
        initialAvailableOutgoingBitrate: 4_000_000,
      });

      // 存到 peer（前两次调用对应 send/recv，按顺序）
      const peer = peers.get(socket.id)!;
      // 客户端明确指定方向。兼容旧客户端：未指定时按调用顺序（首次=send）。
      const direction: 'send' | 'recv' =
        (data as { direction?: 'send' | 'recv' })?.direction ??
        (!peer.sendTransport ? 'send' : 'recv');
      const role = direction === 'send' ? 'send发送' : 'recv接收';
      if (direction === 'send') {
        peer.sendTransport?.close(); // 关掉重连前残留的旧通道，避免引用错位
        peer.sendTransport = transport;
      } else {
        peer.recvTransport?.close();
        peer.recvTransport = transport;
      }

      // ── 诊断日志：ICE / DTLS 连接状态 ──────────────────────────────────────
      transport.on('icestatechange', (state) => {
        console.log(`[ms-server] ${role}通道 ICE: ${state}  (${socket.id.slice(0,6)})`);
        if (state === 'disconnected' || state === 'closed')
          console.warn(`[ms-server] [WARN] ${role}通道 ICE ${state} - 客户端连不上服务器（检查 frp 端口/公网IP）`);
      });
      transport.on('dtlsstatechange', (state) => {
        console.log(`[ms-server] ${role}通道 DTLS: ${state}  (${socket.id.slice(0,6)})`);
        if (state === 'connected')
          console.log(`[ms-server] [OK] ${role}通道握手成功，媒体可流通`);
        if (state === 'failed')
          console.error(`[ms-server] [ERROR] ${role}通道 DTLS 握手失败`);
        if (state === 'closed') {
          transport.close();
          // 通道关闭时清空引用，确保重新加入语音时能正确重建收发通道
          if (peer.sendTransport === transport) peer.sendTransport = null;
          if (peer.recvTransport === transport) peer.recvTransport = null;
        }
      });
      // 选中的传输方式：udp = 理想，tcp = frp 没转发 UDP 时的回退
      transport.on('iceselectedtuplechange', (tuple) => {
        console.log(`[ms-server] ${role}通道 选用协议: ${tuple?.protocol?.toUpperCase()} ` +
          `(本地 ${tuple?.localAddress}:${tuple?.localPort} ← 远端 ${tuple?.remoteIp}:${tuple?.remotePort})`);
        if (tuple?.protocol === 'tcp')
          console.warn('[ms-server] [WARN] 走的是 TCP（说明 UDP 没通，frp 可能只转发了 TCP；能用但延迟偏高）');
      });

      cb({
        id:              transport.id,
        iceParameters:   transport.iceParameters,
        iceCandidates:   transport.iceCandidates,
        dtlsParameters:  transport.dtlsParameters,
        sctpParameters:  transport.sctpParameters,
      });
    } catch (e: unknown) {
      cb({ error: String(e) });
    }
  });

  /** 3. 完成 DTLS 握手 */
  socket.on('ms:connect-transport', async (
    { transportId, dtlsParameters }: { transportId: string; dtlsParameters: unknown },
    cb: () => void,
  ) => {
    const peer = peers.get(socket.id)!;
    const transport =
      peer.sendTransport?.id === transportId ? peer.sendTransport :
      peer.recvTransport?.id === transportId ? peer.recvTransport : null;
    if (!transport) return cb();
    try {
      await transport.connect({ dtlsParameters } as never);
    } catch {}
    cb();
  });

  /** 4. 开始发送媒体（produce） */
  socket.on('ms:produce', async (
    { transportId, kind, rtpParameters, appData }:
      { transportId: string; kind: string; rtpParameters: unknown; appData: unknown },
    cb: (res: unknown) => void,
  ) => {
    const peer = peers.get(socket.id)!;
    const transport = peer.sendTransport?.id === transportId ? peer.sendTransport : null;
    if (!transport) return cb({ error: 'transport not found' });

    try {
      const producer = await transport.produce({
        kind: kind as 'audio' | 'video',
        rtpParameters: rtpParameters as never,
        appData: appData as never,
      });

      // 每个连接的同类来源只能保留一条。高延迟网络下重复点击“加入语音”
      // 可能并发发布两条 mic；关闭旧流可从服务端兜底避免双重播放。
      const producerAppData = producer.appData as Record<string, unknown>;
      const sourceType = typeof producerAppData.type === 'string'
        ? producerAppData.type
        : undefined;
      if (sourceType) {
        for (const [existingId, existing] of peer.producers) {
          const existingAppData = existing.appData as Record<string, unknown>;
          if (existingAppData.type !== sourceType) continue;
          existing.close();
          peer.producers.delete(existingId);
        }
      }
      peer.producers.set(producer.id, producer);

      const demandType = onDemandMediaType(sourceType);
      if (demandType) await producer.pause().catch(() => {});

      const producerRoomId = peer.roomId;
      producer.observer.on('close', () => {
        peer.producers.delete(producer.id);
        if (!demandType || !producerRoomId) return;
        io.to(producerRoomId).emit('ms:producer-closed', {
          producerId: producer.id,
          peerId: socket.id,
          sourceType: demandType,
        });
        if (demandType === 'screen') {
          io.to(producerRoomId).emit('screen:viewers', {
            peerId: socket.id,
            viewerCount: 0,
          });
        }
      });

      // 禁言必须由服务端兜底。即使成员篡改前端继续发布音频，SFU 也会暂停该流。
      if (producer.kind === 'audio' && peer.roomId && isSocketMuted(peer.roomId, socket.id)) {
        await producer.pause();
      }

      producer.on('transportclose', () => peer.producers.delete(producer.id));

      // 通知同房间其他人有新 producer
      const roomId = peer.roomId;
      if (roomId) {
        const voiceSet = voiceRooms.get(roomId) ?? new Set();
        for (const mid of voiceSet) {
          if (mid !== socket.id) {
            io.to(mid).emit('ms:new-producer', {
              producerId: producer.id,
              peerId:     socket.id,
              kind:       producer.kind,
              appData:    producer.appData,
            });
          }
        }
      }

      cb({ producerId: producer.id });
      if (demandType) syncOnDemandProducer(producer.id);
    } catch (e: unknown) {
      cb({ error: String(e) });
    }
  });

  /** 5. 获取房间里当前所有人的 producer（新人加入时用） */
  socket.on('ms:get-producers', (...args: unknown[]) => {
    const cb = args.find(a => typeof a === 'function') as ((list: unknown) => void) | undefined;
    if (!cb) return;
    const peer = peers.get(socket.id);
    if (!peer?.roomId) return cb([]);
    cb(getRoomProducers(peer.roomId, socket.id));
  });

  /** 6. 开始接收某个 producer（consume） */
  socket.on('ms:consume', async (
    { producerId, rtpCapabilities }:
      { producerId: string; rtpCapabilities: unknown },
    cb: (res: unknown) => void,
  ) => {
    const peer = peers.get(socket.id)!;
    const transport = peer.recvTransport;
    if (!transport) return cb({ error: 'no recv transport' });

    const owner = findProducerOwner(producerId);
    if (!owner || !peer.roomId || owner.peer.roomId !== peer.roomId)
      return cb({ error: 'producer is not in your room' });

    if (!router.canConsume({ producerId, rtpCapabilities: rtpCapabilities as never }))
      return cb({ error: 'cannot consume' });

    try {
      const consumer = await transport.consume({
        producerId,
        rtpCapabilities: rtpCapabilities as never,
        paused: true, // 客户端设置好之后再 resume
      });

      peer.consumers.set(consumer.id, consumer);

      consumer.on('transportclose', () => {
        peer.consumers.delete(consumer.id);
        syncOnDemandProducer(producerId);
      });
      consumer.on('producerclose',  () => {
        peer.consumers.delete(consumer.id);
        socket.emit('ms:consumer-closed', { consumerId: consumer.id });
      });

      cb({
        id:            consumer.id,
        producerId,
        kind:          consumer.kind,
        rtpParameters: consumer.rtpParameters,
        appData:       consumer.appData,
      });
      syncOnDemandProducer(producerId);
    } catch (e: unknown) {
      cb({ error: String(e) });
    }
  });

  /** 7. 恢复 consumer（consume 后必须调用） */
  socket.on('ms:resume-consumer', async (
    { consumerId }: { consumerId: string },
    cb?: () => void,
  ) => {
    const consumer = peers.get(socket.id)?.consumers.get(consumerId);
    if (consumer) await consumer.resume().catch(() => {});
    cb?.();
  });

  /** 8. 主动停止接收（“停止观看共享”） */
  socket.on('ms:close-consumer', (
    { consumerId }: { consumerId: string },
    cb?: (result: { ok: boolean }) => void,
  ) => {
    closePeerConsumer(socket.id, consumerId);
    cb?.({ ok: true });
  });

  /** 9. 关闭一个 producer（停止屏幕共享等） */
  socket.on('ms:close-producer', ({ producerId }: { producerId: string }) => {
    const peer = peers.get(socket.id)!;
    const producer = peer.producers.get(producerId);
    if (!producer) return;
    producer.close();
    peer.producers.delete(producerId);
    // consumer 的 producerclose 事件会自动触发，通知对方
  });

  // ── 语音包 ────────────────────────────────────────────────────────────────

  socket.on('soundpack:play', (
    { soundId, roomId }: { soundId: string; roomId: string },
    cb?: (result: { ok: boolean; error?: string }) => void,
  ) => {
    const pack = stmtGetSoundpack.get(soundId) as SoundpackRecord | undefined;
    if (!pack) { cb?.({ ok: false, error: '语音包不存在' }); return; }
    const audience = soundpackVoiceAudience(roomMembers.get(roomId), voiceRooms.get(roomId), socket.id);
    if (!audience) { cb?.({ ok: false, error: '请先加入语音再播放语音包' }); return; }
    const playedBy = userNames.get(socket.id) ?? socket.id;
    // 包括发送者在内，只有当前仍在语音中的成员会收到音频播放事件。
    // 发送者也等待此权威事件再播放，避免频道成员通过篡改客户端绕过限制。
    for (const targetSocketId of audience)
      io.to(targetSocketId).emit('soundpack:play', { soundId, playedBy, soundName: pack.name });

    const msg: Message = {
      id: Math.random().toString(36).slice(2, 9),
      roomId,
      author: playedBy,
      content: `${playedBy} 播放了「${pack.name}」`,
      type: 'soundpack',
      timestamp: Date.now(),
    };
    stmtInsertMsg.run(msg.id, msg.roomId, msg.author, msg.content, msg.type, msg.timestamp);
    io.to(roomId).emit('message:new', msg);
    cb?.({ ok: true });
  });

  socket.on('soundpack:delete', (
    { soundId, roomId }: { soundId?: string; roomId?: string },
    cb?: (result: { ok: boolean; error?: string }) => void,
  ) => {
    const pack = soundId ? stmtGetSoundpack.get(soundId) as SoundpackRecord | undefined : undefined;
    const actorClientId = userClientIds.get(socket.id);
    const actorName = userNames.get(socket.id);
    if (!pack) { cb?.({ ok: false, error: '语音包不存在或已被删除' }); return; }
    const ownsPack = !!actorClientId && (
      pack.uploaderId ? pack.uploaderId === actorClientId : pack.uploader === actorName
    );
    if (!ownsPack && !isRoomOwner(roomId, socket.id)) {
      cb?.({ ok: false, error: '只能由上传者或当前房主删除语音包' }); return;
    }

    stmtDeleteSoundpack.run(pack.id);
    const safeFilename = path.basename(pack.filename);
    try {
      const soundPath = path.join(SOUNDS_DIR, safeFilename);
      if (fs.existsSync(soundPath)) fs.unlinkSync(soundPath);
    } catch (error) {
      console.warn(`[soundpack] 删除文件失败 ${safeFilename}:`, error);
    }
    io.emit('soundpack:deleted', { soundId: pack.id });
    cb?.({ ok: true });
  });

  socket.on('soundpack:rename', (
    { soundId, roomId, name }: { soundId?: string; roomId?: string; name?: string },
    cb?: (result: { ok: boolean; error?: string; name?: string }) => void,
  ) => {
    const pack = soundId ? stmtGetSoundpack.get(soundId) as SoundpackRecord | undefined : undefined;
    const nextName = name?.trim().slice(0, 64);
    const actorClientId = userClientIds.get(socket.id);
    const actorName = userNames.get(socket.id);
    if (!pack) { cb?.({ ok: false, error: '语音包不存在或已被删除' }); return; }
    if (!nextName) { cb?.({ ok: false, error: '名称不能为空' }); return; }
    const ownsPack = !!actorClientId && (
      pack.uploaderId ? pack.uploaderId === actorClientId : pack.uploader === actorName
    );
    if (!ownsPack && !isRoomOwner(roomId, socket.id)) {
      cb?.({ ok: false, error: '只能由上传者或当前房主修改名称' }); return;
    }

    stmtRenameSoundpack.run(nextName, pack.id);
    io.emit('soundpack:renamed', { soundId: pack.id, name: nextName });
    cb?.({ ok: true, name: nextName });
  });

  socket.on('soundpack:reorder', (
    { orderedIds, roomId }: { orderedIds?: string[]; roomId?: string },
    cb?: (result: { ok: boolean; error?: string }) => void,
  ) => {
    if (!roomId || !roomMembers.get(roomId)?.has(socket.id)) {
      cb?.({ ok: false, error: '请先进入房间' }); return;
    }
    if (!Array.isArray(orderedIds) || orderedIds.length > 500) {
      cb?.({ ok: false, error: '无效的语音包顺序' }); return;
    }

    const currentIds = (stmtGetSoundpacks.all() as SoundpackRecord[]).map(pack => pack.id);
    const uniqueIds = new Set(orderedIds);
    if (
      orderedIds.length !== currentIds.length
      || uniqueIds.size !== currentIds.length
      || currentIds.some(id => !uniqueIds.has(id))
    ) {
      cb?.({ ok: false, error: '语音包列表已变化，请刷新后重试' }); return;
    }

    reorderSoundpacks(orderedIds);
    io.emit('soundpack:reordered', { orderedIds });
    cb?.({ ok: true });
  });

  // ── Disconnect ────────────────────────────────────────────────────────────

  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id}`);
    voiceRooms.forEach((_, roomId) => handleVoiceLeave(socket.id, roomId));
    const username = userNames.get(socket.id) ?? socket.id;
    roomMembers.forEach((members, roomId) => {
      if (!members.delete(socket.id)) return;
      announceRoomPresence(roomId, username, 'leave');
      broadcastRoomMembers(roomId);
    });
    userNames.delete(socket.id);
    userAvatars.delete(socket.id);
    userClientIds.delete(socket.id);
    broadcastOnlineUsers();
    removePeer(socket.id);
  });
});

// ── 启动 ──────────────────────────────────────────────────────────────────────

export async function startServer(port = 3001): Promise<number> {
  await initMediasoup();
  return new Promise((resolve, reject) => {
    // 显式绑定 0.0.0.0（所有 IPv4 接口），确保 frp 用 127.0.0.1 也能连上。
    // 不指定 host 时 Windows 默认只绑 IPv6(::)，导致 frp 拨 127.0.0.1 被拒绝。
    httpServer.listen(port, '0.0.0.0', () => resolve(port)).on('error', reject);
  });
}

if (require.main === module) {
  startServer().then(port =>
    console.log(`Cove server → http://localhost:${port}  |  WebRTC → ${MS_IP}:${MS_PORT}`)
  );
}
