/** Public wire models. Optional fields remain optional for legacy peers. */
export {COVE_RELEASE_VERSION, MINIMUM_CLIENT_VERSION, compareSemanticVersions, isSupportedClientVersion} from './versionPolicy';
export type ClientPlatform = 'desktop' | 'mobile';
export type MediaSourceType = 'mic' | 'screen' | 'screen-audio' | 'application-audio';

export interface RoomAppearance {
  avatarUrl?: string | null;
  backgroundTop?: string | null;
  backgroundBottom?: string | null;
  backgroundTopDark?: string | null;
  backgroundBottomDark?: string | null;
}
export interface Room extends RoomAppearance {
  id: string;
  name: string;
  createdAt: number;
  ownerName: string | null;
  ownerUserId?: string | null;
  maxMembers: number | null;
  hasPassword: boolean;
  isOwner?: boolean;
}
export interface Message {
  id: string;
  roomId: string;
  author: string;
  authorUserId?: string | null;
  contentUserId?: string;
  contentUsername?: string;
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
export interface RoomMember extends VoiceMember {
  isOwner: boolean;
  isMuted: boolean;
  isSharingScreen?: boolean;
  isSharingApplicationAudio?: boolean;
  platform?: ClientPlatform | null;
  canReceiveRemoteControl?: boolean;
}
export interface UserProfile {
  username: string;
  avatarUrl: string | null;
}
export interface OnlineUser extends UserProfile {
  socketId: string;
  userId?: string;
  platform?: ClientPlatform | null;
}
export interface RoomState extends RoomAppearance {
  roomId: string;
  name?: string;
  ownerName: string | null;
  ownerUserId?: string | null;
  isOwner: boolean;
  members: RoomMember[];
  maxMembers: number | null;
  hasPassword: boolean;
}
export interface Soundpack {
  id: string;
  name: string;
  filename: string;
  originalFilename?: string;
  uploader: string;
  uploaderUserId?: string | null;
  createdAt: number;
  sortOrder: number;
  canDelete: boolean;
}
export interface MessageHistoryCursor {
  timestamp: number;
  id: string;
}
export interface RegistrationResponse {
  ok?: boolean;
  error?: string;
  code?: string;
  profile?: UserProfile;
}
export interface RegistrationRequest {
  username: string;
  avatarUrl: string | null;
  clientId: string;
  authToken: string;
  platform: ClientPlatform;
  remoteControlSupported?: boolean;
}
/** This is the existing server-access marker, not a new mandatory negotiation. */
export const CLIENT_PROTOCOL_VERSION = 2;

export type {
  AnnotationAck,
  AnnotationConfigurePayload,
  AnnotationDrawPayload,
  AnnotationError,
  AnnotationGetTarget,
  AnnotationLaserEvent,
  AnnotationLaserPayload,
  AnnotationPermission,
  AnnotationPoint,
  AnnotationRequest,
  AnnotationRespondPayload,
  AnnotationState,
  AnnotationStroke,
  AnnotationStrokeEvent,
  AnnotationStrokeInput,
  AnnotationTarget,
  AnnotationTool,
} from './annotations';

export interface MediaCapabilities {
  platform: ClientPlatform;
  screenCapture: boolean;
  systemAudioCapture: boolean;
  applicationAudioCapture: boolean;
  remoteControl: boolean;
  videoCodecs: readonly string[];
}
