import { type ClientPlatform } from './presence';

import { RemoteControlRegistry } from '../remote-control/remoteControl';

export interface CreateSessionStateDependencies {}

export function createSessionState(deps: CreateSessionStateDependencies) {
  const userNames = new Map<string, string>();

  const userAvatars = new Map<string, string | null>();

  const userClientIds = new Map<string, string>();

  const accountSockets = new Map<string, string>();

  const userPlatforms = new Map<string, ClientPlatform>();

  const remoteControlCapabilities = new Set<string>();

  const remoteControls = new RemoteControlRegistry();

  const voiceRooms = new Map<string, Set<string>>();

  const roomMembers = new Map<string, Set<string>>();

  const selfMutedVoiceMembers = new Set<string>();
  return {
    userNames,
    userAvatars,
    userClientIds,
    accountSockets,
    userPlatforms,
    remoteControlCapabilities,
    remoteControls,
    voiceRooms,
    roomMembers,
    selfMutedVoiceMembers,
  };
}
