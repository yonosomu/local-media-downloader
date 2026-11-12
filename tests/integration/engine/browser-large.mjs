import { chromium } from 'playwright';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, writeFile, stat, statfs, unlink, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = process.cwd(), scratch = path.join(root, '.test-data/engine-large'), evidence = path.join(root, 'docs/evidence/t_d2d10038');
await mkdir(scratch, { recursive: true }); await mkdir(evidence, { recursive: true });
const extension = path.join(scratch, 'extension'); await mkdir(extension, { recursive: true });
await build({ entryPoints: ['tests/integration/engine/browser-entry.ts'], outfile: path.join(extension, 'entry.js'), bundle: true, format: 'esm', target: 'chrome120' });
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Engine large component', version: '0.0.1', host_permissions: ['http://127.0.0.1/*'] }));
await writeFile(path.join(extension, 'index.html'), '<!doctype html><meta charset="utf-8"><script type="module" src="entry.js"></script>');
const video = path.join(root, 'spikes/002-remux-browser/extension/large-video.mp4'), audio = path.join(root, 'spikes/002-remux-browser/extension/audio.m4a');
const pairBytes = (await stat(video)).size + (await stat(audio)).size;
const sizes = (process.env.LMD_ENGINE_SIZES ?? '256,2048').split(',').map(Number);
assert(sizes.length && sizes.every(s => [256, 2048].includes(s)));
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1'), size = Number(url.searchParams.get('size'));
    if (url.pathname.endsWith('.m3u8')) {
      assert(sizes.includes(size)); const count = Math.ceil(size * 1024 ** 2 / pairBytes);
      const body = url.pathname === '/master.m3u8' ? `#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",URI="audio.m3u8?size=${size}"\n#EXT-X-STREAM-INF:BANDWIDTH=9000000,CODECS="avc1.42c01f,mp4a.40.2",AUDIO="a"\nvideo.m3u8?size=${size}\n` : '#EXTM3U\n' + Array.from({ length: count }, (_, i) => `#EXTINF:4,\n${url.pathname === '/video.m3u8' ? 'video.mp4' : 'audio.m4a'}?segment=${i}\n`).join('') + '#EXT-X-ENDLIST\n';
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end(body); return;
    }
    const file = url.pathname === '/video.mp4' ? video : url.pathname === '/audio.m4a' ? audio : url.pathname === '/direct.mp4' && sizes.includes(size) ? path.join(root, `spikes/002-remux-browser/evidence/chrome-${size}MiB.mp4`) : undefined;
    if (!file) { res.writeHead(404).end(); return; }
    const info = await stat(file), headers = { 'Content-Type': 'video/mp4', ETag: `"fixture-${info.size}"`, 'Accept-Ranges': 'bytes' };
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    if (range) { const start = Number(range[1]), end = Number(range[2]); assert(start <= end && end < info.size); res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 }); createReadStream(file, { start, end }).pipe(res); }
    else { res.writeHead(200, { ...headers, 'Content-Length': info.size }); createReadStream(file).pipe(res); }
  } catch { res.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const hash = async file => { const h = createHash('sha256'); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest('hex'); };
const results = [];
const browsers = { chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' };
try {
  for (const [browser, executablePath] of Object.entries(browsers).filter(([name]) => !process.env.LMD_ENGINE_BROWSER || name === process.env.LMD_ENGINE_BROWSER)) for (const size of sizes) for (const mode of ['direct', 'segmented']) {
    const disk = await statfs(root); assert(disk.bavail * disk.bsize > 8 * 1024 ** 3, 'Need 8 GiB free for serial large test');
    const profile = await mkdtemp(path.join(scratch, `${browser}-${size}-${mode}-`));
    const context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, timeout: 25000, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'], acceptDownloads: true, downloadsPath: path.join(profile, 'test-downloads') });
    const samples = []; let timer;
    try {
      const browserCdp = await context.browser().newBrowserCDPSession(), { id } = await browserCdp.send('Extensions.loadUnpacked', { path: extension });
      const page = await context.newPage(); await page.goto(`chrome-extension://${id}/index.html`); await page.waitForFunction(() => !!window.engineComponent);
      console.log('STORAGE', browser, size, mode, JSON.stringify(await page.evaluate(() => navigator.storage.estimate())));
      const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
      if (process.env.LMD_ENGINE_DEBUG) {
        await cdp.send('Debugger.enable'); await cdp.send('Debugger.setPauseOnExceptions', { state: 'all' });
        cdp.on('Debugger.paused', event => { console.log('EXCEPTION', event.data?.description); void cdp.send('Debugger.resume'); });
      }
      let sampling = false;
      const sample = async () => {
        if (sampling) return; sampling = true;
        try {
          const metrics = await cdp.send('Performance.getMetrics');
          const processes = await browserCdp.send('SystemInfo.getProcessInfo');
          const rss = processes.processInfo.map(p => { try { return { type: p.type, pid: p.id, kib: Number(execFileSync('ps', ['-o', 'rss=', '-p', String(p.id)], { encoding: 'utf8' }).trim()) || 0 }; } catch { return { type: p.type, pid: p.id, kib: 0 }; } });
          samples.push({ at: Date.now(), heap: metrics.metrics.find(m => m.name === 'JSHeapUsedSize')?.value, processes: rss, rssBytes: rss.reduce((n, p) => n + p.kib * 1024, 0) });
        } finally { sampling = false; }
      };
      await sample(); const idle = samples[0]; timer = setInterval(() => { void sample().catch(() => {}); }, 500);
      const started = Date.now(); console.log(`START ${browser} ${size} ${mode}`);
      const result = await page.evaluate(({ url, container }) => window.engineComponent.run(url, { audioOnly: false, subtitleTrackIds: [], container }, { timeoutMs: 480000 }), { url: `${origin}/${mode === 'direct' ? 'direct.mp4' : 'master.m3u8'}?size=${size}`, container: mode === 'direct' ? 'original' : 'mp4' });
      assert.equal(result.outputs.length, 1); assert.equal(result.job.state, 'awaiting_export');
      const outputRef = result.outputs[0], pending = page.waitForEvent('download', { timeout: 120000 }); pending.catch(() => {});
      await page.evaluate(token => window.engineComponent.download(token), outputRef.token); await page.locator('#component-download').click();
      const download = await pending, output = path.join(scratch, `${browser}-${size}-${mode}.mp4`);
      await download.saveAs(output); clearInterval(timer); await sample();
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', output], { encoding: 'utf8' }));
      const sha256 = await hash(output), bytes = (await stat(output)).size;
      const expectedDuration = mode === 'segmented' ? Math.ceil(size * 1024 ** 2 / pairBytes) * 4 : Number(JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', path.join(root, `spikes/002-remux-browser/evidence/chrome-${size}MiB.mp4`)], { encoding: 'utf8' })).format.duration);
      assert(Math.abs(Number(probe.format.duration) - expectedDuration) < 0.5);
      assert.equal(probe.streams.find(s => s.codec_type === 'video').codec_name, 'h264'); assert.equal(probe.streams.find(s => s.codec_type === 'audio').codec_name, 'aac');
      if (size === 2048) assert(bytes > 2 ** 31);
      if (mode === 'direct') assert.equal(sha256, await hash(path.join(root, `spikes/002-remux-browser/evidence/chrome-${size}MiB.mp4`)));
      execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', output, '-map', '0', '-c', 'copy', '-f', 'null', '-'], { stdio: 'pipe' });
      for (const at of [0, expectedDuration / 2, expectedDuration - 3]) execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-ss', String(at), '-i', output, '-t', '1', '-f', 'null', '-'], { stdio: 'pipe' });
      const heapDelta = Math.max(...samples.map(s => s.heap ?? 0)) - (idle.heap ?? 0), rssDelta = Math.max(...samples.map(s => s.rssBytes)) - idle.rssBytes;
      assert(heapDelta < 512 * 1024 ** 2, 'Extension JS heap exceeds 512 MiB delta');
      results.push({ browser, version: context.browser().version(), mode, sizeMiB: size, status: 'passed', bytes, sha256, duration: probe.format.duration, streams: probe.streams.map(s => ({ kind: s.codec_type, codec: s.codec_name })), elapsedMs: Date.now() - started, heapDelta, wholeBrowserRssDelta: rssDelta, samples, retained: false, verification: 'SHA256 direct; full demux and 3 decode/seek samples; NOT AV-marker or final product AT28' });
      console.log(JSON.stringify({ ...results.at(-1), samples: samples.length }));
      // Only this run's generated outputs are removed; historical evidence is untouched.
      await page.evaluate(token => window.engineComponent.release(token), outputRef.token); await page.evaluate(jobId => window.engineComponent.cleanup(jobId), result.job.id);
      await download.delete(); await unlink(output);
    } catch (error) { results.push({ browser, sizeMiB: size, mode, status: 'failed', error: String(error), samples }); console.error(String(error)); }
    finally {
      clearInterval(timer); await context.close();
      // Closed, per-case profiles contain only this harness's temporary files.
      await rm(profile, { recursive: true, force: true });
      await rm(path.join(scratch, `${browser}-${size}-${mode}.mp4`), { force: true });
      await writeFile(path.join(evidence, 'large-engine-results.json'), JSON.stringify(results, null, 2));
    }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
assert.equal(results.length, (process.env.LMD_ENGINE_BROWSER ? 2 : 4) * sizes.length); assert(results.every(r => r.status === 'passed'));
