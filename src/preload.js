const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('vpn', {
  info: () => ipcRenderer.invoke('system-info'),
  listServers: () => ipcRenderer.invoke('list-servers'),
  selectServer: id => ipcRenderer.invoke('select-server', id),
  connect: options => ipcRenderer.invoke('connect', options),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  openSharePage: () => ipcRenderer.invoke('open-share-page'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdate: cb => ipcRenderer.on('update', (_, value) => cb(value)),
  onState: cb => ipcRenderer.on('state', (_, value) => cb(value)),
  onLog: cb => ipcRenderer.on('log', (_, value) => cb(value)),
  onStats: cb => ipcRenderer.on('stats', (_, value) => cb(value))
});
