export function soundpackVoiceAudience(
  roomMembers: Set<string> | undefined,
  voiceMembers: Set<string> | undefined,
  senderId: string,
): string[] | null {
  if (!roomMembers?.has(senderId) || !voiceMembers?.has(senderId)) return null;
  return [...voiceMembers].filter(socketId => roomMembers.has(socketId));
}
