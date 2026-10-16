import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { ServerAccessStore } from './server-access-store';

export function registerServerAccessIpc(ipc: Pick<IpcMain, 'handle'>, store: ServerAccessStore,
  trusted: (event: IpcMainInvokeEvent) => boolean) {
  const rejected = { available: false, ok: false };
  ipc.handle('cove:server-access:get', (event, server: unknown, email: unknown) => trusted(event) ? store.get(server, email) : rejected);
  ipc.handle('cove:server-access:set', (event, server: unknown, email: unknown, grant: unknown) => trusted(event) ? store.set(server, email, grant) : rejected);
  ipc.handle('cove:server-access:remove', (event, server: unknown, email?: unknown) => trusted(event) ? store.remove(server, email) : rejected);
  ipc.handle('cove:server-access:clear', event => trusted(event) ? store.clear() : rejected);
}
