const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nfcDesktop', {
  getStatus: () => ipcRenderer.invoke('helper:get-status'),
  startHelper: () => ipcRenderer.invoke('helper:start'),
  stopHelper: () => ipcRenderer.invoke('helper:stop'),
  openLogs: () => ipcRenderer.invoke('helper:open-logs'),
});
