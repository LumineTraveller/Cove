export type ProfileRemarks = Record<string, string>;

export function getProfileDisplayName(
  username: string,
  userId: string | null | undefined,
  remarks: ProfileRemarks,
): string {
  return (userId && remarks[userId]?.trim()) || username;
}

export function getProfileDisplayContent(
  content: string,
  username: string | undefined,
  userId: string | null | undefined,
  remarks: ProfileRemarks,
): string {
  if (!username || !userId) return content;
  const displayName = getProfileDisplayName(username, userId, remarks);
  return displayName === username ? content : content.replace(username, displayName);
}
