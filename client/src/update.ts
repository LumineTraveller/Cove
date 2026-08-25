export type UpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error';

export interface UpdateState {
  status: UpdateStatus;
  version?: string;
  percent?: number;
  message?: string;
}

export const UPDATE_CENTER_OPEN_EVENT = 'cove:update:open';

export function openUpdateCenter(): void {
  window.dispatchEvent(new Event(UPDATE_CENTER_OPEN_EVENT));
}
