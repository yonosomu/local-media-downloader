import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.dirname(new URL(import.meta.url).pathname);
await access(path.join(root, 'extension/mux.js'));
await mkdir(path.join(root, 'evidence'), { recursive: true });
function probe(file) { return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { encoding: 'utf8' })); }
const results = [];
for (const [name, executablePath] of Object.entries({ chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' })) {
  const profile = await mkdtemp('/Users/philiprichard/.hermes/cache/scratch/lmd-mux-');
  const context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, timeout: 25000, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'], acceptDownloads: true });
  try {
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: path.join(root, 'extension') });
    const page = await context.newPage();
    page.on('pageerror', e => console.error('pageerror', e.message));
    await page.goto(`chrome-extension://${id}/index.html`);
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    downloadPromise.catch(() => {});
    await page.evaluate(() => window.runMux());
    const download = await downloadPromise;
    const output = path.join(root, `evidence/${name}-mux.mp4`);
    await download.saveAs(output);
    const info = probe(output);
    const video = info.streams.find(s => s.codec_type === 'video');
    const audio = info.streams.find(s => s.codec_type === 'audio');
    assert.equal(video.codec_name, 'h264'); assert.equal(audio.codec_name, 'aac');
    assert.equal(audio.tags.language, 'rus');
    assert(Math.abs(Number(info.format.duration) - 4) <= 0.5);
    // Compare packet timestamps independently against original separated inputs.
    const packets = file => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_packets', '-show_entries', 'packet=codec_type,pts_time', '-of', 'json', file], { encoding: 'utf8' })).packets;
    const actual = packets(output);
    for (const [kind, input] of [['video', 'video.mp4'], ['audio', 'audio.m4a']]) {
      const source = packets(path.join(root, 'extension', input)).filter(p => p.codec_type === kind);
      const target = actual.filter(p => p.codec_type === kind);
      assert.equal(target.length, source.length);
      for (let i = 0; i < target.length; i++) assert(Math.abs(Number(target[i].pts_time) - Number(source[i].pts_time)) < 0.001, `${kind} PTS ${i}`);
    }
    execFileSync('ffmpeg', ['-v', 'error', '-i', output, '-f', 'null', '-']);
    const playback = await page.evaluate(async () => {
      const video = document.querySelector('video');
      const root = await navigator.storage.getDirectory();
      video.src = URL.createObjectURL(await (await root.getFileHandle('mux.mp4')).getFile());
      video.muted = true;
      await video.play();
      await new Promise((resolve, reject) => { video.onended = resolve; video.onerror = () => reject(new Error('playback failed')); setTimeout(() => reject(new Error('playback timeout')), 12000); });
      video.currentTime = 2;
      await new Promise(resolve => { video.onseeked = resolve; });
      return { duration: video.duration, currentTime: video.currentTime, width: video.videoWidth };
    });
    assert.equal(playback.width, 320); assert(Math.abs(playback.currentTime - 2) < 0.1);
    results.push({ browser: name, status: 'passed', output, playback, info, profile });
    console.log(JSON.stringify({ browser: name, status: 'passed', output, playback }));
  } catch (e) { results.push({ browser: name, status: 'failed', error: String(e) }); console.error(String(e)); }
  finally { await context.close(); }
}
await writeFile(path.join(root, 'evidence/results.json'), JSON.stringify(results, null, 2));
assert(results.length === 2 && results.every(r => r.status === 'passed'));
