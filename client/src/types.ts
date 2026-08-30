export type ClientPlatform = 'desktop' | 'mobile';

export interface Room {
  id: string;
  name: string;
  createdAt: number;
  ownerName: string | null;
}

export interface Message {
  id: string;
  roomId: string;
  author: string;
  content: string;
  type?: 'chat' | 'soundpack' | 'image' | 'system';
  timestamp: number;
}

export interface VoiceMember {
  socketId: string;
  userId: string;
  username: string;
  avatarUrl?: string | null;
  isMuted?: boolean;
}

export interface RoomMember {
  socketId: string;
  userId: string;
  username: string;
  avatarUrl?: string | null;
  isOwner: boolean;
  isMuted: boolean;
  /** 当前成员是否正在发布屏幕或应用音频；旧服务端未提供时保持 undefined。 */
  isSharingScreen?: boolean;
  isSharingApplicationAudio?: boolean;
  /** 仅用于界面展示；旧客户端未上报时为空。 */
  platform?: ClientPlatform | null;
}

export interface UserProfile {
  username: string;
  avatarUrl: string | null;
}

export interface OnlineUser extends UserProfile {
  socketId: string;
  platform?: ClientPlatform | null;
}

export interface RoomState {
  roomId: string;
  ownerName: string | null;
  isOwner: boolean;
  members: RoomMember[];
}
