import { chromium } from 'playwright';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = process.cwd(), scratch = path.join(root, '.test-data/engine-component'), evidence = path.join(root, 'docs/evidence/t_d2d10038');
await mkdir(scratch, { recursive: true }); await mkdir(evidence, { recursive: true });
const media = path.join(scratch, 'media'), extension = path.join(scratch, 'extension');
await mkdir(media, { recursive: true }); await mkdir(extension, { recursive: true });
const ffmpeg = args => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'pipe' });
ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-c:a', 'aac', '-shortest', path.join(media, 'source.mp4')]);
ffmpeg(['-i', path.join(media, 'source.mp4'), '-c', 'copy', '-hls_time', '2', '-hls_segment_filename', path.join(media, 'ts-%d.ts'), path.join(media, 'ts.m3u8')]);
ffmpeg(['-i', path.join(media, 'source.mp4'), '-c', 'copy', '-hls_time', '2', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', path.join(media, 'fmp4-%d.m4s'), path.join(media, 'fmp4.m3u8')]);
ffmpeg(['-i', path.join(media, 'source.mp4'), '-c', 'copy', '-f', 'dash', '-seg_duration', '2', path.join(media, 'dash.mpd')]);
ffmpeg(['-i', path.join(media, 'source.mp4'), '-vn', '-c:a', 'copy', path.join(media, 'audio.m4a')]);
ffmpeg(['-i', path.join(media, 'source.mp4'), '-vn', '-c:a', 'libmp3lame', path.join(media, 'audio.mp3')]);
ffmpeg(['-i', path.join(media, 'source.mp4'), '-vn', '-c:a', 'pcm_s16le', path.join(media, 'audio.wav')]);
ffmpeg(['-i', path.join(media, 'source.mp4'), '-vn', '-c:a', 'libopus', path.join(media, 'audio.ogg')]);
ffmpeg(['-i', path.join(media, 'source.mp4'), '-c', 'copy', path.join(media, 'source.mkv')]);
ffmpeg(['-i', path.join(media, 'source.mp4'), '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', path.join(media, 'source.webm')]);
await writeFile(path.join(media, 'audio.m3u8'), '#EXTM3U\n#EXTINF:4,\naudio.m4a\n#EXT-X-ENDLIST\n');
await writeFile(path.join(media, 'video.m3u8'), '#EXTM3U\n#EXTINF:4,\nsource.mp4\n#EXT-X-ENDLIST\n');
ffmpeg(['-i', path.join(media, 'audio.m4a'), '-c', 'copy', '-output_ts_offset', '0.3', path.join(media, 'delayed.m4a')]);
await writeFile(path.join(media, 'delayed.m3u8'), '#EXTM3U\n#EXTINF:4,\ndelayed.m4a\n#EXT-X-ENDLIST\n');
await writeFile(path.join(media, 'mp3.m3u8'), '#EXTM3U\n#EXTINF:4,\naudio.mp3\n#EXT-X-ENDLIST\n');
await writeFile(path.join(media, 'webm.m3u8'), '#EXTM3U\n#EXTINF:4,\nsource.webm\n#EXT-X-ENDLIST\n');
// Distinct, reproducible range/List/Base/Period fixtures owned by this component suite.
const fmp4 = await readFile(path.join(media, 'fmp4.m3u8'), 'utf8');
const fragmentNames = [...fmp4.matchAll(/^(fmp4-\d+\.m4s)$/gm)].map(m => m[1]);
const initBytes = await readFile(path.join(media, 'init.mp4'));
const fragments = await Promise.all(fragmentNames.map(f => readFile(path.join(media, f))));
await writeFile(path.join(media, 'range.mp4'), Buffer.concat([initBytes, ...fragments]));
let rangeOffset = initBytes.length;
await writeFile(path.join(media, 'range.m3u8'), `#EXTM3U\n#EXT-X-MAP:URI="range.mp4",BYTERANGE="${initBytes.length}@0"\n` + fragments.map(f => { const offset = rangeOffset; rangeOffset += f.length; return `#EXTINF:2,\n#EXT-X-BYTERANGE:${f.length}@${offset}\nrange.mp4\n`; }).join('') + '#EXT-X-ENDLIST\n');
ffmpeg(['-i', path.join(media, 'source.mp4'), '-c', 'copy', '-f', 'dash', '-single_file', '1', '-use_template', '0', '-use_timeline', '0', '-seg_duration', '2', path.join(media, 'list.mpd')]);
ffmpeg(['-i', path.join(media, 'source.mp4'), '-an', '-c:v', 'copy', '-movflags', '+dash+global_sidx+frag_keyframe', '-frag_duration', '2000000', path.join(media, 'base.mp4')]);
const baseBytes = await readFile(path.join(media, 'base.mp4'));
let indexOffset = 0, indexLength;
while (indexOffset + 8 < baseBytes.length) { const length = baseBytes.readUInt32BE(indexOffset); if (baseBytes.toString('ascii', indexOffset + 4, indexOffset + 8) === 'sidx') { indexLength = length; break; } assert(length >= 8); indexOffset += length; }
assert(indexLength);
await writeFile(path.join(media, 'base.mpd'), `<MPD mediaPresentationDuration="PT4S"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" codecs="avc1.42c00b"><BaseURL>base.mp4</BaseURL><SegmentBase indexRange="${indexOffset}-${indexOffset + indexLength - 1}"><Initialization range="0-${indexOffset - 1}"/></SegmentBase></Representation></AdaptationSet></Period></MPD>`);
const dash = await readFile(path.join(media, 'dash.mpd'), 'utf8');
const period = /<Period[\s\S]*?<\/Period>/.exec(dash)[0];
await writeFile(path.join(media, 'periods.mpd'), `<MPD mediaPresentationDuration="PT8S">${period.replace(/<Period[^>]*>/, '<Period id="p0" start="PT0S" duration="PT4S">')}${period.replace(/<Period[^>]*>/, '<Period id="p1" start="PT4S" duration="PT4S">')}</MPD>`);
await writeFile(path.join(media, 'discontinuity.m3u8'), '#EXTM3U\n#EXTINF:2,\nts-0.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:2,\nts-1.ts\n#EXT-X-ENDLIST\n');
await writeFile(path.join(media, 'live.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nts-0.ts\n#EXTINF:2,\nts-1.ts\n');
await writeFile(path.join(media, 'live.mpd'), dash.replace('type="static"', 'type="dynamic"').replace(/minimumUpdatePeriod="[^"]*"/, '').replace('<MPD ', '<MPD minimumUpdatePeriod="PT30S" '));
await writeFile(path.join(media, 'sub-0.vtt'), 'WEBVTT\n\n00:00.000 --> 00:01.000\nFirst\n');
await writeFile(path.join(media, 'sub-1.vtt'), 'WEBVTT\n\n00:00.000 --> 00:01.000\nSecond\n');
await writeFile(path.join(media, 'sub.m3u8'), '#EXTM3U\n#EXTINF:2,\nsub-0.vtt\n#EXTINF:2,\nsub-1.vtt\n#EXT-X-ENDLIST\n');
const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Russian",LANGUAGE="ru",URI="audio.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",URI="audio.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",LANGUAGE="en",URI="sub.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=300000,CODECS="avc1.42c00b,mp4a.40.2",AUDIO="a",SUBTITLES="s"\nts.m3u8\n';
await writeFile(path.join(media, 'master.m3u8'), master.replace('ts.m3u8', 'video.m3u8'));
await writeFile(path.join(media, 'delayed-master.m3u8'), master.replaceAll('audio.m3u8', 'delayed.m3u8').replace('ts.m3u8', 'video.m3u8'));
await writeFile(path.join(media, 'missing-sub.m3u8'), master.replace('sub.m3u8', 'missing.m3u8').replace('ts.m3u8', 'video.m3u8'));
ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-c:a', 'aac', '-shortest', '-f', 'mpegts', path.join(media, 'changed.ts')]);
await writeFile(path.join(media, 'changed.m3u8'), '#EXTM3U\n#EXTINF:2,\nts-0.ts\n#EXTINF:2,\nchanged.ts\n#EXT-X-ENDLIST\n');
await writeFile(path.join(media, 'text.ttml'), '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1s" end="2s">TTML fixture</p></div></body></tt>');
await writeFile(path.join(media, 'subtitles.mpd'), dash.replace('</Period>', '<AdaptationSet mimeType="application/ttml+xml" lang="ru"><Representation id="text" codecs="ttml"><BaseURL>text.ttml</BaseURL></Representation></AdaptationSet></Period>'));
await build({ entryPoints: [path.join(root, 'tests/integration/engine/browser-entry.ts')], outfile: path.join(extension, 'entry.js'), bundle: true, format: 'esm', target: 'chrome120' });
await writeFile(path.join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'LMD engine component', version: '0.0.1', host_permissions: ['http://127.0.0.1/*'] }));
await writeFile(path.join(extension, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Engine component</title><script type="module" src="entry.js"></script>');
const polls = new Map();
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname, file = path.join(media, pathname.slice(1));
    if (pathname === '/window.m3u8' || pathname === '/gap.m3u8') {
      const poll = (polls.get(pathname) ?? 0) + 1; polls.set(pathname, poll);
      const sequence = poll === 1 ? 0 : pathname === '/gap.m3u8' ? 2 : 1;
      const segments = poll === 1 ? '#EXTINF:2,\nts-0.ts\n' : '#EXTINF:2,\nts-1.ts\n';
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end(`#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n${segments}${poll > 2 ? '#EXT-X-ENDLIST\n' : ''}`); return;
    }
    if (pathname === '/window.mpd') {
      const poll = (polls.get(pathname) ?? 0) + 1; polls.set(pathname, poll);
      const index = poll === 1 ? 0 : 1;
      res.writeHead(200, { 'Content-Type': 'application/dash+xml' }).end(`<MPD type="${poll > 2 ? 'static' : 'dynamic'}" mediaPresentationDuration="PT4S" minimumUpdatePeriod="PT1S"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" codecs="avc1.42c00b"><SegmentTemplate startNumber="${index}" initialization="init.mp4" media="fmp4-$Number$.m4s"><SegmentTimeline><S t="${index * 2}" d="2"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>`); return;
    }
    if (!file.startsWith(media + '/')) { res.writeHead(403).end(); return; }
    const info = await stat(file); if (!info.isFile()) { res.writeHead(404).end(); return; }
    const type = file.endsWith('.mpd') ? 'application/dash+xml' : file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : file.endsWith('.m4a') ? 'audio/mp4' : 'application/octet-stream';
    const headers = { 'Content-Type': type, ETag: `"fixture-${info.size}"`, 'Accept-Ranges': 'bytes' };
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    if (range) { const start = Number(range[1]), end = Number(range[2]); if (end >= info.size) { res.writeHead(416).end(); return; } res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 }); createReadStream(file, { start, end }).pipe(res); }
    else { res.writeHead(200, { ...headers, 'Content-Length': info.size }); createReadStream(file).pipe(res); }
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const cases = [
  ...['source.mp4', 'source.webm', 'source.mkv', 'audio.mp3', 'audio.m4a', 'audio.ogg', 'audio.wav'].map(file => ({ id: `direct-${file}`, file, container: 'original', direct: true })),
  { id: 'hls-ts-mp4', file: 'ts.m3u8', container: 'mp4' }, { id: 'hls-fmp4-mp4', file: 'fmp4.m3u8', container: 'mp4' },
  { id: 'hls-ts-mkv', file: 'ts.m3u8', container: 'mkv' }, { id: 'dash-av-mp4', file: 'dash.mpd', container: 'mp4' },
  { id: 'aac-m4a', file: 'audio.m3u8', container: 'm4a', audioOnly: true }, { id: 'mp3-mp3', file: 'mp3.m3u8', container: 'mp3', audioOnly: true },
  { id: 'vp9-opus-webm', file: 'webm.m3u8', container: 'webm' },
  { id: 'hls-ranges', file: 'range.m3u8', container: 'mp4' }, { id: 'dash-list', file: 'list.mpd', container: 'mp4' },
  { id: 'dash-base-sidx', file: 'base.mpd', container: 'mp4' }, { id: 'dash-periods', file: 'periods.mpd', container: 'mp4', outputs: 2, duration: 8 },
  { id: 'hls-discontinuity', file: 'discontinuity.m3u8', container: 'mp4', outputs: 2 },
  { id: 'hls-live-stop', file: 'live.m3u8', container: 'mp4', stopAfterMs: 2300 },
  { id: 'dash-live-stop', file: 'live.mpd', container: 'mp4', stopAfterMs: 500 },
  { id: 'dash-live-duration-limit', file: 'live.mpd', container: 'mp4', liveMaxDurationSeconds: 1 },
  { id: 'hls-selected-audio-vtt', file: 'master.m3u8', container: 'mp4', audioTrackId: 'track-1', subtitles: ['track-2'], outputs: 2, language: 'eng' },
  { id: 'dash-ttml', file: 'subtitles.mpd', container: 'mp4', subtitles: ['text'], outputs: 2 },
  { id: 'hls-missing-subtitle-warning', file: 'missing-sub.m3u8', container: 'mp4', subtitles: ['track-2'], warning: 'SEGMENT_MISSING' },
  { id: 'hls-config-change', file: 'changed.m3u8', container: 'mp4', outputs: 2, warning: 'RESOURCE_CHANGED' },
  { id: 'hls-sliding-endlist', file: 'window.m3u8', container: 'mp4' },
  { id: 'hls-live-gap', file: 'gap.m3u8', container: 'mp4', warning: 'SEGMENT_MISSING' },
  { id: 'dash-sliding-end', file: 'window.mpd', container: 'mp4' },
  { id: 'hls-source-av-offset', file: 'delayed-master.m3u8', container: 'mp4', audioTrackId: 'track-1', avOffset: 0.3, duration: 4.3 },
];
const results = [];
try {
  for (const [browser, executablePath] of Object.entries({ chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' })) {
    polls.clear();
    const profile = await mkdtemp(path.join(scratch, `${browser}-`));
    const context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, timeout: 25000, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'], acceptDownloads: true, downloadsPath: path.join(profile, 'test-downloads') });
    try {
      const cdp = await context.browser().newBrowserCDPSession(), { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
      const page = await context.newPage(); page.on('pageerror', e => console.error('pageerror', e.message));
      await page.goto(`chrome-extension://${id}/index.html`); await page.waitForFunction(() => !!window.engineComponent);
      const store = await page.evaluate(() => window.engineComponent.storeChecks()); results.push({ browser, id: 'store-CAS-dedupe-epoch', status: 'passed', actual: store });
      const lifecycle = await page.evaluate(url => window.engineComponent.lifecycleChecks(url), `${origin}/ts.m3u8`);
      results.push({ browser, id: 'lifecycle-pause-resume-cancel-export', status: 'passed', actual: lifecycle });
      for (const c of cases) {
        try {
          const startedAt = Date.now();
          const result = await page.evaluate(({ url, selection, options }) => window.engineComponent.run(url, selection, options), { url: `${origin}/${c.file}`, selection: { audioOnly: c.audioOnly ?? false, subtitleTrackIds: c.subtitles ?? [], container: c.container, ...(c.audioTrackId ? { audioTrackId: c.audioTrackId } : {}) }, options: { stopAfterMs: c.stopAfterMs, liveMaxDurationSeconds: c.liveMaxDurationSeconds } });
          if (c.stopAfterMs || c.liveMaxDurationSeconds) assert(Date.now() - startedAt < 10000, 'Stop/limit did not interrupt live polling');
          assert.equal(result.job.state, 'awaiting_export'); assert.equal(result.outputs.length, c.outputs ?? 1);
          const revisions = result.events.filter(e => e.type === 'EXPORT_READY').map(e => e.revision);
          assert.equal(new Set(revisions).size, revisions.length, 'Export event revisions are not unique');
          if (c.warning) assert(result.job.warnings.some(w => w.code === c.warning));
          const saved = []; let totalDuration = 0;
          for (const [part, item] of result.outputs.entries()) {
          const pending = page.waitForEvent('download', { timeout: 10000 });
          pending.catch(() => {});
          await page.evaluate(token => window.engineComponent.download(token), item.token);
          await page.locator('#component-download').click();
          const output = path.join(evidence, `${browser}-${c.id}${c.outputs ? `-part${part + 1}` : ''}.${item.name.split('.').at(-1)}`); await (await pending).saveAs(output);
          await page.evaluate(token => window.engineComponent.release(token), item.token);

          if (/\.(?:vtt|ttml)$/.test(output)) {
            const text = await readFile(output, 'utf8');
            if (output.endsWith('.vtt')) { assert(text.startsWith('WEBVTT')); assert(text.includes('00:00:02.000 --> 00:00:03.000')); assert.equal(text.match(/Second/g).length, 1); }
            else assert(text.includes('TTML fixture'));
            saved.push({ output, subtitle: true, text }); continue;
          }
          const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', output], { encoding: 'utf8' }));
          execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', output, '-f', 'null', '-'], { stdio: 'pipe' });
          if (c.language) assert.equal(probe.streams.find(s => s.codec_type === 'audio').tags.language, c.language);
          if (c.avOffset) assert(Math.abs(Number(probe.streams.find(s => s.codec_type === 'audio').start_time) - Number(probe.streams.find(s => s.codec_type === 'video').start_time) - c.avOffset) < 0.05, 'Source A/V offset lost');
          totalDuration += Number(probe.format.duration);
          const sha256 = createHash('sha256').update(await readFile(output)).digest('hex');
          if (c.direct) assert.equal(sha256, createHash('sha256').update(await readFile(path.join(media, c.file))).digest('hex'));
          saved.push({ output, sha256, streams: probe.streams.map(s => ({ codec: s.codec_name, kind: s.codec_type, language: s.tags?.language })), duration: probe.format.duration, bytes: probe.format.size });
          }
          assert(Math.abs(totalDuration - (c.duration ?? 4)) < 0.5);
          results.push({ browser, id: c.id, status: 'passed', files: saved, totalDuration, warnings: result.job.warnings });
        } catch (error) { results.push({ browser, id: c.id, status: 'failed', error: String(error) }); }
        console.log(JSON.stringify(results.at(-1)));
      }
    } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
await writeFile(path.join(evidence, 'component-results.json'), JSON.stringify(results, null, 2));
assert(results.length === (cases.length + 2) * 2 && results.every(r => r.status === 'passed'));
