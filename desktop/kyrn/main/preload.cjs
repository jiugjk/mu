const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('kyrn', {
  request: (method, args) => ipcRenderer.invoke('kyrn:request', method, args),
  subscribe: (listener) => {
    const handler = (_event, envelope) => listener(envelope);
    ipcRenderer.on('kyrn:event', handler);
    return () => ipcRenderer.removeListener('kyrn:event', handler);
  },
});
