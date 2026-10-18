import type { InstallationIntegrityState } from './integrity-state';

interface IntegrityController {
  getState(): InstallationIntegrityState;
  checkNow(): Promise<InstallationIntegrityState>;
  downloadRepair(): Promise<InstallationIntegrityState>;
  cancel(): Promise<InstallationIntegrityState> | InstallationIntegrityState;
  launchRepair(): Promise<boolean>;
}

interface IpcRegistrar<Event> {
  handle(channel: string, listener: (event: Event, ...args: unknown[]) => unknown): void;
}

/** No renderer-supplied URL, installation path, version or shell argument exists. */
export function registerInstallationIntegrityIpc<Event>(ipc: IpcRegistrar<Event>, options: {
  controller: () => IntegrityController | null;
  isTrustedSender: (event: Event) => boolean;
  unavailableState: InstallationIntegrityState;
  openRelease: () => Promise<boolean>;
}): void {
  const stateAction = (action: keyof Pick<IntegrityController, 'getState' | 'checkNow' | 'downloadRepair' | 'cancel'>) =>
    (event: Event, ...args: unknown[]) => {
      if (!options.isTrustedSender(event) || args.length) return options.unavailableState;
      return options.controller()?.[action]() ?? options.unavailableState;
    };
  ipc.handle('cove:integrity:get-state', stateAction('getState'));
  ipc.handle('cove:integrity:check', stateAction('checkNow'));
  ipc.handle('cove:integrity:download', stateAction('downloadRepair'));
  ipc.handle('cove:integrity:cancel', stateAction('cancel'));
  ipc.handle('cove:integrity:launch', (event, ...args) => {
    if (!options.isTrustedSender(event) || args.length) return false;
    return options.controller()?.launchRepair() ?? false;
  });
  ipc.handle('cove:integrity:open-release', (event, ...args) => {
    if (!options.isTrustedSender(event) || args.length) return false;
    return options.openRelease();
  });
}
