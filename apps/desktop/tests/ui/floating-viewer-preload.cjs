'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// Only the existing product focus capability; no shell, arbitrary IPC or media.
contextBridge.exposeInMainWorld('coveWindow', { focus: () => ipcRenderer.invoke('floating-viewer-test:focus') });
