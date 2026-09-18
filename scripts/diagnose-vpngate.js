const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const openVpn = 'C:\\Program Files\\OpenVPN\\bin\\openvpn.exe';
const work = path.join(os.tmpdir(), 'japan-discord-vpn-diagnostic');
fs.mkdirSync(work, { recursive: true });
fs.writeFileSync(path.join(work, 'auth.txt'), 'vpn\nvpn\n');

function csv(line) {
  const out = [];
  let value = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ',' && !quoted) { out.push(value); value = ''; }
    else value += line[i];
  }
  out.push(value);
  return out;
}

async function test(server, index) {
  let config = Buffer.from(server.config, 'base64').toString('utf8');
  config = config.replace(/^auth-user-pass.*$/m, `auth-user-pass "${path.join(work, 'auth.txt').replace(/\\/g, '\\\\')}"`);
  const file = path.join(work, `server-${index}.ovpn`);
  fs.writeFileSync(file, config);
  console.log(`TEST ${index + 1}: ${server.name} ${server.ip} ${config.match(/^proto .+$/m)?.[0]} ${config.match(/^remote .+$/m)?.[0]}`);
  await new Promise(resolve => {
    const routeArgs = (global.discordIps || []).flatMap(ip => ['--route', ip, '255.255.255.255', 'vpn_gateway']);
    const child = spawn(openVpn, ['--config', file, '--route-nopull', '--auth-nocache', '--connect-timeout', '6', '--connect-retry-max', '1', ...routeArgs], { windowsHide: true });
    let tail = '';
    const timer = setTimeout(() => { child.kill(); console.log('RESULT timeout'); resolve(); }, 14000);
    const output = data => {
      tail += data.toString();
      if (tail.includes('Initialization Sequence Completed')) {
        clearTimeout(timer); child.kill(); console.log('RESULT connected'); resolve();
      }
    };
    child.stdout.on('data', output);
    child.stderr.on('data', output);
    child.on('exit', code => {
      clearTimeout(timer);
      if (!tail.includes('Initialization Sequence Completed')) {
        const useful = tail.split(/\r?\n/).filter(x => /TCP\/UDP|AUTH_FAILED|TLS Error|fatal|Cannot|failed/i.test(x)).slice(-4);
        console.log(`RESULT exit ${code}: ${useful.join(' | ')}`);
      }
      resolve();
    });
  });
}

(async () => {
  global.discordIps = await require('node:dns').promises.resolve4('discord.com');
  const text = await (await fetch('https://www.vpngate.net/api/iphone/')).text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  const h = lines.findIndex(x => x.startsWith('#HostName,'));
  const headers = csv(lines[h]).map(x => x.replace(/^#/, ''));
  const servers = lines.slice(h + 1).filter(x => !x.startsWith('*')).map(csv)
    .map(row => Object.fromEntries(headers.map((key, i) => [key, row[i] || ''])))
    .filter(x => x.CountryShort === 'JP' && x.OpenVPN_ConfigData_Base64)
    .map(x => { const config = x.OpenVPN_ConfigData_Base64; const decoded = Buffer.from(config, 'base64').toString('utf8'); return { name: x.HostName, ip: x.IP, ping: Number(x.Ping) || 9999, protocol: /^proto\s+udp/mi.test(decoded) ? 'udp' : 'tcp', config }; })
    .sort((a, b) => (a.protocol === 'udp' ? 0 : 1) - (b.protocol === 'udp' ? 0 : 1) || a.ping - b.ping).slice(0, 5);
  for (let i = 0; i < servers.length; i++) await test(servers[i], i);
})().catch(error => { console.error(error); process.exitCode = 1; });
