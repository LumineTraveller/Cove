// Only the annotation bridge is needed by this fixture. Other production
// bridges are intentionally absent because the synthetic fixture replaces them.
const {contextBridge,ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('coveAnnotationOverlay',{
  bind:id=>ipcRenderer.invoke('cove:annotation-overlay:bind',id),
  update:(token,frame)=>ipcRenderer.invoke('cove:annotation-overlay:update',token,frame),
  close:token=>ipcRenderer.invoke('cove:annotation-overlay:close',token),
  setInputActive:(token,active)=>ipcRenderer.invoke('cove:annotation-overlay:input-mode',token,active),
  onInput:listener=>{
    const handler=(_event,event)=>listener(event);
    ipcRenderer.on('cove:annotation-overlay:input',handler);
    return()=>ipcRenderer.off('cove:annotation-overlay:input',handler);
  },
  onFailure:listener=>{
    const handler=(_event,event)=>listener(event);
    ipcRenderer.on('cove:annotation-overlay:failure',handler);
    return()=>ipcRenderer.off('cove:annotation-overlay:failure',handler);
  },
});
