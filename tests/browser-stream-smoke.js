const { chromium } = require('playwright-core');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const docs = path.resolve(__dirname, '..', 'docs');

(async () => {
  const server = http.createServer((request, response) => {
    const file = request.url?.startsWith('/share.js') ? 'share.js' : request.url?.startsWith('/share.html') ? 'share.html' : 'index.html';
    response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8');
    response.end(fs.readFileSync(path.join(docs, file)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: false, args: ['--auto-select-desktop-capture-source=Entire screen', '--allow-http-screen-capture'] });
    const context = await browser.newContext();
    await context.addInitScript(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
        const ctx = canvas.getContext('2d');
        setInterval(() => { ctx.fillStyle = '#174aa5'; ctx.fillRect(0, 0, 1280, 720); ctx.fillStyle = 'white'; ctx.font = '48px sans-serif'; ctx.fillText(String(Date.now()), 40, 80); }, 16);
        return canvas.captureStream(60);
      };
    });
    const page = await context.newPage();
    page.on('console', message => console.log(`share:${message.type()}:${message.text()}`));
    await page.goto(`${base}/share.html`);
    await page.locator('#start').click();
    try { await page.waitForFunction(() => document.querySelector('#link')?.value.includes('watch='), null, { timeout: 25000 }); }
    catch (error) { console.log('share-status:', await page.locator('#status').textContent()); throw error; }
    const link = await page.locator('#link').inputValue();
    const viewer = await context.newPage();
    await viewer.goto(link);
    await viewer.waitForFunction(() => { const video = document.querySelector('#video'); return video?.readyState >= 2 && video.videoWidth > 0; }, null, { timeout: 25000 });
    const result = await viewer.evaluate(() => ({ width: document.querySelector('#video').videoWidth, height: document.querySelector('#video').videoHeight, status: document.querySelector('#status').textContent }));
    console.log(JSON.stringify({ share: await page.locator('#status').textContent(), link, viewer: result }));
    await page.locator('#stop').click();
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
