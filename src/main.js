const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { autoUpdater } = require('electron-updater');

let win;
let vpnProcess = null;
let monitorTimer = null;
let selectedServer = null;
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

async function ensureOpenVpn() {
  const executable = findOpenVpn();
  if (executable) return executable;
  throw new Error('O componente OpenVPN integrado não foi encontrado. Reinstale o Japan Discord VPN para reparar os componentes de rede.');
}

function parseCsvLine(line) {
  const values = [];
  let value = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted;
    } else if (char === ',' && !quoted) { values.push(value); value = ''; }
    else value += char;
  }
  values.push(value);
  return values;
}

async function fetchJapanServers() {
  const response = await fetch('https://www.vpngate.net/api/iphone/', { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`VPN Gate respondeu com HTTP ${response.status}.`);
  const lines = (await response.text()).split(/\r?\n/).filter(Boolean);
  const headerIndex = lines.findIndex(line => line.startsWith('#HostName,'));
  if (headerIndex < 0) throw new Error('A lista de servidores recebida é inválida.');
  const headers = parseCsvLine(lines[headerIndex]).map(x => x.replace(/^#/, ''));
  return lines.slice(headerIndex + 1).filter(line => !line.startsWith('*')).map(parseCsvLine)
    .map(row => Object.fromEntries(headers.map((key, index) => [key, row[index] || ''])))
    .filter(row => row.CountryShort === 'JP' && row.OpenVPN_ConfigData_Base64)
    .map((row, index) => {
      const ip = row.IP.replace(/[^0-9.]/g, '');
      const hostName = row.HostName.replace(/[^a-zA-Z0-9.-]/g, '');
      return { id: `${ip}-${index}`, hostName, ip, ping: Number(row.Ping) || 9999, speedMbps: Math.round((Number(row.Speed) || 0) / 100000) / 10, sessions: Number(row.NumVpnSessions) || 0, score: Number(row.Score) || 0, config: row.OpenVPN_ConfigData_Base64 };
    })
    .sort((a, b) => a.ping - b.ping || b.speedMbps - a.speedMbps).slice(0, 30);
}

function prepareServerConfig(server) {
  const dir = path.join(app.getPath('userData'), 'runtime');
  fs.mkdirSync(dir, { recursive: true });
  const authPath = path.join(dir, 'auth.txt');
  const configPath = path.join(dir, 'selected-japan-server.ovpn');
  fs.writeFileSync(authPath, 'vpn\nvpn\n', { mode: 0o600 });
  const escapedAuthPath = authPath.replace(/\\/g, '\\\\');
  let config = Buffer.from(server.config, 'base64').toString('utf8');
  if (/^auth-user-pass.*$/m.test(config)) config = config.replace(/^auth-user-pass.*$/m, `auth-user-pass "${escapedAuthPath}"`);
  else config += `\nauth-user-pass "${escapedAuthPath}"\n`;
  fs.writeFileSync(configPath, config, 'utf8');
  return configPath;
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

ipcMain.handle('system-info', async () => ({ openVpn: findOpenVpn(), discord: await findDiscord(), selectedServer: selectedServer?.id || '' }));
ipcMain.handle('list-servers', async () => {
  const servers = await fetchJapanServers();
  global.availableServers = new Map(servers.map(server => [server.id, server]));
  return servers.map(({ config, ...server }) => server);
});
ipcMain.handle('select-server', (_, id) => {
  selectedServer = global.availableServers?.get(id) || null;
  if (!selectedServer) throw new Error('Servidor não encontrado. Atualize a lista.');
  return { id: selectedServer.id, hostName: selectedServer.hostName };
});
ipcMain.handle('connect', async () => {
  const openVpn = await ensureOpenVpn();
  const discord = await findDiscord();
  if (!discord) throw new Error('Discord não encontrado. Instale a versão desktop.');
  if (!selectedServer) throw new Error('Selecione um servidor japonês.');
  const vpnConfig = prepareServerConfig(selectedServer);
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
