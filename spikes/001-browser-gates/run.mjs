import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, writeFile, stat, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';


const root = path.dirname(new URL(import.meta.url).pathname);
await access(path.join(root, 'extension/manifest.json'));
const browsers = {
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
};
const results = [];
const scratch = '/Users/philiprichard/.hermes/cache/scratch';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function memory(cdp) {
  const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
  const pids = processInfo.map(p => p.id).join(',');
  const samples = execFileSync('/bin/ps', ['-o', 'pid=,rss=', '-p', pids], { encoding: 'utf8' }).trim().split('\n');
  return samples.map(line => {
    const [pid, kib] = line.trim().split(/\s+/).map(Number);
    return { pid, rss: kib * 1024, type: processInfo.find(p => p.id === pid)?.type };
  });
}
await mkdir(path.join(root, 'evidence'), { recursive: true });
for (const [name, executablePath] of Object.entries(browsers)) {
  if (process.env.LMD_BROWSER && process.env.LMD_BROWSER !== name) continue;
  const profile = await mkdtemp(path.join(scratch, `lmd-gate-${name}-`));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath, headless: process.env.LMD_HEADED !== '1', timeout: 25000,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging', '--no-first-run'],
      acceptDownloads: true,
    });
    const browser = context.browser();
    const cdp = await browser.newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: path.join(root, 'extension') });
    let page = await context.newPage();
    await page.goto(`chrome-extension://${id}/control.html`);
    const state = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'GATE_PING' }));
    assert.equal(state.ok, true);
    results.push({ browser: name, version: browser.version(), gate: 'installation', status: 'passed', id, profile });
    console.log(JSON.stringify(results.at(-1)));
    let downloadPath = await mkdtemp(path.join(scratch, `lmd-export-${name}-`));
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath, eventsEnabled: true });
    const sizes = process.env.LMD_LARGE === '1' ? [256, 2048] : [64];
    for (const mib of sizes) {
      const size = mib * 1024 * 1024;
      const idleMemory = await memory(cdp);
      const started = await page.evaluate(({ size, delay }) => chrome.runtime.sendMessage({ type: 'GATE_START', size, delay }), { size, delay: mib === 64 ? 150 : 10 });
      assert.equal(started?.ok, true, JSON.stringify(started));
      await sleep(500);
      const session = await context.newCDPSession(page);
      await session.send('ServiceWorker.enable');
      await session.send('ServiceWorker.stopAllWorkers');
      await page.close();
      const stopped = await cdp.send('Target.getTargets');
      assert(!stopped.targetInfos.some(t => t.type === 'service_worker' && t.url.includes(id)), 'SW must actually stop');
      const rss = [];
      let output;
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        rss.push(await memory(cdp));
        try {
          for (const entry of await readdir(downloadPath)) {
            if (entry.endsWith('.crdownload')) continue;
            const candidate = path.join(downloadPath, entry);
            if ((await stat(candidate)).size === size) output = candidate;
          }
          if (output) break;
        } catch { /* not exported yet */ }
        await sleep(250);
      }
      const check = await context.newPage();
      await check.goto(`chrome-extension://${id}/control.html`);
      console.log('OPFS status', await check.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        try { return await (await (await root.getFileHandle('status.json')).getFile()).text(); }
        catch (e) { return String(e); }
      }));
      const downloads = await check.evaluate(() => chrome.downloads.search({}));
      console.log('downloads', JSON.stringify(downloads));
      assert(output, 'disk export must finish with popup/manager closed and SW stopped');
      assert(downloads.some(d => d.state === 'complete' && d.fileSize === size), 'Downloads must confirm completion');
      const expected = createHash('sha256');
      const block = Buffer.alloc(1024 * 1024);
      for (let i = 0; i < block.length; i++) block[i] = i % 251;
      for (let i = 0; i < mib; i++) expected.update(block);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(output)) hash.update(chunk);
      const sha256 = hash.digest('hex');
      assert.equal(sha256, expected.digest('hex'));
      const idleTotal = idleMemory.reduce((s, p) => s + p.rss, 0);
      const peakTotal = Math.max(...rss.map(sample => sample.reduce((s, p) => s + p.rss, 0)));
      results.push({ browser: name, gate: 'offscreen-opfs-export-sw-stop', status: 'passed', mib, sha256, output, idleTotal, peakTotal, deltaTotal: peakTotal - idleTotal, idleMemory, rssSamples: rss, profile });
      console.log(JSON.stringify({ ...results.at(-1), rssSamples: undefined }));
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath, eventsEnabled: true });
      if (mib !== sizes.at(-1)) {
        await check.evaluate(async () => { const root = await navigator.storage.getDirectory(); await root.removeEntry('output.bin'); });
      }
      // A new browser download uniquifies names, so use a fresh directory.
      if (mib !== sizes.at(-1)) {
        downloadPath = await mkdtemp(path.join(scratch, `lmd-export-${name}-next-`));
        await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath, eventsEnabled: true });
      }
      // Reuse a surviving control tab only to dispatch the next experiment.
      page = check;
    }
  } catch (error) {
    results.push({ browser: name, status: 'failed', error: String(error), profile });
    console.error(String(error));
  } finally { await context?.close(); }
}
await writeFile(path.join(root, `evidence/browser-results-${process.env.LMD_LARGE === '1' ? 'large' : 'small'}.json`), JSON.stringify(results, null, 2));
assert(results.length > 0 && results.every(r => r.status === 'passed'), 'Browser gates must pass in selected browsers');
