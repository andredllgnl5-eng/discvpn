const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const { autoUpdater } = require('electron-updater');

let win;
let vpnProcess = null;
let monitorTimer = null;
let selectedServer = null;
let vpnInterface = '';
let vpnGateway = '';
let vpnClientIp = '';
let connectionTimer = null;
let monitorBusy = false;
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
  const pageResponse = await fetch('https://www.vpnbook.com/freevpn/openvpn', { signal: AbortSignal.timeout(20000) });
  if (!pageResponse.ok) throw new Error(`VPNBook respondeu com HTTP ${pageResponse.status}.`);
  const page = await pageResponse.text();
  const password = /Password<\/label>[\s\S]{0,600}?<code[^>]*>([^<]+)<\/code>/i.exec(page)?.[1]?.trim();
  if (!password) throw new Error('Não foi possível obter a credencial atual do VPNBook.');
  const hosts = [
    { id: 'us16', name: 'Estados Unidos 1', host: 'us16.vpnbook.com', ip: '147.135.15.16', country: 'US' },
    { id: 'us178', name: 'Estados Unidos 2', host: 'us178.vpnbook.com', ip: '147.135.37.178', country: 'US' },
    { id: 'ca149', name: 'Canadá 1', host: 'ca149.vpnbook.com', ip: '144.217.253.149', country: 'CA' },
    { id: 'ca196', name: 'Canadá 2', host: 'ca196.vpnbook.com', ip: '142.4.216.196', country: 'CA' }
  ];
  const protocols = [
    { id: 'udp25000', label: 'UDP rápido', protocol: 'udp' },
    { id: 'udp53', label: 'UDP alternativo', protocol: 'udp' },
    { id: 'tcp443', label: 'TCP compatível', protocol: 'tcp' }
  ];
  const servers = (await Promise.all(hosts.flatMap(host => protocols.map(async profile => {
    try {
      const url = `https://www.vpnbook.com/api/openvpn?hostname=${host.host}&protocol=${profile.id}&ip=${host.ip}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) return null;
      const config = Buffer.from(await response.arrayBuffer()).toString('base64');
      return { id: `${host.id}-${profile.id}`, hostName: `${host.name} · ${profile.label}`, ip: host.ip, protocol: profile.protocol, provider: 'VPNBook', ping: 0, speedMbps: 0, sessions: 0, score: 0, username: 'vpnbook', password, config };
    } catch { return null; }
  })))).filter(Boolean);
  try {
    const gateResponse = await fetch('https://www.vpngate.net/api/iphone/', { signal: AbortSignal.timeout(25000) });
    if (gateResponse.ok) {
      const lines = (await gateResponse.text()).split(/\r?\n/).filter(Boolean);
      const headerIndex = lines.findIndex(line => line.startsWith('#HostName,'));
      if (headerIndex >= 0) {
        const headers = parseCsvLine(lines[headerIndex]).map(value => value.replace(/^#/, ''));
        const gateServers = lines.slice(headerIndex + 1).filter(line => !line.startsWith('*')).map(parseCsvLine)
          .map(row => Object.fromEntries(headers.map((key, index) => [key, row[index] || ''])))
          .filter(row => ['US', 'CA'].includes(row.CountryShort) && row.OpenVPN_ConfigData_Base64)
          .map((row, index) => {
            const decoded = Buffer.from(row.OpenVPN_ConfigData_Base64, 'base64').toString('utf8');
            const protocol = /^proto\s+(udp|tcp)/mi.exec(decoded)?.[1]?.toLowerCase() || 'tcp';
            const country = row.CountryShort === 'CA' ? 'Canadá' : 'Estados Unidos';
            return { id: `vpngate-${row.IP}-${index}`, hostName: `${country} · VPN Gate ${protocol.toUpperCase()}`, ip: row.IP, protocol, provider: 'VPN Gate', ping: Number(row.Ping) || 9999, speedMbps: Math.round((Number(row.Speed) || 0) / 100000) / 10, sessions: Number(row.NumVpnSessions) || 0, score: Number(row.Score) || 0, username: 'vpn', password: 'vpn', config: row.OpenVPN_ConfigData_Base64 };
          })
          .sort((a, b) => (a.protocol === 'udp' ? 0 : 1) - (b.protocol === 'udp' ? 0 : 1) || a.ping - b.ping)
          .slice(0, 12);
        servers.unshift(...gateServers);
      }
    }
  } catch (error) { log(`VPN Gate: ${error.message}`); }
  if (!servers.length) throw new Error('Nenhum servidor da América do Norte respondeu.');
  return servers;
}

function prepareServerConfig(server) {
  const dir = path.join(app.getPath('userData'), 'runtime');
  fs.mkdirSync(dir, { recursive: true });
  const authPath = path.join(dir, 'auth.txt');
  const configPath = path.join(dir, 'selected-japan-server.ovpn');
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
        send('state', { state: 'connecting', message: `Reconectando à América do Norte — ${server.hostName}…` });
      }
      if (connected && line.includes('Initialization Sequence Completed')) {
        send('state', { state: 'connected', message: `Discord pela América do Norte — ${server.hostName}` });
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
  const hosts = ['discord.com', 'discord.gg', 'gateway.discord.gg', 'cdn.discordapp.com', 'media.discordapp.net', 'discordapp.com', 'latency.discord.media'];
  const found = new Set();
  try {
    const raw = await ps(`$hosts=@(${hosts.map(x => `'${x}'`).join(',')}); foreach($h in $hosts){[System.Net.Dns]::GetHostAddresses($h) | Where-Object {$_.AddressFamily -eq 'InterNetwork'} | ForEach-Object {$_.IPAddressToString}}`);
    raw.split(/\r?\n/).map(x => x.trim()).filter(x => /^\d+\.\d+\.\d+\.\d+$/.test(x)).forEach(ip => found.add(ip));
  } catch (error) { log(`DNS do Windows: ${error.message}`); }
  if (!found.size) {
    for (const host of hosts) {
      try {
        const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, {
          headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000)
        });
        const data = await response.json();
        for (const answer of data.Answer || []) if (/^\d+\.\d+\.\d+\.\d+$/.test(answer.data)) found.add(answer.data);
      } catch {}
    }
  }
  return [...found];
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

async function verifyNorthAmericaExit() {
  const services = [
    ['https://ipapi.co/json/', data => data.country_code],
    ['https://ipwho.is/', data => data.country_code]
  ];
  for (const [url, getCountry] of services) {
    try {
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      const country = String(getCountry(data) || '').toUpperCase();
      if (country) return { valid: ['US', 'CA'].includes(country), country, ip: data.ip || '' };
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
    if (app.isPackaged) autoUpdater.checkForUpdatesAndNotify().catch(error => send('log', `Atualização: ${error.message}`));
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
    const content = fs.readFileSync(discordLog, 'utf8').slice(-2 * 1024 * 1024);
    const ips = new Set();
    for (const match of content.matchAll(/(?:RTC connected to media server:|Creating connection to)\s+(\d+\.\d+\.\d+\.\d+):\d+/gi)) ips.add(match[1]);
    const hosts = [...content.matchAll(/wss:\/\/([a-z0-9.-]+\.discord\.media):\d+/gi)].map(match => match[1]);
    for (const host of [...new Set(hosts)].slice(-12)) {
      try { (await dns.resolve4(host)).forEach(ip => ips.add(ip)); } catch {}
    }
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
    await addDiscordRoutes();
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
ipcMain.handle('connect', async (_, options = {}) => {
  const fullTunnel = false;
  const openVpn = await ensureOpenVpn();
  const discord = await findDiscord();
  if (!discord) throw new Error('Discord não encontrado. Instale a versão desktop.');
  if (!selectedServer) throw new Error('Selecione um servidor dos Estados Unidos ou Canadá.');
  await stopVpn();
  const initialRouteIps = fullTunnel ? [] : await resolveDiscordIps();
  if (!fullTunnel && !initialRouteIps.length) throw new Error('Não foi possível resolver os endereços do Discord. Verifique o DNS e tente novamente.');
  const available = [...(global.availableServers?.values() || [])];
  const udp = available.filter(server => server.protocol === 'udp' && server.id !== selectedServer.id);
  const tcp = available.filter(server => server.protocol !== 'udp' && server.id !== selectedServer.id);
  const candidates = [selectedServer, ...udp, ...tcp].slice(0, 5);
  let connectedServer = null;
  for (let index = 0; index < candidates.length; index++) {
    try {
      connectedServer = await tryVpnServer(openVpn, candidates[index], initialRouteIps, fullTunnel, index + 1, candidates.length);
      if (fullTunnel) {
        send('state', { state: 'connecting', message: `Testando estabilidade — ${connectedServer.hostName}…` });
        await wait(1200);
        const quality = await testTunnelQuality();
        log(`Qualidade ${connectedServer.hostName}: ${quality.latency} ms, ${quality.loss}% de perda (${quality.replies}/${quality.sent})`);
        if (!quality.healthy) {
          const unstableProcess = vpnProcess;
          vpnProcess = null;
          if (unstableProcess && !unstableProcess.killed) unstableProcess.kill();
          connectedServer = null;
          await wait(1800);
          continue;
        }
        const exit = await verifyNorthAmericaExit();
        log(`Saída VPN: ${exit.ip || 'desconhecida'} (${exit.country || 'região desconhecida'})`);
        if (!exit.valid) {
          const invalidProcess = vpnProcess;
          vpnProcess = null;
          if (invalidProcess && !invalidProcess.killed) invalidProcess.kill();
          connectedServer = null;
          await wait(1800);
          continue;
        }
        send('state', { state: 'connecting', message: `Testando voz e transmissão — ${connectedServer.hostName}…` });
        const rtc = await verifyDiscordRtc();
        log(`Teste RTC ${connectedServer.hostName}: ${rtc.valid ? 'OK' : 'BLOQUEADO'} (${rtc.target})`);
        if (!rtc.valid) {
          const blockedProcess = vpnProcess;
          vpnProcess = null;
          if (blockedProcess && !blockedProcess.killed) blockedProcess.kill();
          connectedServer = null;
          await wait(1800);
          continue;
        }
      }
      break;
    } catch (error) {
      log(`${candidates[index].hostName} indisponível: ${error.message}`);
    }
  }
  if (!connectedServer) {
    send('state', { state: 'idle', message: 'Nenhum servidor respondeu' });
    throw new Error('Os servidores norte-americanos testados estão indisponíveis. Atualize a lista e tente novamente.');
  }
  selectedServer = connectedServer;
  send('stats', { routes: initialRouteIps.length, fullTunnel });
  try {
    await ps("Get-Process Discord -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; exit 0");
  } catch (error) {
    log(`Aviso ao reiniciar Discord: ${error.message}`);
  }
  spawn(discord, [], { detached: true, stdio: 'ignore' }).unref();
  await monitorDiscordRoutes();
  monitorTimer = setInterval(() => monitorDiscordRoutes().catch(error => log(`Monitor do Discord: ${error.message}`)), 1000);
  send('state', { state: 'connected', message: `Discord pela América do Norte — ${connectedServer.hostName}` });
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
