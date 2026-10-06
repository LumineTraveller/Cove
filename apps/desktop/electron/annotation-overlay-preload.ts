import { contextBridge, ipcRenderer } from 'electron';

// Only validated own-session drawing input; no access to application or OS input bridges.
contextBridge.exposeInMainWorld('annotationOverlay', {
  onFrame: (listener: (frame: unknown) => void) => {
    ipcRenderer.on('cove:annotation-overlay:frame', (_event, frame: unknown) => listener(frame));
  },
  onMode: (listener: (mode: unknown) => void) => {
    ipcRenderer.on('cove:annotation-overlay:mode', (_event, mode: unknown) => listener(mode));
  },
  sendInput: (token: string, event: unknown) => ipcRenderer.send('cove:annotation-overlay:input', token, event),
});
