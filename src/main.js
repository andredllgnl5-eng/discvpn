const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { autoUpdater } = require('electron-updater');

let win;
let vpnProcess = null;
let monitorTimer = null;
let vpnConfig = '';
let vpnInterface = '';
const addedRoutes = new Set();

const send = (type, payload) => win && !win.isDestroyed() && win.webContents.send(type, payload);

function ps(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim())); else resolve(stdout.trim());
    });
  });
}

function findOpenVpn() {
  const candidates = ['C:\\Program Files\\OpenVPN\\bin\\openvpn.exe'];
  return candidates.find(fs.existsSync) || '';
}

async function findDiscord() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'Discord');
  if (!fs.existsSync(base)) return '';
  const dirs = fs.readdirSync(base).filter(x => /^app-[\d.]+$/.test(x)).sort().reverse();
  for (const dir of dirs) {
    const exe = path.join(base, dir, 'Discord.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return '';
}

function createWindow() {
  win = new BrowserWindow({
    width: 760, height: 690, minWidth: 680, minHeight: 620,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    backgroundColor: '#0b1020',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.once('did-finish-load', () => {
    if (app.isPackaged) autoUpdater.checkForUpdatesAndNotify().catch(error => send('log', `Atualização: ${error.message}`));
  });
}

async function discoverVpnInterface() {
  const output = await ps("Get-NetAdapter | Where-Object {$_.Status -eq 'Up' -and ($_.InterfaceDescription -match 'OpenVPN|TAP|Wintun|DCO' -or $_.Name -match 'OpenVPN|TAP')} | Sort-Object ifIndex -Descending | Select-Object -First 1 -ExpandProperty ifIndex");
  vpnInterface = output.split(/\r?\n/)[0].trim();
  return vpnInterface;
}

async function addDiscordRoutes() {
  if (!vpnInterface) await discoverVpnInterface();
  if (!vpnInterface) return;
  const raw = await ps("$p=Get-Process Discord -ErrorAction SilentlyContinue; if($p){$ids=$p.Id; Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object {$ids -contains $_.OwningProcess -and $_.RemoteAddress -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$'} | Select-Object -ExpandProperty RemoteAddress -Unique}");
  for (const ip of raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
    if (addedRoutes.has(ip)) continue;
    try {
      await ps(`New-NetRoute -DestinationPrefix '${ip}/32' -InterfaceIndex ${vpnInterface} -RouteMetric 1 -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Out-Null`);
      addedRoutes.add(ip);
      send('log', `Rota protegida: ${ip}`);
    } catch (e) { send('log', `Não foi possível adicionar ${ip}: ${e.message}`); }
  }
  send('stats', { routes: addedRoutes.size });
}

async function addKnownDiscordRoutes() {
  const hosts = ['discord.com', 'discord.gg', 'gateway.discord.gg', 'cdn.discordapp.com', 'media.discordapp.net'];
  const raw = await ps(`$hosts=@(${hosts.map(x => `'${x}'`).join(',')}); foreach($h in $hosts){Resolve-DnsName $h -Type A -ErrorAction SilentlyContinue | Select-Object -ExpandProperty IPAddress}`);
  if (!vpnInterface) await discoverVpnInterface();
  for (const ip of raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
    if (addedRoutes.has(ip)) continue;
    try {
      await ps(`New-NetRoute -DestinationPrefix '${ip}/32' -InterfaceIndex ${vpnInterface} -RouteMetric 1 -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Out-Null`);
      addedRoutes.add(ip);
      send('log', `Rota inicial protegida: ${ip}`);
    } catch (e) { send('log', `Não foi possível adicionar ${ip}: ${e.message}`); }
  }
}

async function removeRoutes() {
  if (!addedRoutes.size) return;
  const prefixes = [...addedRoutes].map(ip => `'${ip}/32'`).join(',');
  try { await ps(`$p=@(${prefixes}); Get-NetRoute -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Where-Object {$p -contains $_.DestinationPrefix} | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue`); } catch {}
  addedRoutes.clear();
}

async function stopVpn() {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
  await removeRoutes();
  if (vpnProcess) { vpnProcess.kill(); vpnProcess = null; }
  vpnInterface = '';
  send('state', { state: 'idle', message: 'Desconectado' });
}

ipcMain.handle('system-info', async () => ({ openVpn: findOpenVpn(), discord: await findDiscord(), config: vpnConfig }));
ipcMain.handle('choose-config', async () => {
  const result = await dialog.showOpenDialog(win, { title: 'Selecione um servidor OpenVPN do Japão', filters: [{ name: 'OpenVPN', extensions: ['ovpn'] }], properties: ['openFile'] });
  if (!result.canceled) vpnConfig = result.filePaths[0];
  return vpnConfig;
});
ipcMain.handle('open-openvpn', () => shell.openExternal('https://openvpn.net/community-downloads/'));
ipcMain.handle('connect', async () => {
  const openVpn = findOpenVpn();
  const discord = await findDiscord();
  if (!openVpn) throw new Error('OpenVPN Community não encontrado. Instale-o pelo botão indicado.');
  if (!discord) throw new Error('Discord não encontrado. Instale a versão desktop.');
  if (!vpnConfig || !fs.existsSync(vpnConfig)) throw new Error('Selecione um arquivo .ovpn de um servidor no Japão.');
  await stopVpn();
  send('state', { state: 'connecting', message: 'Conectando ao Japão…' });
  vpnProcess = spawn(openVpn, ['--config', vpnConfig, '--route-nopull', '--auth-nocache'], { windowsHide: true });
  vpnProcess.stdout.on('data', async data => {
    const line = data.toString(); send('log', line.trim());
    if (line.includes('Initialization Sequence Completed')) {
      await discoverVpnInterface();
      await addKnownDiscordRoutes();
      spawn(discord, [], { detached: true, stdio: 'ignore' }).unref();
      setTimeout(addDiscordRoutes, 3500);
      monitorTimer = setInterval(addDiscordRoutes, 5000);
      send('state', { state: 'connected', message: 'Discord conectado via Japão' });
    }
  });
  vpnProcess.stderr.on('data', data => send('log', data.toString().trim()));
  vpnProcess.on('exit', code => { vpnProcess = null; if (code !== null) send('state', { state: 'idle', message: `OpenVPN finalizado (${code})` }); });
  return true;
});
ipcMain.handle('disconnect', stopVpn);

app.whenReady().then(createWindow);
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.on('update-available', info => send('log', `Atualização ${info.version} encontrada; baixando…`));
autoUpdater.on('update-downloaded', info => send('state', { state: 'connected', message: `Atualização ${info.version} pronta; será instalada ao sair` }));
autoUpdater.on('error', error => send('log', `Atualizador: ${error.message}`));
app.on('before-quit', () => stopVpn());
app.on('window-all-closed', () => app.quit());
