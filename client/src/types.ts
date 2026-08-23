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
  timestamp: number;
}

export interface VoiceMember {
  socketId: string;
  username: string;
  avatarUrl?: string | null;
  isMuted?: boolean;
}

export interface RoomMember {
  socketId: string;
  username: string;
  avatarUrl?: string | null;
  isOwner: boolean;
  isMuted: boolean;
}

export interface UserProfile {
  username: string;
  avatarUrl: string | null;
}

export interface OnlineUser extends UserProfile {
  socketId: string;
}

export interface RoomState {
  roomId: string;
  ownerName: string | null;
  isOwner: boolean;
  members: RoomMember[];
}
