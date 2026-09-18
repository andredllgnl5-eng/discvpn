const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('vpn', {
  info: () => ipcRenderer.invoke('system-info'),
  chooseConfig: () => ipcRenderer.invoke('choose-config'),
  installOpenVpn: () => ipcRenderer.invoke('open-openvpn'),
  connect: () => ipcRenderer.invoke('connect'),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  onState: cb => ipcRenderer.on('state', (_, value) => cb(value)),
  onLog: cb => ipcRenderer.on('log', (_, value) => cb(value)),
  onStats: cb => ipcRenderer.on('stats', (_, value) => cb(value))
});
