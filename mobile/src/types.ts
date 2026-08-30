export type ClientPlatform = 'desktop' | 'mobile';

export interface Room {
  id: string;
  name: string;
  createdAt: number;
  ownerName: string | null;
}

export interface RoomMember {
  socketId: string;
  userId: string;
  username: string;
  avatarUrl?: string | null;
  isOwner: boolean;
  isMuted: boolean;
  platform?: ClientPlatform | null;
}

export interface RoomState {
  roomId: string;
  ownerName: string | null;
  isOwner: boolean;
  members: RoomMember[];
}

export interface VoiceMember {
  socketId: string;
  userId: string;
  username: string;
  avatarUrl?: string | null;
  isMuted?: boolean;
}

export interface Soundpack {
  id: string;
  name: string;
  filename: string;
  uploader: string;
  createdAt: number;
  sortOrder: number;
  canDelete: boolean;
}

export interface Message {
  id: string;
  roomId: string;
  author: string;
  content: string;
  type?: 'chat' | 'soundpack' | 'image' | 'system';
  timestamp: number;
}

export interface SessionConfig {
  username: string;
  serverURL: string;
  clientId: string;
  accountToken: string;
  accountId: string;
  email: string;
  allowInvalidServerCertificate?: boolean;
}
