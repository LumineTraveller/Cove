import { contextBridge, ipcRenderer } from 'electron';
import type { UpdateState } from './updater-core';

contextBridge.exposeInMainWorld('coveUpdater', {
  getState: (): Promise<UpdateState> => ipcRenderer.invoke('cove:update:get-state'),
  checkNow: (): Promise<UpdateState> => ipcRenderer.invoke('cove:update:check'),
  installNow: (): Promise<boolean> => ipcRenderer.invoke('cove:update:install'),
  onState: (listener: (state: UpdateState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: UpdateState) => listener(state);
    ipcRenderer.on('cove:update:state', handler);
    return () => ipcRenderer.off('cove:update:state', handler);
  },
});
