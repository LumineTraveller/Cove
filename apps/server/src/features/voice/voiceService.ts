import { Server } from 'socket.io';

import { peers } from '../media/ms';
import { invalidateMediaSession } from '../media/mediaLifecycle';

import {
  createVoicePresenceEvent,
  voicePresenceMessage,
  type VoicePresenceAction,
} from './voicePresence';

import { Message } from '../../models';

export interface CreateVoiceServiceDependencies {
  readonly voiceRooms: Map<string, Set<string>>;
  readonly publicUserId: (socketId: string) => string;
  readonly userNames: Map<string, string>;
  readonly userAvatars: Map<string, string | null>;
  readonly isSocketMuted: (roomId: string, socketId: string) => boolean;
  readonly selfMutedVoiceMembers: Set<string>;
  readonly emitAvatarPayload: (event: string, payload: unknown, roomId?: string) => void;
  readonly io: Server<
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    import('socket.io/dist/typed-events').DefaultEventsMap,
    any
  >;
  readonly stopRemoteControlForSocket: (socketId: string, reason: string) => void;
  readonly removeAnnotationMember: (socketId: string, roomId: string) => void;
  readonly closePeerConsumer: (socketId: string, consumerId: string) => void;
  readonly broadcastRoomMembers: (roomId: string) => void;
}

export function createVoiceService(deps: CreateVoiceServiceDependencies) {
  function currentVoiceList(roomId: string) {
    const members = deps.voiceRooms.get(roomId) ?? new Set<string>();
    return [...members].map((id) => ({
      socketId: id,
      userId: deps.publicUserId(id),
      username: deps.userNames.get(id) ?? id,
      avatarUrl: deps.userAvatars.get(id) ?? null,
      isMuted: deps.isSocketMuted(roomId, id) || deps.selfMutedVoiceMembers.has(id),
    }));
  }

  function broadcastVoiceList(roomId: string) {
    deps.emitAvatarPayload('voice:members-updated', currentVoiceList(roomId), roomId);
  }

  function voiceCounts() {
    return Object.fromEntries(
      [...deps.voiceRooms].map(([roomId, members]) => [roomId, members.size]),
    );
  }

  function broadcastVoiceCounts() {
    deps.io.emit('voice:counts', voiceCounts());
  }

  function announceVoicePresence(
    roomId: string,
    socketId: string,
    username: string,
    action: VoicePresenceAction,
    audience: Iterable<string>,
  ) {
    const event = createVoicePresenceEvent(action, socketId, username);
    for (const audienceSocketId of audience)
      deps.io.to(audienceSocketId).emit('voice:presence', event);

    const msg: Message = {
      id: Math.random().toString(36).slice(2, 9),
      roomId,
      author: 'Cove',
      contentUserId: deps.publicUserId(socketId),
      contentUsername: username,
      content: voicePresenceMessage(username, action),
      type: 'system',
      timestamp: event.timestamp,
    };
    // presence 播报只在当前频道会话中实时广播，不写入聊天历史。
    deps.io.to(roomId).emit('message:new', msg);
  }

  function handleVoiceLeave(socketId: string, roomId: string) {
    // 远程控制依附于语音会话：控制者或被控者任一方退出语音，会话立即终止。
    // 否则控制者挂断后，被控方会一直显示"正在被控制"。clearSocket 幂等，
    // 与 disconnect/room:leave 等路径的重复调用不会产生重复通知。
    deps.stopRemoteControlForSocket(socketId, '成员已退出语音');
    deps.removeAnnotationMember(socketId, roomId);
    const members = deps.voiceRooms.get(roomId);
    const wasInVoice = members?.delete(socketId);
    deps.selfMutedVoiceMembers.delete(socketId);
    const username = deps.userNames.get(socketId) ?? socketId;
    // 客户端异常退出、快速离开再加入时，也必须由服务端关闭旧 Producer。
    // 否则旧麦克风仍会被其他成员消费，形成双声和“静音后仍有一路”。
    const peer = peers.get(socketId);
    if (peer?.roomId === roomId) {
      invalidateMediaSession(peer);
      // 先关闭该成员正在观看的流，及时把分享者的观众数减掉。
      for (const consumerId of [...peer.consumers.keys()])
        deps.closePeerConsumer(socketId, consumerId);
      for (const [producerId, producer] of peer.producers) {
        producer.close();
        peer.producers.delete(producerId);
      }
      peer.screenSendTransport?.close();
      peer.screenSendTransport = null;
    }
    if (!wasInVoice || !members) return;
    [...members].forEach((mid) => deps.io.to(mid).emit('voice:user-left', { socketId }));
    announceVoicePresence(roomId, socketId, username, 'leave', members);
    // 共享状态属于频道成员状态，即使成员不在语音中也要及时清除头像下的提示。
    deps.broadcastRoomMembers(roomId);
    broadcastVoiceList(roomId);
    broadcastVoiceCounts();
  }
  return {
    currentVoiceList,
    broadcastVoiceList,
    voiceCounts,
    broadcastVoiceCounts,
    announceVoicePresence,
    handleVoiceLeave,
  };
}
