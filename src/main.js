const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const crypto = require('node:crypto');
const { autoUpdater } = require('electron-updater');
let updateReady = false;

let win;
let vpnProcess = null;
let monitorTimer = null;
let selectedServer = null;
let vpnInterface = '';
let vpnGateway = '';
let vpnClientIp = '';
let connectionTimer = null;
let monitorBusy = false;
let discordLogPosition = 0;
const addedRoutes = new Set();

const send = (type, payload) => win && !win.isDestroyed() && win.webContents.send(type, payload);
const logFile = () => path.join(app.getPath('userData'), 'canada-discord-vpn.log');
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
  throw new Error('O componente OpenVPN integrado não foi encontrado. Reinstale o Canada Discord VPN para reparar os componentes de rede.');
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

async function fetchCanadaServers() {
  const servers = [];
  try {
    const pageResponse = await fetch('https://www.vpnbook.com/freevpn/openvpn', { signal: AbortSignal.timeout(20000) });
    const page = pageResponse.ok ? await pageResponse.text() : '';
    const password = /Password<\/label>[\s\S]{0,600}?<code[^>]*>([^<]+)<\/code>/i.exec(page)?.[1]?.trim();
    if (password) {
      const hosts = [
        { id: 'ca149', name: 'Canadá 1', host: 'ca149.vpnbook.com', ip: '144.217.253.149' },
        { id: 'ca196', name: 'Canadá 2', host: 'ca196.vpnbook.com', ip: '142.4.216.196' }
      ];
      const profiles = [{ id: 'udp25000', label: 'UDP rápido', protocol: 'udp' }, { id: 'udp53', label: 'UDP alternativo', protocol: 'udp' }, { id: 'tcp443', label: 'TCP compatível', protocol: 'tcp' }];
      const book = await Promise.all(hosts.flatMap(host => profiles.map(async profile => {
        try {
          const response = await fetch(`https://www.vpnbook.com/api/openvpn?hostname=${host.host}&protocol=${profile.id}&ip=${host.ip}`, { signal: AbortSignal.timeout(15000) });
          if (!response.ok) return null;
          return { id: `${host.id}-${profile.id}`, hostName: `${host.name} · ${profile.label}`, ip: host.ip, protocol: profile.protocol, provider: 'VPNBook', ping: 0, speedMbps: 0, sessions: 0, score: 0, username: 'vpnbook', password, config: Buffer.from(await response.arrayBuffer()).toString('base64') };
        } catch { return null; }
      })));
      servers.push(...book.filter(Boolean));
    }
  } catch (error) { log(`VPNBook: ${error.message}`); }
  try {
    const response = await fetch('https://www.vpngate.net/api/iphone/', { signal: AbortSignal.timeout(25000) });
    if (response.ok) {
      const lines = (await response.text()).split(/\r?\n/).filter(Boolean);
      const headerIndex = lines.findIndex(line => line.startsWith('#HostName,'));
      if (headerIndex >= 0) {
        const headers = parseCsvLine(lines[headerIndex]).map(value => value.replace(/^#/, ''));
        const gate = lines.slice(headerIndex + 1).filter(line => !line.startsWith('*')).map(parseCsvLine)
          .map(row => Object.fromEntries(headers.map((key, index) => [key, row[index] || ''])))
          .filter(row => row.CountryShort === 'CA' && row.OpenVPN_ConfigData_Base64)
          .map((row, index) => { const decoded = Buffer.from(row.OpenVPN_ConfigData_Base64, 'base64').toString('utf8'); const protocol = /^proto\s+(udp|tcp)/mi.exec(decoded)?.[1]?.toLowerCase() || 'tcp'; return { id: `vpngate-ca-${row.IP}-${index}`, hostName: row.HostName || `Canadá ${index + 1}`, ip: row.IP, protocol, provider: 'VPN Gate', ping: Number(row.Ping) || 9999, speedMbps: Math.round((Number(row.Speed) || 0) / 100000) / 10, sessions: Number(row.NumVpnSessions) || 0, score: Number(row.Score) || 0, username: 'vpn', password: 'vpn', config: row.OpenVPN_ConfigData_Base64 }; });
        servers.unshift(...gate);
      }
    }
  } catch (error) { log(`VPN Gate: ${error.message}`); }
  servers.sort((a, b) => (a.protocol === 'udp' ? 0 : 1) - (b.protocol === 'udp' ? 0 : 1) || a.ping - b.ping || b.speedMbps - a.speedMbps);
  if (!servers.length) throw new Error('Nenhum servidor no Canadá respondeu.');
  return servers.slice(0, 30);
}

function prepareServerConfig(server) {
  const dir = path.join(app.getPath('userData'), 'runtime');
  fs.mkdirSync(dir, { recursive: true });
  const authPath = path.join(dir, 'auth.txt');
  const configPath = path.join(dir, 'selected-canada-server.ovpn');
  fs.writeFileSync(authPath, `${server.username || 'vpn'}\n${server.password || 'vpn'}\n`, { mode: 0o600 });
  const escapedAuthPath = authPath.replace(/\\/g, '\\\\');
  let config = Buffer.from(server.config, 'base64').toString('utf8');
  config = config
    .replace(/^redirect-gateway.*$/gmi, '')
    .replace(/^block-outside-dns.*$/gmi, '')
    .replace(/^tun-mtu.*$/gmi, '')
    .replace(/^mssfix.*$/gmi, '');
  if (/^auth-user-pass.*$/m.test(config)) config = config.replace(/^auth-user-pass.*$/m, `auth-user-pass "${escapedAuthPath}"`);
  else config += `\nauth-user-pass "${escapedAuthPath}"\n`;
  config += '\npull-filter ignore "redirect-gateway"\npull-filter ignore "block-outside-dns"\ntun-mtu 1400\nmssfix 1360\n';
  fs.writeFileSync(configPath, config, 'utf8');
  return configPath;
}

function tryVpnServer(openVpn, server, routeIps, fullTunnel, attempt, total) {
  return new Promise((resolve, reject) => {
    const vpnConfig = prepareServerConfig(server);
    send('state', { state: 'connecting', message: `Tentando servidor ${attempt} de ${total}…` });
    log(`Tentativa ${attempt}/${total}: ${server.hostName} (${server.ip})`);
    const routeArgs = fullTunnel ? ['--redirect-gateway', 'def1'] : ['--route-nopull', ...routeIps.flatMap(ip => ['--route', ip, '255.255.255.255', 'vpn_gateway'])];
    const child = spawn(openVpn, ['--config', vpnConfig, '--auth-nocache', '--disable-dco', '--connect-timeout', '8', '--connect-retry', '2', '10', '--ping', '10', '--ping-restart', '45', ...routeArgs], { windowsHide: true });
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
      const ifconfig = /(?:^|[,\s])ifconfig\s+(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)/i.exec(line);
      if (ifconfig) {
        vpnClientIp = ifconfig[1];
        vpnGateway = ifconfig[2];
      }
      if (connected && /SIGUSR1|Restart pause|Server poll timeout|Inactivity timeout/.test(line)) {
        send('state', { state: 'connecting', message: `Reconectando ao Canadá — ${server.hostName}…` });
      }
      if (connected && line.includes('Initialization Sequence Completed')) {
        send('state', { state: 'connected', message: `Discord pelo Canadá — ${server.hostName}` });
      }
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
  // Keep Discord's control WebSockets on the normal connection. Free VPN
  // exits commonly block their alternate TCP ports (2053/2087/2096/8443),
  // which leaves voice connected but makes streams black. Only concrete UDP
  // media IPs discovered in the Discord log are routed through OpenVPN.
  return [];
}

async function resolveCompatibilityIps() {
  const hosts = ['discord.com', 'discord.gg', 'gateway.discord.gg', 'cdn.discordapp.com', 'media.discordapp.net', 'discordapp.com'];
  const found = new Set();
  const rtcControl = new Set();
  try {
    const raw = await ps(`$hosts=@(${hosts.map(x => `'${x}'`).join(',')}); foreach($h in $hosts){[System.Net.Dns]::GetHostAddresses($h) | Where-Object {$_.AddressFamily -eq 'InterNetwork'} | ForEach-Object {$_.IPAddressToString}}`);
    raw.split(/\r?\n/).map(x => x.trim()).filter(x => /^\d+\.\d+\.\d+\.\d+$/.test(x)).forEach(ip => found.add(ip));
    const rtcRaw = await ps("[System.Net.Dns]::GetHostAddresses('latency.discord.media') | Where-Object {$_.AddressFamily -eq 'InterNetwork'} | ForEach-Object {$_.IPAddressToString}");
    rtcRaw.split(/\r?\n/).map(x => x.trim()).filter(Boolean).forEach(ip => rtcControl.add(ip));
  } catch (error) { log(`DNS de compatibilidade: ${error.message}`); }
  // Used only when compatibility is disabled. Compatibility restores the
  // proven full-tunnel Japan behavior from v1.7.0.
  return [...found].filter(ip => !rtcControl.has(ip));
}

function testTunnelQuality() {
  return new Promise(resolve => {
    execFile('ping.exe', ['-4', '-n', '5', '-w', '1200', '1.1.1.1'], { windowsHide: true, timeout: 9000 }, (_error, stdout = '') => {
      const replies = (stdout.match(/TTL=/gi) || []).length;
      const samples = [...stdout.matchAll(/[=<]\s*(\d+)\s*ms/gi)].map(match => Number(match[1])).filter(Number.isFinite);
      const latency = samples.length ? Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length) : 9999;
      resolve({ replies, sent: 5, loss: Math.round((1 - replies / 5) * 100), latency, healthy: replies >= 4 && latency <= 260 });
    });
  });
}

async function verifyJapanExit() {
  const services = [
    ['https://ipapi.co/json/', data => data.country_code],
    ['https://ipwho.is/', data => data.country_code]
  ];
  for (const [url, getCountry] of services) {
    try {
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      const country = String(getCountry(data) || '').toUpperCase();
      if (country) return { valid: country === 'JP', country, ip: data.ip || '' };
    } catch (error) { log(`Verificação de região: ${error.message}`); }
  }
  return { valid: false, country: '', ip: '' };
}

function latestDiscordRtcTargets() {
  try {
    const discordLog = path.join(process.env.APPDATA || '', 'discord', 'logs', 'renderer_js.log');
    if (!fs.existsSync(discordLog)) return [];
    const content = fs.readFileSync(discordLog, 'utf8').slice(-1024 * 1024);
    const targets = [...content.matchAll(/wss:\/\/([a-z0-9.-]+\.discord\.media):(\d+)/gi)]
      .map(match => ({ host: match[1], port: Number(match[2]) }))
      .reverse();
    return targets.filter((target, index, list) => index === list.findIndex(item => item.host === target.host && item.port === target.port)).slice(0, 4);
  } catch (error) {
    log(`Leitura RTC: ${error.message}`);
    return [];
  }
}

function canConnectRtc(host, port, timeout = 7000) {
  return new Promise(resolve => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true });
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout, () => finish(false));
    socket.once('secureConnect', () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write(`GET /?v=9 HTTP/1.1\r\nHost: ${host}:${port}\r\nOrigin: https://discord.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    socket.on('data', data => finish(/HTTP\/1\.1 101/i.test(data.toString('utf8'))));
    socket.once('error', () => finish(false));
  });
}

async function verifyDiscordRtc() {
  const targets = latestDiscordRtcTargets();
  if (!targets.length) return { valid: true, target: 'sem histórico RTC' };
  const results = await Promise.all(targets.map(target => canConnectRtc(target.host, target.port)));
  const reachableIndex = results.findIndex(Boolean);
  if (reachableIndex >= 0) return { valid: true, target: `${targets[reachableIndex].host}:${targets[reachableIndex].port}` };
  return { valid: false, target: targets.map(target => `${target.host}:${target.port}`).join(', ') };
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

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
    if (app.isPackaged) autoUpdater.checkForUpdatesAndNotify().catch(error => send('update', { message: `Falha ao verificar atualização: ${error.message}` }));
  });
}

async function discoverVpnInterface() {
  const byAddress = vpnClientIp ? `Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {$_.IPAddress -eq '${vpnClientIp}'} | Select-Object -First 1 -ExpandProperty InterfaceIndex` : '';
  const output = await ps(byAddress || "Get-NetAdapter | Where-Object {$_.Status -eq 'Up' -and ($_.InterfaceDescription -match 'OpenVPN|TAP|Wintun|DCO' -or $_.Name -match 'OpenVPN|TAP')} | Sort-Object ifIndex -Descending | Select-Object -First 1 -ExpandProperty ifIndex");
  vpnInterface = output.split(/\r?\n/)[0].trim();
  return vpnInterface;
}

async function addDiscordRoutes() {
  if (!vpnInterface) await discoverVpnInterface();
  if (!vpnInterface || !vpnGateway) return;
  const raw = await ps("$p=Get-Process Discord -ErrorAction SilentlyContinue; if($p){$ids=$p.Id; Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object {$ids -contains $_.OwningProcess -and $_.RemoteAddress -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$'} | Select-Object -ExpandProperty RemoteAddress -Unique}");
  for (const ip of raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
    if (addedRoutes.has(ip)) continue;
    try {
      await ps(`New-NetRoute -DestinationPrefix '${ip}/32' -InterfaceIndex ${vpnInterface} -NextHop '${vpnGateway}' -RouteMetric 1 -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Out-Null`);
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

async function addDiscordMediaRoutes() {
  if (!vpnInterface) await discoverVpnInterface();
  if (!vpnInterface || !vpnGateway) return;
    const discordLog = path.join(process.env.APPDATA || '', 'discord', 'logs', 'renderer_js.log');
    if (!fs.existsSync(discordLog)) return;
    const size = fs.statSync(discordLog).size;
    if (size < discordLogPosition) discordLogPosition = 0;
    if (size === discordLogPosition) return;
    const length = Math.min(size - discordLogPosition, 512 * 1024);
    const start = Math.max(discordLogPosition, size - length);
    const handle = fs.openSync(discordLog, 'r');
    const buffer = Buffer.alloc(size - start);
    fs.readSync(handle, buffer, 0, buffer.length, start);
    fs.closeSync(handle);
    discordLogPosition = size;
    const content = buffer.toString('utf8');
    const ips = new Set();
    for (const match of content.matchAll(/(?:RTC connected to media server:|Creating connection to)\s+(\d+\.\d+\.\d+\.\d+):\d+/gi)) ips.add(match[1]);
    for (const ip of ips) {
      if (addedRoutes.has(ip)) continue;
      try {
        await ps(`New-NetRoute -DestinationPrefix '${ip}/32' -InterfaceIndex ${vpnInterface} -NextHop '${vpnGateway}' -RouteMetric 1 -PolicyStore ActiveStore -ErrorAction Stop | Out-Null`);
        addedRoutes.add(ip);
        log(`Rota RTC protegida: ${ip}`);
      } catch (error) {
        if (/already exists|já existe/i.test(error.message)) addedRoutes.add(ip);
        else log(`Rota RTC ${ip}: ${error.message}`);
      }
    }
  send('stats', { routes: addedRoutes.size, fullTunnel: false });
}

async function monitorDiscordRoutes() {
  if (monitorBusy || !vpnProcess) return;
  monitorBusy = true;
  try {
    await addDiscordMediaRoutes();
  } finally {
    monitorBusy = false;
  }
}

async function cleanupOpenVpnNetworkState() {
  try {
    await ps("$indexes=@(Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue | Where-Object {$_.InterfaceDescription -match 'OpenVPN|TAP|Wintun|DCO' -or $_.Name -match 'OpenVPN|TAP|Wintun'} | Select-Object -ExpandProperty ifIndex); if($indexes.Count){Get-NetRoute -PolicyStore ActiveStore -ErrorAction SilentlyContinue | Where-Object {$indexes -contains $_.InterfaceIndex} | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue}; Clear-DnsClientCache -ErrorAction SilentlyContinue");
    log('Rotas antigas do OpenVPN removidas.');
  } catch (error) {
    log(`Limpeza de rede: ${error.message}`);
  }
}

async function stopVpn() {
  if (connectionTimer) clearTimeout(connectionTimer);
  connectionTimer = null;
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
  await removeRoutes();
  if (vpnProcess) {
    const processToStop = vpnProcess;
    vpnProcess = null;
    processToStop.kill();
    await wait(1200);
  }
  await cleanupOpenVpnNetworkState();
  vpnInterface = '';
  vpnGateway = '';
  vpnClientIp = '';
  discordLogPosition = 0;
  send('state', { state: 'idle', message: 'Desconectado' });
}

ipcMain.handle('system-info', async () => ({ openVpn: findOpenVpn(), discord: await findDiscord(), selectedServer: selectedServer?.id || '', version: app.getVersion() }));
ipcMain.handle('check-update', async () => {
  if (!app.isPackaged) return { message: 'Atualizações automáticas disponíveis apenas na versão instalada.' };
  if (updateReady) return { message: 'Atualização pronta para instalar.', ready: true };
  await autoUpdater.checkForUpdates();
  return { message: 'Verificação iniciada.' };
});
ipcMain.handle('install-update', async () => {
  if (!updateReady) throw new Error('Nenhuma atualização foi baixada ainda.');
  await stopVpn();
  autoUpdater.quitAndInstall(false, true);
});
ipcMain.handle('list-servers', async () => {
  const servers = await fetchCanadaServers();
  global.availableServers = new Map(servers.map(server => [server.id, server]));
  return servers.map(({ config, ...server }) => server);
});
ipcMain.handle('select-server', (_, id) => {
  selectedServer = global.availableServers?.get(id) || null;
  if (!selectedServer) throw new Error('Servidor não encontrado. Atualize a lista.');
  return { id: selectedServer.id, hostName: selectedServer.hostName };
});
ipcMain.handle('connect', async (_, options = {}) => {
  const fullTunnel = false;
  const openVpn = await ensureOpenVpn();
  const discord = await findDiscord();
  if (!discord) throw new Error('Discord não encontrado. Instale a versão desktop.');
  if (!selectedServer) throw new Error('Selecione um servidor no Canadá.');
  await stopVpn();
  const initialRouteIps = await resolveCompatibilityIps();
  const available = [...(global.availableServers?.values() || [])];
  const udp = available.filter(server => server.protocol === 'udp' && server.id !== selectedServer.id);
  const tcp = available.filter(server => server.protocol !== 'udp' && server.id !== selectedServer.id);
  const candidates = [selectedServer, ...udp, ...tcp].filter((server, index, list) => index === list.findIndex(item => item.id === server.id)).slice(0, 5);
  let connectedServer = null;
  for (let index = 0; index < candidates.length; index++) {
    try {
      connectedServer = await tryVpnServer(openVpn, candidates[index], initialRouteIps, fullTunnel, index + 1, candidates.length);
      log(`Túnel canadense conectado: ${connectedServer.hostName}`);
      break;
    } catch (error) {
      log(`${candidates[index].hostName} indisponível: ${error.message}`);
    }
  }
  if (!connectedServer) {
    send('state', { state: 'idle', message: 'Nenhum servidor respondeu' });
    throw new Error('Os servidores canadenses testados estão indisponíveis. Atualize a lista e tente novamente.');
  }
  selectedServer = connectedServer;
  send('stats', { routes: initialRouteIps.length, fullTunnel });
  try {
    await ps("Get-Process Discord -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0");
  } catch (error) {
    log(`Aviso ao reiniciar Discord: ${error.message}`);
  }
  const discordLog = path.join(process.env.APPDATA || '', 'discord', 'logs', 'renderer_js.log');
  // Seed recently used media IPs, but never the *.discord.media WebSocket
  // hosts. This gives UDP voice/video a route before the first media packet.
  discordLogPosition = fs.existsSync(discordLog) ? Math.max(0, fs.statSync(discordLog).size - 512 * 1024) : 0;
  spawn(discord, [], { detached: true, stdio: 'ignore' }).unref();
  await monitorDiscordRoutes();
  monitorTimer = setInterval(() => monitorDiscordRoutes().catch(error => log(`Monitor do Discord: ${error.message}`)), 250);
  send('state', { state: 'connected', message: `Discord pelo Canadá — ${connectedServer.hostName}` });
  return true;
});
ipcMain.handle('disconnect', stopVpn);
ipcMain.handle('open-share-page', () => shell.openExternal('https://andredllgnl5-eng.github.io/discvpn/share.html'));

app.whenReady().then(() => {
  createWindow();
  if (app.isPackaged) setInterval(() => {
    if (!updateReady) autoUpdater.checkForUpdates().catch(error => log(`Atualização periódica: ${error.message}`));
  }, 60 * 60 * 1000);
});
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.on('update-available', info => send('update', { message: `Atualização ${info.version} encontrada; baixando…` }));
autoUpdater.on('update-not-available', () => send('update', { message: 'Você já está na versão mais recente.' }));
autoUpdater.on('update-downloaded', info => { updateReady = true; send('update', { message: `Versão ${info.version} pronta. Instale agora ou feche o aplicativo.`, ready: true }); });
autoUpdater.on('error', error => { log(`Atualizador: ${error.message}`); send('update', { message: `Falha ao atualizar: ${error.message}` }); });
app.on('before-quit', () => stopVpn());
app.on('window-all-closed', () => app.quit());
