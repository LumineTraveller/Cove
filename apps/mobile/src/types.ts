export type {
  ClientPlatform,
  Room,
  Message,
  VoiceMember,
  RoomMember,
  UserProfile,
  OnlineUser,
  RoomState,
  Soundpack,
} from '@cove/contracts';

export interface SessionConfig {
  username: string;
  serverURL: string;
  clientId: string;
  /** Stable DNS/IP identity for remembered-server deduplication only. */
  serverKey?: string;
  accountToken: string;
  accountId: string;
  email: string;
  allowInvalidServerCertificate?: boolean;
}
