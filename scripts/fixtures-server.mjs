import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mediaRoot } from './fixtures-generate.mjs';
import { createCompatibilityRoutes } from '../fixtures/server.mjs';

const mime = name => name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : name.endsWith('.mpd') ? 'application/dash+xml' : name.endsWith('.ts') ? 'video/mp2t' : name.endsWith('.webm') ? 'video/webm' : name.endsWith('.mkv') ? 'video/x-matroska' : name.endsWith('.mp3') ? 'audio/mpeg' : name.endsWith('.m4a') ? 'audio/mp4' : name.endsWith('.wav') ? 'audio/wav' : name.endsWith('.ogg') ? 'audio/ogg' : name.endsWith('.vtt') ? 'text/vtt' : name.endsWith('.ttml') ? 'application/ttml+xml' : 'video/mp4';
const scenarios = new Set(['normal', 'gap', 'etag-change', 'ignore-range', 'wrong-range', 'rate-limit', 'timeout', 'stall', 'offline']);

// Только loopback, фиксированный corpus, без произвольного upstream proxy/CORS bypass.
export async function startFixtureServer({ host = '127.0.0.1', ports = [0, 0], scenarioId = 'normal', clock = Date.now } = {}) {
  if (host !== '127.0.0.1' || ports.length !== 2 || ports.some(p => !Number.isInteger(p) || p < 0 || p > 65535) || !scenarios.has(scenarioId)) throw new Error('Неверная конфигурация fixture server');
  const generated = JSON.parse(await readFile(path.resolve('.test-data/fixtures-f/generated.json'), 'utf8'));
  const allowed = new Set(generated.files.map(f => f.name));
  const hls = await readFile(path.join(mediaRoot, 'live-static.m3u8'), 'utf8');
  const hlsSegments = [...hls.matchAll(/#EXTINF:([\d.]+),[^\n]*\n([^\n]+)/g)].map(m => ({ duration: Number(m[1]), name: m[2] }));
  const dash = await readFile(path.join(mediaRoot, 'live-static.mpd'), 'utf8');
  const origins = [], servers = [], requests = [], counts = new Map();
  const compatibility = createCompatibilityRoutes({ origins, clock });
  const session = randomUUID(), started = performance.now();
  let manualElapsed;
  const elapsed = () => manualElapsed ?? (performance.now() - started) / 1000;
  const text = (res, body, type = 'text/html; charset=utf-8', status = 200) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
  const sendFile = async (req, res, name, fault = 'normal') => {
    if (!allowed.has(name)) { res.writeHead(404).end(); return; }
    const file = path.join(mediaRoot, name), info = await stat(file);
    const count = counts.get(`file:${fault}`) ?? 0; counts.set(`file:${fault}`, count + 1);
    const headers = { 'Content-Type': mime(name), ETag: fault === 'etag-change' && count > 0 ? '"fixture-v2"' : '"fixture-v1"', 'Accept-Ranges': 'bytes' };
    if (fault === 'offline') { req.socket.destroy(); return; }
    if (fault === 'timeout') return; // Закрывается client AbortSignal или close().
    if (fault === 'stall') { res.writeHead(200, { ...headers, 'Content-Length': info.size }); res.write(Buffer.from([0])); return; }
    if (fault === 'rate-limit' && count < 2) { res.writeHead(429, { 'Retry-After': '1' }).end(); return; }
    const range = req.headers.range;
    let start = 0, end = info.size - 1, status = 200;
    if (range && fault !== 'ignore-range') {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      start = Number(match?.[1]); end = match?.[2] ? Number(match[2]) : info.size - 1;
      if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || end >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return; }
      status = 206;
      headers['Content-Range'] = `bytes ${fault === 'wrong-range' ? start + 1 : start}-${end}/${info.size}`;
    }
    res.writeHead(status, { ...headers, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = createReadStream(file, { start, end });
    res.once('close', () => stream.destroy()); stream.on('error', () => res.destroy()); stream.pipe(res);
  };
  const handler = originIndex => async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1'), route = url.pathname;
      // Никаких query/header/cookie values в журнале, в том числе на ошибке.
      requests.push({ originIndex, path: route, method: req.method, range: /^bytes=\d+-\d*$/.test(req.headers.range ?? '') ? req.headers.range : undefined, atSeconds: elapsed() });
      if (requests.length > 20000) requests.shift();
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      if (route === '/favicon.ico') { res.writeHead(204).end(); return; }
      if (route === '/auth/login') { res.setHeader('Set-Cookie', `lmd_fixture=${session}; HttpOnly; SameSite=Lax; Path=/auth/`); text(res, '<p>Только синтетическая сессия fixture. Личных аккаунтов нет.</p>'); return; }
      if (route === '/auth/source.mp4') {
        if (!req.headers.cookie?.split(';').some(c => c.trim() === `lmd_fixture=${session}`)) { text(res, '<h1>Требуется вход fixture</h1>', 'text/html', 401); return; }
        await sendFile(req, res, 'source.mp4'); return;
      }
      if (route === '/auth-html.mp4') { text(res, '<h1>Требуется вход</h1>'); return; }
      if (route === '/signed') {
        const expiry = Number(url.searchParams.get('expires'));
        if (url.searchParams.get('signature') !== 'synthetic-only' || !Number.isFinite(expiry) || expiry < elapsed()) { res.writeHead(403).end(); return; }
        await sendFile(req, res, 'source.mp4'); return;
      }
      if (route === '/redirect') { res.writeHead(302, { Location: `${origins[1]}/media/source.mp4` }).end(); return; }
      if (route === '/redirect-loop') { res.writeHead(302, { Location: '/redirect-loop' }).end(); return; }
      if (/^\/status\/(401|403|404|429|500)$/.test(route)) { res.writeHead(Number(route.split('/').at(-1)), { 'Retry-After': '1' }).end(); return; }
      if (route.startsWith('/fault/')) {
        const fault = route.slice(7);
        if (!scenarios.has(fault)) { res.writeHead(404).end(); return; }
        await sendFile(req, res, 'source.mp4', fault); return;
      }
      if (route === '/extensionless') { await sendFile(req, res, 'source.mp4'); return; }
      if (route === '/cdn/master.m3u8') {
        const master = await readFile(path.join(mediaRoot, 'master.m3u8'), 'utf8');
        text(res, master.replace(/URI="([^"/]+)"/g, (_, f) => `URI="${origins[1]}/media/${f}"`).replace(/^(q\d+\.m3u8)$/gm, `${origins[1]}/media/$1`), mime('master.m3u8')); return;
      }
      if (route === '/live/hls.m3u8' || route === '/live/gap.m3u8') {
        const end = Math.min(hlsSegments.length, Math.max(1, Math.floor(elapsed() / 2) + 1));
        let begin = Math.max(0, end - 3);
        if (route.includes('gap') || scenarioId === 'gap') begin = Math.min(end - 1, begin + 1);
        const body = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${begin}\n` + hlsSegments.slice(begin, end).map(s => `#EXTINF:${s.duration},\n/media/${s.name}\n`).join('') + (elapsed() >= generated.liveSeconds ? '#EXT-X-ENDLIST\n' : '');
        text(res, body, mime('live.m3u8')); return;
      }
      if (route === '/live/dash.mpd') {
        const end = Math.min(generated.liveSeconds / 2, Math.max(1, Math.floor(elapsed() / 2) + 1)), begin = Math.max(0, end - 3);
        // Две дорожки с собственными временны́ми шкалами; реальные уникальные fragments.
        const body = dash.replace('type="static"', `type="${elapsed() >= generated.liveSeconds ? 'static' : 'dynamic'}" minimumUpdatePeriod="PT2S" timeShiftBufferDepth="PT6S"`)
          .replace(/mediaPresentationDuration="[^"]*"/, '')
          .replace(/<SegmentTemplate([\s\S]*?)<\/SegmentTemplate>/g, (template, attrs) => {
            let time = 0;
            const entries = [];
            for (const match of attrs.matchAll(/<S\s+([^>]+)\/>/g)) {
              const duration = Number(/d="(\d+)"/.exec(match[1])[1]);
              const repeat = Number(/r="(\d+)"/.exec(match[1])?.[1] ?? 0);
              time = Number(/t="(\d+)"/.exec(match[1])?.[1] ?? time);
              for (let i = 0; i <= repeat; i++) { entries.push({ time, duration }); time += duration; }
            }
            const timeline = entries.slice(begin, end).map(s => `<S t="${s.time}" d="${s.duration}"/>`).join('');
            return template.replace(/startNumber="\d+"/, `startNumber="${begin + 1}"`).replace(/<SegmentTimeline>[\s\S]*?<\/SegmentTimeline>/, `<SegmentTimeline>${timeline}</SegmentTimeline>`);
          }).replaceAll('initialization="live-', 'initialization="/media/live-').replaceAll('media="live-', 'media="/media/live-');
        text(res, body, mime('live.mpd')); return;
      }
      if (route === '/limits/large.m3u8') { text(res, '#EXTM3U\n' + '#'.repeat(8 * 1024 * 1024), mime('large.m3u8')); return; }
      if (route === '/limits/segments.m3u8') { text(res, '#EXTM3U\n' + '#EXTINF:2,\n/media/q90-0.ts\n'.repeat(100001) + '#EXT-X-ENDLIST\n', mime('large.m3u8')); return; }
      if (/^\/limits\/depth\/\d+\.m3u8$/.test(route)) { const n = Number(route.match(/\d+/)[0]); text(res, `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\n${n + 1}.m3u8\n`, mime('depth.m3u8')); return; }
      if (route.startsWith('/media/')) { await sendFile(req, res, route.slice(7), scenarioId); return; }
      if (route === '/frame') { text(res, '<!doctype html><meta charset="utf-8"><title>CDN frame</title><video controls preload="none" src="/media/source.webm"></video>'); return; }
      if (route === '/') {
        text(res, `<!doctype html><meta charset="utf-8"><title>LMD synthetic F</title><h1>Собственный тестовый материал</h1><video id="main" controls preload="none" src="/extensionless"></video><a href="/cdn/master.m3u8">Три качества HLS / CDN</a><button id="lazy">Добавить iframe</button><button id="spa">SPA navigation</button><div id="frames"></div><script>document.querySelector('#lazy').onclick=()=>{const f=document.createElement('iframe');f.src=${JSON.stringify(origins[1] + '/frame')};document.querySelector('#frames').append(f)};document.querySelector('#spa').onclick=()=>{history.pushState({},'', '/?page=2');document.querySelector('#main').src='/media/source.webm'};</script>`); return;
      }
      await compatibility.handler(originIndex)(req, res);
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  };
  try {
    for (const [index, port] of ports.entries()) {
      const server = createServer(handler(index)); servers.push(server);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      origins.push(`http://${host}:${server.address().port}`);
    }
  } catch (error) { compatibility.close(); for (const server of servers) { server.close(); server.closeAllConnections(); } throw error; }
  return { origins, requests, scenarioId, snapshot: () => structuredClone(requests.map(r => ({ ...r, pathname: r.path }))), setElapsed(seconds) { if (!Number.isFinite(seconds) || seconds < 0 || seconds > generated.liveSeconds + 10) throw new Error('Неверное fixture time'); manualElapsed = seconds; }, async close() { compatibility.close(); await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }))); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const fixture = await startFixtureServer();
  console.log(`Синтетический стенд (два origin): ${fixture.origins.join(' ')}; Ctrl+C завершает только эти серверы.`);
  process.once('SIGINT', () => void fixture.close()); process.once('SIGTERM', () => void fixture.close());
}
