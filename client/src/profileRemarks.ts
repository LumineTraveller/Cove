const PROFILE_REMARKS_KEY = 'cove_profile_remarks_v1';

export type ProfileRemarks = Record<string, string>;

export function loadProfileRemarks(): ProfileRemarks {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROFILE_REMARKS_KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).flatMap(([userId, remark]) =>
      typeof remark === 'string' && remark.trim()
        ? [[userId, remark.trim().slice(0, 64)]]
        : []));
  } catch {
    return {};
  }
}

export function saveProfileRemark(remarks: ProfileRemarks, userId: string, value: string): ProfileRemarks {
  const remark = value.trim().slice(0, 64);
  const next = { ...remarks };
  if (remark) next[userId] = remark;
  else delete next[userId];
  localStorage.setItem(PROFILE_REMARKS_KEY, JSON.stringify(next));
  return next;
}
