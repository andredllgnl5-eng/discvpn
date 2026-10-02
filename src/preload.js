const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('screenShare', {
  sources: () => ipcRenderer.invoke('sources'),
  selectSource: id => ipcRenderer.invoke('select-source', id),
  active: value => ipcRenderer.invoke('stream-active', value),
  copyLink: link => ipcRenderer.invoke('copy-link', link),
  info: () => ipcRenderer.invoke('app-info'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdate: callback => ipcRenderer.on('update', (_, value) => callback(value))
});
