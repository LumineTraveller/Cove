import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ProfileRemarks } from './profileDisplayName';

export { getProfileDisplayContent, getProfileDisplayName } from './profileDisplayName';
export type { ProfileRemarks } from './profileDisplayName';

const PROFILE_REMARKS_KEY = 'cove_profile_remarks_v1';

export async function loadProfileRemarks(): Promise<ProfileRemarks> {
  try {
    const parsed = JSON.parse(await AsyncStorage.getItem(PROFILE_REMARKS_KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).flatMap(([userId, remark]) =>
      typeof remark === 'string' && remark.trim()
        ? [[userId, remark.trim().slice(0, 64)]]
        : []));
  } catch {
    return {};
  }
}

export async function saveProfileRemark(remarks: ProfileRemarks, userId: string, value: string): Promise<ProfileRemarks> {
  const next = { ...remarks };
  const remark = value.trim().slice(0, 64);
  if (remark) next[userId] = remark;
  else delete next[userId];
  await AsyncStorage.setItem(PROFILE_REMARKS_KEY, JSON.stringify(next));
  return next;
}
