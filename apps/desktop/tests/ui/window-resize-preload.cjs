// Only the resize-state bridge; no accounts, capture permissions or updater.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('coveWindow', {
  onResize: listener => {
    const handler = (_event, active) => listener(active);
    ipcRenderer.on('cove:window-resizing', handler);
    return () => ipcRenderer.off('cove:window-resizing', handler);
  },
});
