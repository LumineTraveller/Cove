import { contextBridge, ipcRenderer } from 'electron';
import type { UpdateState } from './updater-core';
import type { RemoteControlInput } from './remote-control';

contextBridge.exposeInMainWorld('coveUpdater', {
  getState: (): Promise<UpdateState> => ipcRenderer.invoke('cove:update:get-state'),
  checkNow: (): Promise<UpdateState> => ipcRenderer.invoke('cove:update:check'),
  installNow: (): Promise<boolean> => ipcRenderer.invoke('cove:update:install'),
  openLog: (): Promise<boolean> => ipcRenderer.invoke('cove:update:open-log'),
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

contextBridge.exposeInMainWorld('coveRemoteControl', {
  supported: process.platform === 'win32',
  setActive: (sessionId: string | null): Promise<boolean> => ipcRenderer.invoke('cove:remote-control:set-active', sessionId),
  sendInput: (sessionId: string, input: RemoteControlInput): Promise<boolean> =>
    ipcRenderer.invoke('cove:remote-control:input', sessionId, input),
  onEmergencyStop: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('cove:remote-control:emergency-stop', handler);
    return () => ipcRenderer.off('cove:remote-control:emergency-stop', handler);
  },
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

// Screen sharing uses a native process-loopback capture in the main process.
// Its exclude mode removes Cove's own rendered audio from the desktop mix.
contextBridge.exposeInMainWorld('coveScreenAudio', {
  start: () => ipcRenderer.invoke('cove:screen-audio:start'),
  stop: () => ipcRenderer.invoke('cove:screen-audio:stop'),
  onChunk: (listener: (chunk: Uint8Array) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, chunk: Uint8Array) => listener(chunk);
    ipcRenderer.on('cove:screen-audio:chunk', handler);
    return () => ipcRenderer.off('cove:screen-audio:chunk', handler);
  },
});
