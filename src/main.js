const { app, BrowserWindow, ipcMain, desktopCapturer, session, powerSaveBlocker, clipboard } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { autoUpdater } = require('electron-updater');
app.setName('Screen Share');
let win, selectedSource, blocker;
let updateReady = false;
const entry = pathToFileURL(path.join(__dirname, 'index.html')).href;
const trusted = event => event.sender === win?.webContents && event.senderFrame?.url === entry;
const sendUpdate = value => { if (win && !win.isDestroyed()) win.webContents.send('update', value); };
function handle(name, callback) {
  ipcMain.handle(name, (event, ...args) => {
    if (!trusted(event)) throw new Error('Origem não autorizada.');
    return callback(...args);
  });
}
function keepAwake(active) {
  if (active && blocker === undefined) blocker = powerSaveBlocker.start('prevent-display-sleep');
  if (!active && blocker !== undefined) { powerSaveBlocker.stop(blocker); blocker = undefined; }
}
handle('sources', async () => (await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } }))
  .filter(source => source.name !== 'Screen Share')
  .map(source => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() })));
handle('select-source', id => {
  if (typeof id !== 'string' || !/^(screen|window):/.test(id)) throw new Error('Selecione uma tela ou janela.');
  selectedSource = { id, expires: Date.now() + 30000 };
});
handle('stream-active', active => keepAwake(active === true));
handle('copy-link', link => {
  if (typeof link !== 'string' || !/^https:\/\/andredllgnl5-eng\.github\.io\/discvpn\/\?watch=shivi-[a-zA-Z0-9-]+$/.test(link)) throw new Error('Link inválido.');
  clipboard.writeText(link);
});
handle('app-info', () => ({ version: app.getVersion() }));
handle('check-update', async () => {
  if (!app.isPackaged) return { message: 'Versão de desenvolvimento.' };
  if (updateReady) return { message: 'Atualização pronta para instalar.', ready: true };
  await autoUpdater.checkForUpdates();
  return { message: 'Verificação concluída.' };
});
handle('install-update', () => {
  if (!updateReady) throw new Error('Nenhuma atualização pronta.');
  autoUpdater.quitAndInstall();
});
app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const choice = selectedSource;
    selectedSource = undefined;
    if (request.frame?.url !== entry || !choice || choice.expires < Date.now() || !request.audioRequested) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find(item => item.id === choice.id);
      callback(source ? { video: source, audio: 'loopback' } : {});
    } catch { callback({}); }
  });
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(contents === win?.webContents && contents.getURL() === entry && ['media', 'display-capture'].includes(permission));
  });
  win = new BrowserWindow({ width: 1120, height: 870, minWidth: 760, minHeight: 650, title: 'Screen Share', backgroundColor: '#090e19',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (url !== entry) event.preventDefault(); });
  win.loadFile(path.join(__dirname, 'index.html'));
  if (app.isPackaged) {
    win.webContents.once('did-finish-load', () => autoUpdater.checkForUpdates().catch(() => {}));
    setInterval(() => { if (!updateReady) autoUpdater.checkForUpdates().catch(() => {}); }, 3600000).unref();
  }
});
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.on('update-available', info => sendUpdate({ message: `Baixando versão ${info.version}…` }));
autoUpdater.on('update-not-available', () => sendUpdate({ message: 'Você já está na versão mais recente.' }));
autoUpdater.on('update-downloaded', info => { updateReady = true; sendUpdate({ message: `Versão ${info.version} pronta.`, ready: true }); });
autoUpdater.on('error', error => sendUpdate({ message: `Falha ao atualizar: ${error.message}` }));
app.on('before-quit', () => keepAwake(false));
app.on('window-all-closed', () => app.quit());
