const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('probeBridge',{
 setActive:sessionId=>ipcRenderer.invoke('probe:active',sessionId),
 sendInput:(sessionId,input)=>ipcRenderer.invoke('probe:input',sessionId,input),
 onEmergencyStop:listener=>{const fn=(_e,reason)=>listener(reason);ipcRenderer.on('probe:emergency',fn);return()=>ipcRenderer.off('probe:emergency',fn);}
});
