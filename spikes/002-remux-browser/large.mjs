import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.dirname(new URL(import.meta.url).pathname);
await mkdir(path.join(root, 'evidence'), { recursive: true });
const delay = ms => new Promise(r => setTimeout(r, ms));
const results = [];
for (const [name, executablePath] of Object.entries({ chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' })) {
  const profile = await mkdtemp('/Users/philiprichard/.hermes/cache/scratch/lmd-large-mux-');
  const context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, timeout: 25000, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'], acceptDownloads: true });
  try {
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: path.join(root, 'extension') });
    for (const mib of [256, 2048]) {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${id}/index.html`);
      assert.equal(await page.evaluate(() => typeof window.runLargeMux), 'function', 'large segmented remux must exist');
      const getMemory = async () => {
        const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
        const data = execFileSync('/bin/ps', ['-o', 'pid=,rss=', '-p', processInfo.map(p => p.id).join(',')], { encoding: 'utf8' });
        return data.trim().split('\n').map(s => { const [pid, kib] = s.trim().split(/\s+/).map(Number); return { pid, rss: kib * 1024, type: processInfo.find(p => p.id === pid)?.type }; });
      };
      const idle = await getMemory();
      let download, failure;
      const downloadPromise = page.waitForEvent('download', { timeout: 600000 }).then(d => { download = d; }, e => { failure = e; });
      await page.evaluate(minBytes => { window.runLargeMux(minBytes).catch(e => { window.gateError = String(e); }); }, mib * 1024 * 1024);
      const samples = [];
      const deadline = Date.now() + 600000;
      while (!download && !failure && Date.now() < deadline) {
        samples.push(await getMemory());
        const error = await page.evaluate(() => window.gateError);
        if (error) throw new Error(error);
        await delay(400);
      }
      await downloadPromise;
      assert(download, String(failure));
      const output = path.join(root, `evidence/${name}-${mib}MiB.mp4`);
      await download.saveAs(output);
      assert((await stat(output)).size >= mib * 1024 * 1024);
      const total = sample => sample.reduce((s, p) => s + p.rss, 0);
      const idleTotal = total(idle), peakTotal = Math.max(...samples.map(total));
      const delta = peakTotal - idleTotal;
      assert(delta <= 512 * 1024 * 1024, `memory delta ${delta} exceeds 512 MiB`);
      const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { encoding: 'utf8' }));
      const duration = Number(info.format.duration);
      assert(info.streams.some(s => s.codec_name === 'h264') && info.streams.some(s => s.codec_name === 'aac'));
      const checks = [];
      for (const time of [0, duration / 2, Math.max(0, duration - 2)]) {
        const packets = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-read_intervals', `${time}%+1`, '-show_packets', '-show_entries', 'packet=codec_type,pts_time', '-of', 'json', output], { encoding: 'utf8' })).packets;
        const firstVideo = packets.find(p => p.codec_type === 'video');
        const firstAudio = packets.find(p => p.codec_type === 'audio');
        assert(firstVideo && firstAudio, 'both tracks must remain present at every sample');
        const avDelta = Math.abs(Number(firstVideo.pts_time) - Number(firstAudio.pts_time));
        assert(avDelta <= 0.1, `A/V sampled PTS delta ${avDelta}`);
        execFileSync('ffmpeg', ['-v', 'error', '-ss', `${time}`, '-i', output, '-t', '0.5', '-f', 'null', '-']);
        checks.push({ time, avDelta });
      }
      results.push({ browser: name, mib, status: 'passed', output, bytes: (await stat(output)).size, duration, checks, idleTotal, peakTotal, delta, idle, samples, profile });
      await writeFile(path.join(root, 'evidence/large-results.json'), JSON.stringify(results, null, 2));
      console.log(JSON.stringify({ ...results.at(-1), samples: undefined, idle: undefined }));
      await page.close();
    }
  } catch (e) { results.push({ browser: name, status: 'failed', error: String(e) }); console.error(String(e)); }
  finally { await context.close(); }
}
await writeFile(path.join(root, 'evidence/large-results.json'), JSON.stringify(results, null, 2));
assert(results.length === 4 && results.every(r => r.status === 'passed'));
