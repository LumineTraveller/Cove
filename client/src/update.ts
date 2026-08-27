export {
  UPDATE_STEPS, formatTransferPercent, isUpdateBusy, updateStepIndex, updateWaitWarning,
} from '../electron/update-state';
export type { UpdateState, UpdateStatus } from '../electron/update-state';

export const UPDATE_CENTER_OPEN_EVENT = 'cove:update:open';

export function openUpdateCenter(): void {
  window.dispatchEvent(new Event(UPDATE_CENTER_OPEN_EVENT));
}
