const { _electron: electron } = require('playwright-core');

(async () => {
  const exe = process.env.STREAM_TEST_EXE;
  const app = await electron.launch(exe ? { executablePath: exe, args: [] } : { args: ['.'], cwd: require('node:path').resolve(__dirname, '..') });
  try {
    const page = await app.firstWindow();
    page.on('dialog', dialog => dialog.dismiss());
    await page.waitForLoadState('domcontentloaded');
    const sources = await page.evaluate(() => window.vpn.captureSources());
    for (const source of sources) {
      const result = await page.evaluate(async sourceId => {
        try {
          const stream = await capture720p60(sourceId);
          const track = stream.getVideoTracks()[0];
          const settings = track?.getSettings();
          stream.getTracks().forEach(item => item.stop());
          return { ok: true, settings };
        } catch (error) { return { ok: false, name: error.name, message: error.message }; }
      }, source.id);
      console.log(JSON.stringify({ source: source.name, type: source.id.split(':')[0], ...result }));
    }
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
