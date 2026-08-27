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

export interface SessionConfig {
  username: string;
  serverURL: string;
  clientId: string;
  allowInvalidServerCertificate?: boolean;
}
