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
  isMuted?: boolean;
}

export interface RoomMember {
  socketId: string;
  username: string;
  isOwner: boolean;
  isMuted: boolean;
}

export interface RoomState {
  roomId: string;
  ownerName: string | null;
  isOwner: boolean;
  members: RoomMember[];
}
