const { _electron: electron, chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const docs = path.join(root, 'docs');
(async () => {
  let app, browser;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://local').pathname;
    const file = path.resolve(docs, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(docs + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
    res.end(fs.readFileSync(file));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const timer = setTimeout(() => { console.error('Native test timeout'); process.exit(1); }, 120000);
  try {
    const packaged = process.env.SCREEN_SHARE_EXECUTABLE;
    app = await electron.launch({ executablePath: packaged || path.join(root, 'node_modules/electron/dist/electron.exe'), args: packaged ? [] : [root] });
    const page = await app.firstWindow();
    page.on('pageerror', error => console.error('app:', error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) console.error('host console:', message.text()); });
    if (process.env.STREAM_PUBLIC !== '1') await page.route('https://andredllgnl5-eng.github.io/discvpn/network.json', route => route.fulfill({ contentType: 'application/json', body: fs.readFileSync(path.join(docs, 'network.json'), 'utf8') }));
    await page.waitForSelector('#start');
    await page.evaluate(() => {
      const Original = window.RTCPeerConnection;
      window.__debug = [];
      window.RTCPeerConnection = class extends Original {
        constructor(config, ...rest) {
          super(config, ...rest);
          window.__debug.push({ servers: config.iceServers.map(s => s.urls) });
          this.addEventListener('icecandidateerror', e => window.__debug.push({ error: e.errorCode, text: e.errorText, url: e.url }));
          this.addEventListener('icecandidate', e => { if (e.candidate) window.__debug.push({ candidate: e.candidate.type, protocol: e.candidate.protocol }); });
          this.addEventListener('connectionstatechange', () => window.__debug.push({ state: this.connectionState, ice: this.iceConnectionState }));
        }
      };
    });
    assert.equal(await page.title(), 'Screen Share');
    assert.equal(/VPN|Discord/.test(await page.locator('body').innerText()), false);
    await page.screenshot({ path: 'C:/Users/andre/Documents/Codex/2026-10-02/lem/outputs/screen-share.png', fullPage: true });
    await app.evaluate(async ({ BrowserWindow }) => {
      const source = new BrowserWindow({ width: 800, height: 500, title: 'Screen Share test source', webPreferences: { autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false } });
      await source.loadURL('data:text/html,<title>Screen Share test source</title><body style="background:%23243c88;color:white;font:32px Arial"><h1>Screen Share test source</h1><p id="clock"></p><script>setInterval(()=>document.getElementById("clock").textContent=Date.now(),33);const a=new AudioContext();const o=a.createOscillator();const g=a.createGain();g.gain.value=0.08;o.connect(g);g.connect(a.destination);o.start();a.resume();</script>');
    });
    await page.locator('#start').click();
    await page.getByRole('button', { name: 'Screen Share test source', exact: true }).click();
    try { await page.waitForFunction(() => document.querySelector('#link').value.includes('watch='), null, { timeout: 35000 }); }
    catch (error) { console.error('capture:', await page.locator('#status').innerText()); throw error; }
    await page.waitForFunction(() => document.querySelector('#audio-level').value > 0.005, null, { timeout: 15000 });
    const tracks = await page.locator('#video').evaluate(v => v.srcObject.getTracks().map(t => ({ kind: t.kind, live: t.readyState, label: t.label })));
    assert.equal(tracks.some(t => t.kind === 'audio' && t.live === 'live'), true);
    browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    const viewer = await browser.newPage();
    await viewer.addInitScript(() => {
      const Original = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Original { constructor(config, ...rest) { config.iceTransportPolicy = 'relay'; config.iceServers = config.iceServers.flatMap(s => { const urls = [s.urls].flat().filter(u => u.startsWith('turns:')); return urls.length ? [{ ...s, urls }] : []; }); super(config, ...rest); window.__connection = this; } };
    });
    const link = await page.locator('#link').inputValue();
    await viewer.goto(process.env.STREAM_PUBLIC === '1' ? link : base + new URL(link).search);
    try { await viewer.waitForFunction(() => !document.querySelector('#audio').disabled, null, { timeout: 35000 }); }
    catch (error) {
      console.error('native host:', await page.locator('#status').innerText(), 'viewer:', await viewer.locator('#status').innerText());
      console.error('native ICE:', await page.evaluate(() => window.__debug));
      console.error('host calls:', await page.evaluate(async () => Promise.all([...calls].map(async c => ({ state: c.peerConnection.connectionState, stats: [...(await c.peerConnection.getStats()).values()].filter(s => ['outbound-rtp', 'candidate-pair'].includes(s.type)) })))));
      throw error;
    }
    await viewer.locator('#audio').click();
    let received;
    for (let attempt = 0; attempt < 100; attempt++) {
      received = await viewer.evaluate(async () => {
      const s = await window.__connection.getStats();
      const energy = Math.max(...[...s.values()].filter(r => r.type === 'inbound-rtp' && r.kind === 'audio').map(r => r.totalAudioEnergy || 0));
      const frames = document.querySelector('video').getVideoPlaybackQuality().totalVideoFrames;
      return energy > 0.00001 && frames > 10 ? { energy, frames } : false;
      });
      if (received) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(received, 'O player deve receber energia de áudio real e quadros de vídeo.');
    console.log(JSON.stringify({ nativeCapture: tracks, received, audioMeter: await page.locator('#audio-level').evaluate(x => x.value), relayViewer: await viewer.evaluate(async () => {
      const stats = await window.__connection.getStats();
      const pair = [...stats.values()].find(s => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded');
      return { frames: document.querySelector('video').getVideoPlaybackQuality().totalVideoFrames, audioEnergy: Math.max(...[...stats.values()].filter(s => s.type === 'inbound-rtp' && s.kind === 'audio').map(s => s.totalAudioEnergy || 0)), candidate: stats.get(pair.localCandidateId).candidateType };
    }) }));
    await page.locator('#stop').click();
  } finally { clearTimeout(timer); await browser?.close(); await app?.close(); await new Promise(r => server.close(r)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
