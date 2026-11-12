import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const evidence = path.join(root, 'docs/evidence/t_d2d10038');
const scratch = path.join(root, '.test-data/engine');
await mkdir(evidence, { recursive: true });
await mkdir(scratch, { recursive: true });
const results = [];
for (const [browser, executablePath] of Object.entries({ chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' })) {
  const profile = await mkdtemp(path.join(scratch, `${browser}-`));
  const context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, timeout: 25000, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'], acceptDownloads: true });
  try {
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: path.join(root, 'spikes/002-remux-browser/extension') });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/index.html`);
    const pending = page.waitForEvent('download', { timeout: 30000 });
    pending.catch(() => {});
    await page.evaluate(() => window.runMux());
    const output = path.join(evidence, `${browser}-gate.mp4`);
    await (await pending).saveAs(output);
    const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { encoding: 'utf8' }));
    assert.equal(info.streams.find(s => s.codec_type === 'video').codec_name, 'h264');
    assert.equal(info.streams.find(s => s.codec_type === 'audio').codec_name, 'aac');
    assert(Math.abs(Number(info.format.duration) - 4) < 0.5);
    execFileSync('ffmpeg', ['-v', 'error', '-i', output, '-f', 'null', '-']);
    results.push({ browser, version: context.browser().version(), status: 'passed', output, info });
  } catch (error) {
    results.push({ browser, status: 'failed', message: String(error) });
  } finally { await context.close(); }
}
await writeFile(path.join(evidence, 'small-gate.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results.map(({ browser, status }) => ({ browser, status }))));
assert(results.length === 2 && results.every(r => r.status === 'passed'));
