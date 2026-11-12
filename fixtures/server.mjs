
import { createReadStream } from 'node:fs';
import { readFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';

const fresh = path.resolve('.test-data/fixtures-f/media');
const existing = path.resolve('.test-data/engine-component/media');
const mime = file => ({ '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.ts': 'video/mp2t', '.m3u8': 'application/vnd.apple.mpegurl', '.mpd': 'application/dash+xml', '.vtt': 'text/vtt', '.ttml': 'application/ttml+xml' })[path.extname(file)] ?? 'application/octet-stream';

export function hlsWindow(text, elapsed, { windowSeconds = 6, gap = false, end = false } = {}) {
  const entries = [...text.matchAll(/#EXTINF:([\d.]+),[^\n]*\n([^\n]+)/g)];
  let start = 0;
  const segments = entries.map((m, sequence) => { const item = { sequence, duration: Number(m[1]), file: m[2], start }; start += item.duration; return item; });
  const visible = segments.filter(s => s.start + s.duration <= elapsed && s.start + s.duration > elapsed - windowSeconds);
  return '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n' + `#EXT-X-MEDIA-SEQUENCE:${visible[0]?.sequence ?? segments.length}\n` + visible.map((s,i) => `${gap && i === 1 ? '#EXT-X-GAP\n' : ''}#EXTINF:${s.duration},\n/live-segments/${s.file}${gap && i === 1 ? '?missing=1' : ''}\n`).join('') + (end ? '#EXT-X-ENDLIST\n' : '');
}

export function dashWindow(text, elapsed, end = false) {
  return text.replace(/type="static"/, `type="${end ? 'static' : 'dynamic'}" minimumUpdatePeriod="PT1S" timeShiftBufferDepth="PT6S"`)
    .replace(/mediaPresentationDuration="[^"]*"/, end ? `mediaPresentationDuration="PT${elapsed}S"` : '')
    .replace(/<SegmentTemplate([^>]*)>([\s\S]*?)<\/SegmentTemplate>/g, (_all, attrs, body) => {
      const timescale = Number(/timescale="(\d+)"/.exec(attrs)?.[1] ?? 1);
      let t = 0, number = Number(/startNumber="(\d+)"/.exec(attrs)?.[1] ?? 1);
      const segments = [];
      for (const match of body.matchAll(/<S\s+([^>]+)\/>/g)) {
        const a = match[1], d = Number(/\bd="(\d+)"/.exec(a)[1]);
        t = Number(/\bt="(\d+)"/.exec(a)?.[1] ?? t);
        const repeat = Number(/\br="(\d+)"/.exec(a)?.[1] ?? 0);
        for (let i = 0; i <= repeat; i++) { segments.push({ t, d, number: number++ }); t += d; }
      }
      const visible = segments.filter(s => (s.t + s.d) / timescale <= elapsed && (s.t + s.d) / timescale > elapsed - 6);
      const attributes = attrs.replace(/startNumber="\d+"/, `startNumber="${visible[0]?.number ?? number}"`).replace(/(initialization|media)="/g, '$1="/live-segments/');
      return `<SegmentTemplate${attributes}><SegmentTimeline>${visible.map(s => `<S t="${s.t}" d="${s.d}"/>`).join('')}</SegmentTimeline></SegmentTemplate>`;
    });
}

// Совместимые маршруты run113; sockets и lifecycle принадлежат только
// scripts/fixtures-server.mjs. Старый corpus сохраняется для прежних hashes.
export function createCompatibilityRoutes({ origins, clock = Date.now }) {
  const requests = [], counts = new Map(), timers = new Set();
  const epoch = clock() - 6000;
  const later = (fn, ms, res) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); res.once('close', () => { clearTimeout(timer); timers.delete(timer); }); };
  const record = (pathname, req) => {
    const count = (counts.get(pathname) ?? 0) + 1; counts.set(pathname, count);
    // Только allowlisted metadata, никогда raw URL, query, Cookie, Authorization.
    requests.push({ pathname, count, at: clock(), range: /^bytes=\d*-\d*$/.test(req.headers.range ?? '') ? req.headers.range : undefined, authenticated: /(?:^|; )lmd_fixture=session(?:;|$)/.test(req.headers.cookie ?? '') });
    if (requests.length > 10000) requests.shift();
    return count;
  };
  async function serveFile(res, req, root, name, mode = '') {
    const base = await realpath(root), file = await realpath(path.join(root, name));
    if (!file.startsWith(base + path.sep)) { res.writeHead(404).end(); return; }
    const info = await stat(file); if (!info.isFile()) { res.writeHead(404).end(); return; }
    const headers = { 'Content-Type': mime(file), 'Accept-Ranges': 'bytes', ETag: mode === 'changed' ? '"fixture-v2"' : '"fixture-v1"', 'Last-Modified': 'Tue, 03 Nov 2026 00:00:00 GMT' };
    const range = req.headers.range;
    let start = 0, end = info.size - 1, status = 200;
    if (range && mode !== 'ignore') {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return; }
      if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
      else { start = Number(match[1]); end = match[2] ? Math.min(end, Number(match[2])) : end; }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return; }
      status = 206; headers['Content-Range'] = `bytes ${mode === 'wrong' ? start + 1 : start}-${end}/${info.size}`;
    }
    res.writeHead(status, { ...headers, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = createReadStream(file, { start, end }); stream.on('error', () => res.destroy()); res.once('close', () => stream.destroy()); stream.pipe(res);
  }
  const handler = index => async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1'), p = url.pathname;
      const count = record(p, req);
      res.setHeader('Cache-Control', 'no-store');
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
      const text = (body, type = 'text/plain; charset=utf-8', status = 200) => res.writeHead(status, { 'Content-Type': type }).end(body);
      if (p === '/favicon.ico') { res.writeHead(204).end(); return; }
      if (p === '/') { text(`<!doctype html><meta charset="utf-8"><title>Стенд LMD F</title><h1>Синтетические материалы</h1><video controls preload="none" src="/opaque"></video><iframe src="${origins[1]}/frame"></iframe><button id="lazy">Добавить видео / SPA</button><script>document.getElementById('lazy').onclick=()=>{history.pushState({},'', '/spa');const v=document.createElement('video');v.preload='none';v.src='/existing/source.webm';document.body.append(v);};</script><a href="/new/master.m3u8">HLS 3 качества / ru en</a><a href="/live.m3u8">HLS live</a><a href="/live.mpd">DASH live</a>`, 'text/html; charset=utf-8'); return; }
      if (p === '/frame') { text('<!doctype html><title>CDN frame</title><audio controls preload="none" src="/existing/audio.m4a"></audio>', 'text/html'); return; }
      if (p === '/session') { res.setHeader('Set-Cookie', 'lmd_fixture=session; HttpOnly; SameSite=Lax; Path=/'); text('Только синтетическая сессия'); return; }
      if (p === '/auth/media') { if (!requests.at(-1).authenticated) { text('Нужна synthetic session', 'text/plain', 401); return; } await serveFile(res, req, existing, 'source.mp4'); return; }
      if (p === '/auth/page') { text(`<iframe src="${origins[1]}/session"></iframe><video preload="none" src="${origins[1]}/auth/media"></video>`, 'text/html'); return; }
      if (p === '/legacy-redirect') { res.writeHead(302, { Location: `${origins[1]}/opaque` }).end(); return; }
      if (p === '/redirect-loop') { res.writeHead(302, { Location: '/redirect-loop' }).end(); return; }
      if (p === '/legacy-signed') { if (url.search !== '?sig=fixture%2Bvalue&expires=valid') { res.writeHead(403).end(); return; } await serveFile(res, req, existing, 'source.mp4'); return; }
      if (p === '/expired') { res.writeHead(403).end(); return; }
      if (p === '/html.mp4') { text('<html>Требуется вход</html>', 'text/html'); return; }
      if (/^\/status\/(401|403|404|429|500)$/.test(p)) { res.writeHead(Number(p.split('/').at(-1)), { 'Retry-After': '1' }).end(); return; }
      if (p === '/retry') { if (count <= 2) { res.writeHead(429, { 'Retry-After': '1' }).end(); return; } await serveFile(res, req, existing, 'source.mp4'); return; }
      if (p === '/timeout') { later(() => res.end('Слишком поздно'), 3000, res); return; }
      if (p === '/stall') { res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.flushHeaders(); res.write('first'); later(() => res.end('last'), 3000, res); return; }
      if (p === '/disconnect') { req.socket.destroy(); return; }
      if (p === '/truncated') { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': 1000 }); res.write('short'); later(() => res.destroy(), 20, res); return; }
      if (p === '/opaque' || p.startsWith('/range/')) { await serveFile(res, req, existing, 'source.mp4', p.split('/').at(-1)); return; }
      if (p === '/live.m3u8' || p === '/live-gap.m3u8') { text(hlsWindow(await readFile(path.join(fresh, 'live-static.m3u8'), 'utf8'), (clock() - epoch) / 1000, { gap: p.includes('gap'), end: url.searchParams.has('end') }), 'application/vnd.apple.mpegurl'); return; }
      if (p === '/live.mpd') { text(dashWindow(await readFile(path.join(fresh, 'live-static.mpd'), 'utf8'), (clock() - epoch) / 1000, url.searchParams.has('end')), 'application/dash+xml'); return; }
      if (p.startsWith('/live-segments/') && url.searchParams.has('missing')) { res.writeHead(404).end(); return; }
      if (p === '/aes.m3u8') { text('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="/must-not-fetch-key"\n#EXTINF:2,\n/existing/ts-0.ts\n#EXT-X-ENDLIST\n', 'application/vnd.apple.mpegurl'); return; }
      if (p === '/drm.mpd') { text('<MPD><Period><AdaptationSet><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/></AdaptationSet></Period></MPD>', 'application/dash+xml'); return; }
      if (p === '/xxe.mpd') { text('<!DOCTYPE MPD [<!ENTITY x SYSTEM "file:///etc/passwd">]><MPD>&x;</MPD>', 'application/dash+xml'); return; }
      if (p === '/private.m3u8') { text('#EXTM3U\n#EXTINF:2,\nhttp://169.254.169.254/metadata\n#EXT-X-ENDLIST\n', 'application/vnd.apple.mpegurl'); return; }
      if (p === '/oversize.m3u8') { text('#EXTM3U\n#' + 'x'.repeat(8 * 1024 * 1024), 'application/vnd.apple.mpegurl'); return; }
      if (p.startsWith('/existing/') || p.startsWith('/new/') || p.startsWith('/live-segments/')) {
        const name = p.slice(p.indexOf('/', 1) + 1);
        if (!/^[a-zA-Z0-9_.-]+$/.test(name)) { res.writeHead(404).end(); return; }
        await serveFile(res, req, p.startsWith('/existing/') ? existing : fresh, name); return;
      }
      text(`Неизвестный synthetic маршрут origin ${index}`, 'text/plain', 404);
    } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
  };
  return { handler, close() { for (const timer of timers) clearTimeout(timer); timers.clear(); } };
}

// Старые потребители подключаются к тому же каноническому серверу.
export async function startFixtureServer({ scenarioId = 'normal', ...options } = {}) {
  const canonical = await import('../scripts/fixtures-server.mjs');
  return canonical.startFixtureServer({ ...options, scenarioId: scenarioId.startsWith('F-') || scenarioId === 'default' ? 'normal' : scenarioId });
}
