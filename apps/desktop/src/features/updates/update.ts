export {
  UPDATE_STEPS,
  formatTransferPercent,
  isUpdateBusy,
  updateHasDetails,
  updateStepIndex,
  updateWaitWarning,
  updateDownloadNotice,
} from '../../../electron/update-state';
export type { UpdateState, UpdateStatus } from '../../../electron/update-state';

export const UPDATE_CENTER_OPEN_EVENT = 'cove:update:open';
export const UPDATE_CENTER_DETAILS_EVENT = 'cove:update:details';
export const UPDATE_SETTINGS_OPEN_EVENT = 'cove:update:settings';

export function openUpdateCenter(): void {
  window.dispatchEvent(new Event(UPDATE_CENTER_OPEN_EVENT));
}

export function openUpdateDetails(): void {
  window.dispatchEvent(new Event(UPDATE_CENTER_DETAILS_EVENT));
}

export function openUpdateSettings(): void {
  window.dispatchEvent(new Event(UPDATE_SETTINGS_OPEN_EVENT));
}
