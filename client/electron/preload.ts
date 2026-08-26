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

contextBridge.exposeInMainWorld('coveShell', {
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('cove:shell:open-external', url),
});

contextBridge.exposeInMainWorld('coveSecurity', {
  setServerCertificateException: (serverUrl: string, enabled: boolean): Promise<string | null> =>
    ipcRenderer.invoke('cove:security:set-server-certificate-exception', serverUrl, enabled),
});

contextBridge.exposeInMainWorld('coveDiagnostics', {
  append: (entry: unknown): Promise<boolean> => ipcRenderer.invoke('cove:diagnostics:append', entry),
  openLog: (): Promise<boolean> => ipcRenderer.invoke('cove:diagnostics:open-log'),
});

contextBridge.exposeInMainWorld('coveApplicationAudio', {
  listSources: () => ipcRenderer.invoke('cove:application-audio:list'),
  start: (sourceId: string) => ipcRenderer.invoke('cove:application-audio:start', sourceId),
  stop: () => ipcRenderer.invoke('cove:application-audio:stop'),
  onChunk: (listener: (chunk: Uint8Array) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, chunk: Uint8Array) => listener(chunk);
    ipcRenderer.on('cove:application-audio:chunk', handler);
    return () => ipcRenderer.off('cove:application-audio:chunk', handler);
  },
});
