const { _electron: electron } = require('playwright-core');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const app = await electron.launch({ args: ['.'], cwd: path.resolve(__dirname, '..') });
  const page = await app.firstWindow();
  const dialogs = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  page.on('console', message => console.log(`console:${message.type()}:${message.text()}`));
  await page.waitForLoadState('domcontentloaded');
  await page.locator('#share-screen').click();
  await page.locator('.source').first().waitFor({ state: 'visible', timeout: 15000 });
  const sources = await page.locator('.source').count();
  const sourceName = await page.locator('.source').first().innerText();
  await page.locator('.source').first().click();
  await page.waitForTimeout(7000);
  const result = await page.evaluate(() => ({
    state: document.querySelector('#share-state')?.textContent,
    link: document.querySelector('#share-link')?.value,
    liveVisible: !document.querySelector('#share-live')?.classList.contains('hidden'),
    buttonDisabled: document.querySelector('#share-screen')?.disabled
  }));
  const captureSettings = await page.evaluate(() => shareStream?.getVideoTracks?.()[0]?.getSettings?.() || {});
  let viewer = {};
  if (result.link) {
    const peerId = new URL(result.link).searchParams.get('watch');
    const viewerUrl = `${pathToFileURL(path.resolve(__dirname, '..', 'docs', 'index.html')).href}?watch=${encodeURIComponent(peerId)}`;
    const viewerPromise = app.waitForEvent('window');
    await app.evaluate(async ({ BrowserWindow }, url) => {
      const window = new BrowserWindow({ width: 1280, height: 800, show: true });
      await window.loadURL(url);
    }, viewerUrl);
    const viewerPage = await viewerPromise;
    await viewerPage.locator('#video').waitFor({ state: 'visible', timeout: 15000 });
    await viewerPage.waitForFunction(() => { const video = document.querySelector('#video'); return video?.srcObject && video.readyState >= 2 && video.videoWidth > 0; }, null, { timeout: 25000 });
    await viewerPage.waitForTimeout(6000);
    viewer = await viewerPage.evaluate(() => { const video = document.querySelector('#video'); return { status: document.querySelector('#status')?.textContent, readyState: video?.readyState, width: video?.videoWidth, height: video?.videoHeight }; });
  }
  console.log(JSON.stringify({ sources, sourceName, dialogs, ...result, captureSettings, viewer }));
  await page.locator('#stop-share').click().catch(() => {});
  await app.close();
  if (dialogs.length || !result.link || !/Ao vivo/.test(result.state || '') || !viewer.width) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
