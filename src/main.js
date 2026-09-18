const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const { autoUpdater } = require('electron-updater');

let win;
let vpnProcess = null;
let monitorTimer = null;
let selectedServer = null;
let vpnInterface = '';
let connectionTimer = null;
const addedRoutes = new Set();

const send = (type, payload) => win && !win.isDestroyed() && win.webContents.send(type, payload);
const logFile = () => path.join(app.getPath('userData'), 'japan-discord-vpn.log');
function log(message) {
  const clean = String(message || '').trim();
  if (!clean) return;
  send('log', clean);
  try { fs.appendFileSync(logFile(), `[${new Date().toISOString()}] ${clean}\n`, 'utf8'); } catch {}
}

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

function tryVpnServer(openVpn, server, routeIps, attempt, total) {
  return new Promise((resolve, reject) => {
    const vpnConfig = prepareServerConfig(server);
    send('state', { state: 'connecting', message: `Tentando servidor ${attempt} de ${total}…` });
    log(`Tentativa ${attempt}/${total}: ${server.hostName} (${server.ip})`);
    const routeArgs = routeIps.flatMap(ip => ['--route', ip, '255.255.255.255', 'vpn_gateway']);
    const child = spawn(openVpn, ['--config', vpnConfig, '--route-nopull', '--auth-nocache', '--connect-timeout', '8', '--connect-retry-max', '1', ...routeArgs], { windowsHide: true });
    vpnProcess = child;
    let settled = false;
    let connected = false;
    let failureReason = '';
    const timer = setTimeout(() => fail('tempo limite'), 22000);
    const fail = reason => {
      if (settled) return;
      failureReason = reason;
      clearTimeout(timer);
      if (!child.killed) child.kill();
      setTimeout(() => finishFailure(), 2500).unref();
    };
    const finishFailure = () => {
      if (settled) return;
      settled = true;
      if (vpnProcess === child) vpnProcess = null;
      reject(new Error(failureReason || 'OpenVPN foi encerrado'));
    };
    const handleOutput = data => {
      const line = data.toString();
      log(line);
      if (line.includes('Initialization Sequence Completed') && !settled) {
        settled = true;
        connected = true;
        clearTimeout(timer);
        resolve(server);
      } else if (/Exiting due to fatal error|AUTH_FAILED|TLS Error/.test(line) && !connected) {
        fail('falha do servidor');
      }
    };
    child.stdout.on('data', handleOutput);
    child.stderr.on('data', handleOutput);
    child.on('error', error => fail(error.message));
    child.on('exit', code => {
      if (!connected) { failureReason ||= `OpenVPN finalizado (${code})`; finishFailure(); }
      else if (vpnProcess === child) {
        vpnProcess = null;
        send('state', { state: 'idle', message: `OpenVPN finalizado (${code})` });
      }
    });
  });
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

async function resolveDiscordIps() {
  const hosts = ['discord.com', 'discord.gg', 'gateway.discord.gg', 'cdn.discordapp.com', 'media.discordapp.net', 'discordapp.com'];
  const results = await Promise.allSettled(hosts.map(host => dns.resolve4(host)));
  return [...new Set(results.flatMap(result => result.status === 'fulfilled' ? result.value : []))];
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
      log(`Rota protegida: ${ip}`);
    } catch (e) { log(`Não foi possível adicionar ${ip}: ${e.message}`); }
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
      log(`Rota inicial protegida: ${ip}`);
    } catch (e) { log(`Não foi possível adicionar ${ip}: ${e.message}`); }
  }
}

async function removeRoutes() {
  if (!addedRoutes.size) return;
  const prefixes = [...addedRoutes].map(ip => `'${ip}/32'`).join(',');
  try { await ps(`$p=@(${prefixes}); Get-NetRoute -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Where-Object {$p -contains $_.DestinationPrefix} | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue`); } catch {}
  addedRoutes.clear();
}

async function stopVpn() {
  if (connectionTimer) clearTimeout(connectionTimer);
  connectionTimer = null;
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
  await stopVpn();
  const initialRouteIps = await resolveDiscordIps();
  if (!initialRouteIps.length) throw new Error('Não foi possível resolver os endereços do Discord. Verifique o DNS e tente novamente.');
  const available = [...(global.availableServers?.values() || [])];
  const candidates = [selectedServer, ...available.filter(server => server.id !== selectedServer.id)];
  let connectedServer = null;
  for (let index = 0; index < candidates.length; index++) {
    try {
      connectedServer = await tryVpnServer(openVpn, candidates[index], initialRouteIps, index + 1, candidates.length);
      break;
    } catch (error) {
      log(`${candidates[index].hostName} indisponível: ${error.message}`);
    }
  }
  if (!connectedServer) {
    send('state', { state: 'idle', message: 'Nenhum servidor respondeu' });
    throw new Error('Os servidores japoneses testados estão indisponíveis. Atualize a lista e tente novamente.');
  }
  selectedServer = connectedServer;
  await discoverVpnInterface();
  initialRouteIps.forEach(ip => addedRoutes.add(ip));
  send('stats', { routes: addedRoutes.size });
  await ps("Get-Process Discord -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue");
  spawn(discord, [], { detached: true, stdio: 'ignore' }).unref();
  monitorTimer = setInterval(() => addDiscordRoutes().catch(error => log(`Monitor de rotas: ${error.message}`)), 3000);
  send('state', { state: 'connected', message: `Discord pelo Japão — ${connectedServer.hostName}` });
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
