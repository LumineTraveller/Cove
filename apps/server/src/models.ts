import type {
  ClientPlatform,
  Room as WireRoom,
  Message as WireMessage,
  RoomMember as WireRoomMember,
  Soundpack,
} from '@cove/contracts';
export type { MessageHistoryCursor } from '@cove/contracts';

export interface Room extends WireRoom {
  avatarUrl: string | null;
  backgroundTop: string | null;
  backgroundBottom: string | null;
  backgroundTopDark: string | null;
  backgroundBottomDark: string | null;
}

export interface StoredRoom extends Omit<Room, 'ownerUserId'> {
  ownerId: string | null;
}

export interface PrivateRoom extends Omit<Room, 'hasPassword'> {
  ownerId: string | null;
  passwordHash: string | null;
  passwordSalt: string | null;
}

export interface Message extends WireMessage {
  type: NonNullable<WireMessage['type']>;
}

export interface StoredMessage
  extends Omit<Message, 'authorUserId' | 'contentUserId' | 'contentUsername'> {
  authorId: string | null;
}

export interface SoundpackRecord {
  id: string;
  name: string;
  filename: string;
  originalFilename: string | null;
  normalizationVersion: number;
  uploader: string;
  uploaderId: string | null;
  createdAt: number;
  sortOrder: number;
}

export interface PublicSoundpack extends Soundpack {
  originalFilename: string;
  uploaderUserId: string | null;
}

export interface RoomMember extends WireRoomMember {
  socketId: string;
  userId: string;
  username: string;
  avatarUrl: string | null;
  isOwner: boolean;
  isMuted: boolean;
  isSharingScreen: boolean;
  isSharingApplicationAudio: boolean;
  platform: ClientPlatform | null;
  canReceiveRemoteControl: boolean;
}

export type OnDemandMediaType = 'screen' | 'screen-audio';
