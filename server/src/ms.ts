/**
 * mediasoup SFU 核心
 *
 * 媒体流路径：
 *   客户端 A ──WebRTC──▶ 本服务器 (SFU) ──WebRTC──▶ 客户端 B
 *
 * 不需要 STUN/TURN，客户端只需要能连到本服务器即可。
 *
 * 环境变量（在 server/.env 里设置）：
 *   MEDIASOUP_IP   = 服务器对外的公网 IP（本地开发填 127.0.0.1，
 *                    SakuraFrp 远程访问填 frp 的公网 IP）
 *   MEDIASOUP_PORT = WebRTC 媒体端口（默认 40000，需在 frp 里额外转发这个端口）
 */

import * as mediasoup from 'mediasoup';
import type { types as T } from 'mediasoup';

export const MS_IP   = process.env.MEDIASOUP_IP   ?? '127.0.0.1';
// mediasoup 监听端口。注意：mediasoup 的"对外公布端口"恒等于此监听端口
// （本版本 TransportListenInfo 无 announcedPort），所以 frp 隧道的公网端口
// 必须与此端口设为同一数字。
export const MS_PORT = parseInt(process.env.MEDIASOUP_PORT ?? '40000');

// ── 全局 mediasoup 实例 ────────────────────────────────────────────────────────
export let router:      T.Router;
export let webRtcServer: T.WebRtcServer;

// RtpCodecCapability 在 mediasoup v3 里 preferredPayloadType 是可选的，
// 但 TS 类型声明为 required——用 as 绕过类型检查即可，运行时无影响。
const CODECS = [
  { kind: 'audio', mimeType: 'audio/opus',  clockRate: 48000, channels: 2 },
  {
    // 新版 Chromium 支持时优先使用 AV1。mediasoup 只负责转发 RTP，不做转码；
    // 不支持 AV1 的客户端不会把该 codec 放进协商后的发送能力，客户端会回退 VP9。
    kind: 'video', mimeType: 'video/AV1', clockRate: 90000,
    parameters: {},
  },
  {
    // AV1 不可用时使用 VP9；同画质下仍比 VP8 更省码率。
    kind: 'video', mimeType: 'video/VP9', clockRate: 90000,
    parameters: { 'profile-id': 0 },
  },
  {
    kind: 'video', mimeType: 'video/VP8', clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 1000 },
  },
  {
    kind: 'video', mimeType: 'video/H264', clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
    },
  },
] as T.RtpCodecCapability[];

export async function initMediasoup() {
  const worker = await mediasoup.createWorker({
    logLevel: 'warn',
    rtcMinPort: MS_PORT + 1,
    rtcMaxPort: MS_PORT + 200,
  });
  worker.on('died', () => { console.error('[mediasoup] worker 崩溃，退出进程'); process.exit(1); });

  // 单端口监听，TCP+UDP 复用——frp 只需要转发这一个端口。
  // 公布端口 = 监听端口（本版本无 announcedPort），故 frp 公网端口须与之相同。
  webRtcServer = await worker.createWebRtcServer({
    listenInfos: [
      { protocol: 'udp', ip: '0.0.0.0', announcedIp: MS_IP, port: MS_PORT },
      { protocol: 'tcp', ip: '0.0.0.0', announcedIp: MS_IP, port: MS_PORT },
    ],
  });

  router = await worker.createRouter({ mediaCodecs: CODECS });
  console.log(`[mediasoup] 就绪  port=${MS_PORT}  announcedIp=${MS_IP}`);
}

// ── 每个 socket 连接的状态 ─────────────────────────────────────────────────────
export interface PeerInfo {
  roomId:        string | null;
  sendTransport: T.WebRtcTransport | null;
  recvTransport: T.WebRtcTransport | null;
  producers:     Map<string, T.Producer>;  // producerId → Producer
  consumers:     Map<string, T.Consumer>;  // consumerId → Consumer
}

export const peers = new Map<string, PeerInfo>();

export function createPeer(socketId: string): PeerInfo {
  const p: PeerInfo = {
    roomId: null, sendTransport: null, recvTransport: null,
    producers: new Map(), consumers: new Map(),
  };
  peers.set(socketId, p);
  return p;
}

export function removePeer(socketId: string) {
  const p = peers.get(socketId);
  if (!p) return;
  p.sendTransport?.close();
  p.recvTransport?.close();
  peers.delete(socketId);
}

/** 返回同房间内其他人的所有活跃 producer */
export function getRoomProducers(roomId: string, excludeId: string) {
  const list: { producerId: string; peerId: string; kind: string; appData: T.AppData }[] = [];
  for (const [id, peer] of peers) {
    if (id === excludeId || peer.roomId !== roomId) continue;
    for (const [producerId, producer] of peer.producers) {
      if (!producer.closed)
        list.push({ producerId, peerId: id, kind: producer.kind, appData: producer.appData });
    }
  }
  return list;
}
