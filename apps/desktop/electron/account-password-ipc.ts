import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { AccountPasswordStore } from './account-password-store';

export function registerAccountPasswordIpc(ipc: Pick<IpcMain, 'handle'>, store: AccountPasswordStore, trusted: (event: IpcMainInvokeEvent) => boolean) {
  const rejected = { available: false, ok: false };
  ipc.handle('cove:account-password:status', event => trusted(event) ? store.status() : rejected);
  ipc.handle('cove:account-password:get', (event, server: unknown, email: unknown) => trusted(event) ? store.get(server, email) : rejected);
  ipc.handle('cove:account-password:set', (event, server: unknown, email: unknown, password: unknown) => trusted(event) ? store.set(server, email, password) : rejected);
  ipc.handle('cove:account-password:remove', (event, server: unknown, email: unknown) => trusted(event) ? store.remove(server, email) : rejected);
  ipc.handle('cove:account-password:clear', event => trusted(event) ? store.clear() : rejected);
}
