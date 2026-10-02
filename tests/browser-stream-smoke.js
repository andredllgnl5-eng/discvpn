const { chromium } = require('playwright-core');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const docs = path.resolve(__dirname, '..', 'docs');
(async () => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(docs, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(docs + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json' : file.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
    res.end(fs.readFileSync(file));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = process.env.STREAM_PUBLIC === '1' ? 'https://andredllgnl5-eng.github.io/discvpn' : `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const timeout = setTimeout(() => { console.error('Overall test timeout'); process.exit(1); }, 150000);
  try {
    const ctx = await browser.newContext();
    await ctx.addInitScript(({ forceRelay, tlsOnly }) => {
      const Original = window.RTCPeerConnection;
      window.__connections = [];
      window.RTCPeerConnection = class extends Original {
        constructor(config, ...rest) {
          if (forceRelay) config.iceTransportPolicy = 'relay';
          if (tlsOnly) config.iceServers = config.iceServers.flatMap(server => {
            const urls = [server.urls].flat().filter(url => url.startsWith('turns:'));
            return urls.length ? [{ ...server, urls }] : [];
          });
          super(config, ...rest); window.__connections.push(this);
        }
      };
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
        const pen = canvas.getContext('2d');
        const timer = setInterval(() => { pen.fillStyle = '#263f91'; pen.fillRect(0, 0, 1280, 720); pen.fillStyle = 'white'; pen.font = '48px sans-serif'; pen.fillText(`Screen Share ${Date.now()}`, 40, 100); }, 33);
        const stream = canvas.captureStream(30);
        const audio = new AudioContext(); await audio.resume();
        const tone = audio.createOscillator(); const output = audio.createMediaStreamDestination();
        tone.connect(output); tone.start();
        if (!window.__withoutAudio) stream.addTrack(output.stream.getAudioTracks()[0]);
        window.__capture = stream;
        stream.getVideoTracks()[0].addEventListener('ended', () => { clearInterval(timer); audio.close(); });
        return stream;
      };
    }, { forceRelay: process.env.FORCE_RELAY === '1', tlsOnly: process.env.TLS_ONLY === '1' });
    const page = await ctx.newPage();
    page.on('pageerror', error => console.error('host error:', error.message));
    await page.goto(base + '/share.html');
    await page.evaluate(() => { window.__withoutAudio = true; });
    await page.locator('#start').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('áudio é obrigatório'));
    assert.equal(await page.locator('#link').inputValue(), '');
    assert.equal(await page.evaluate(() => window.__capture.getTracks().every(t => t.readyState === 'ended')), true);
    await page.evaluate(() => { window.__withoutAudio = false; });
    await page.locator('#start').click();
    await page.waitForFunction(() => document.querySelector('#link').value.includes('watch='), null, { timeout: 30000 });
    const link = await page.locator('#link').inputValue();
    const summaries = [];
    for (let i = 0; i < 2; i++) {
      const viewer = await ctx.newPage();
      viewer.on('pageerror', error => console.error('viewer error:', error.message));
      await viewer.goto(link);
      try { await viewer.waitForFunction(() => !document.querySelector('#audio').disabled, null, { timeout: 45000 }); }
      catch (error) { console.error('viewer status:', await viewer.locator('#status').innerText()); throw error; }
      await viewer.locator('#audio').click();
      await viewer.waitForFunction(() => document.querySelector('video').getVideoPlaybackQuality().totalVideoFrames > 10);
      let heard = false;
      for (let attempt = 0; attempt < 75; attempt++) {
        heard = await viewer.evaluate(async () => {
          const stats = await window.__connections.at(-1).getStats();
          return [...stats.values()].some(s => s.type === 'inbound-rtp' && s.kind === 'audio' && s.totalAudioEnergy > 0);
        });
        if (heard) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      assert.ok(heard, 'Player deve receber energia de áudio.');
      const summary = await viewer.evaluate(async () => {
        const stats = await window.__connections.at(-1).getStats();
        const pair = [...stats.values()].find(s => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded');
        const candidate = pair && stats.get(pair.localCandidateId);
        const audioEnergy = Math.max(...[...stats.values()].filter(s => s.type === 'inbound-rtp' && s.kind === 'audio').map(s => s.totalAudioEnergy || 0));
        const video = document.querySelector('video');
        return { frames: video.getVideoPlaybackQuality().totalVideoFrames, audioEnergy, muted: video.muted, candidate: candidate?.candidateType, relayProtocol: candidate?.relayProtocol };
      });
      assert.equal(summary.muted, false);
      if (process.env.FORCE_RELAY === '1') assert.equal(summary.candidate, 'relay');
      summaries.push(summary);
      if (i === 0) {
        await viewer.locator('#fullscreen').click();
        assert.equal(await viewer.evaluate(() => !!document.fullscreenElement), true);
      }
    }
    await page.waitForFunction(() => document.querySelector('#viewers').textContent === '2 espectadores');
    await page.evaluate(() => { const track = window.__capture.getAudioTracks()[0]; track.stop(); track.dispatchEvent(new Event('ended')); });
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('áudio foi interrompido'));
    assert.equal(await page.locator('#link').inputValue(), '');
    console.log(JSON.stringify({ passed: true, relay: process.env.FORCE_RELAY === '1', tlsOnly: process.env.TLS_ONLY === '1', noAudioRejected: true, audioLossStopsBroadcast: true, viewers: summaries }));
  } finally { clearTimeout(timeout); await browser.close(); await new Promise(r => server.close(r)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
