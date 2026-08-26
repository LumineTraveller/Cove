import { RoomMember } from './types';

/**
 * Keep the local member at the top, then show members currently in voice,
 * while preserving the server-provided order inside each group.
 */
export function sortRoomMembers(
  members: RoomMember[],
  voiceSocketIds: ReadonlySet<string>,
  localSocketId?: string | null,
): RoomMember[] {
  return members
    .map((member, index) => ({ member, index }))
    .sort((left, right) =>
      Number(right.member.socketId === localSocketId) - Number(left.member.socketId === localSocketId)
      || Number(voiceSocketIds.has(right.member.socketId)) - Number(voiceSocketIds.has(left.member.socketId))
      || left.index - right.index)
    .map(({ member }) => member);
}
