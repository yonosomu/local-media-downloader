import { afterAll, beforeAll, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { startFixtureServer } from '../../../fixtures/server.mjs';
import { createAuthorizedFetcher, boundedText } from '../../../src/engine/fetch';
import { Resolver } from '../../../src/engine/resolver';
import { parseHls } from '../../../src/core/hls';
import { parseDash } from '../../../src/core/dash';
import { mergeWebVtt } from '../../../src/core/subtitles';
import { DEFAULT_LIMITS } from '../../../src/shared/contracts';

let fixture, source, elapsed = 0;
const signal = () => new AbortController().signal;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
beforeAll(async () => {
  fixture = await startFixtureServer({ scenarioId: 'F-network', clock: () => 1794400000000 + elapsed * 1000 });
  source = { sourceRef: 'fixture', exactUrl: `${fixture.origins[0]}/opaque`, allowedOrigins: fixture.origins, localModeOrigins: fixture.origins };
});
afterAll(async () => fixture?.close());
const fetcher = () => createAuthorizedFetcher({ retries: 0, firstByteTimeoutMs: 100, stallTimeoutMs: 100 });
const request = (route, options = {}, client = fetcher()) => client.request(source, `${fixture.origins[0]}${route}`, { signal: signal(), ...options });

test('F-01 два origin, extensionless MIME, полный hash и точные ranges', async () => {
  expect(new Set(fixture.origins).size).toBe(2);
  const bytes = await readFile('.test-data/engine-component/media/source.mp4');
  for (const origin of fixture.origins) {
    const response = await fetch(`${origin}/opaque`);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(hash(Buffer.from(await response.arrayBuffer()))).toBe(hash(bytes));
  }
  const response = await request('/opaque', { range: { offset: 4, length: 12 } });
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(4,16));
  const suffix = await fetch(`${fixture.origins[0]}/opaque`, { headers: { Range: 'bytes=-8' } });
  expect(Buffer.from(await suffix.arrayBuffer())).toEqual(bytes.subarray(-8));
  expect((await fetch(`${fixture.origins[0]}/opaque`, { headers: { Range: 'bytes=99999999-' } })).status).toBe(416);
});
test('F-02 реальный HTTP: 401/403/404/429/500/HTML дают ожидаемые коды без retry', async () => {
  for (const [route, code] of [['/status/401','AUTH_REQUIRED'], ['/status/403','URL_EXPIRED'], ['/status/404','SEGMENT_MISSING'], ['/status/429','RATE_LIMITED'], ['/status/500','HTTP_ERROR'], ['/html.mp4','AUTH_REQUIRED']]) {
    const before = fixture.snapshot().filter(r => r.pathname === route).length;
    await expect(request(route)).rejects.toMatchObject({ code });
    expect(fixture.snapshot().filter(r => r.pathname === route)).toHaveLength(before + 1);
  }
});
test('F-03 Retry-After: два 429 затем успех, не раньше секунды', async () => {
  const client = createAuthorizedFetcher({ retries: 2 });
  const started = performance.now();
  await (await request('/retry', {}, client)).arrayBuffer();
  const calls = fixture.snapshot().filter(r => r.pathname === '/retry');
  expect(calls).toHaveLength(3);
  expect(performance.now() - started).toBeGreaterThanOrEqual(2000);
}, 10000);
test('F-04 timeout, stalled body, disconnect, truncated response реально воспроизводятся', async () => {
  await expect(request('/timeout')).rejects.toMatchObject({ code: 'NETWORK_TIMEOUT' });
  // Проверка входа stall; product fetcher regression вынесена в отдельный probe.
  const stalled = await fetch(`${fixture.origins[0]}/stall`, { signal: AbortSignal.timeout(100) });
  await expect(stalled.text()).rejects.toThrow();
  await expect(request('/disconnect')).rejects.toMatchObject({ code: 'NETWORK_OFFLINE' });
  await expect((await request('/truncated')).arrayBuffer()).rejects.toMatchObject({ code: 'NETWORK_OFFLINE' });
});
test('F-05 ignored/wrong ranges и ETag change не становятся append', async () => {
  for (const route of ['/range/ignore','/range/wrong','/range/changed']) await expect(request(route, { range: { offset: 4, length: 12 }, identity: { etag: '"fixture-v1"' } })).rejects.toMatchObject({ code: 'RESOURCE_CHANGED' });
});
test('F-06 точная synthetic подпись, expiry и redirect проверяют authority до нового origin', async () => {
  await (await request('/legacy-signed?sig=fixture%2Bvalue&expires=valid')).arrayBuffer();
  await expect(request('/legacy-signed?sig=fixture+value&expires=valid')).rejects.toMatchObject({ code: 'URL_EXPIRED' });
  await expect(request('/expired')).rejects.toMatchObject({ code: 'URL_EXPIRED' });
  await (await request('/legacy-redirect')).arrayBuffer();
  const before = fixture.snapshot().filter(r => r.pathname === '/opaque').length;
  const restricted = { ...source, allowedOrigins: [fixture.origins[0]] };
  await expect(fetcher().request(restricted, `${fixture.origins[0]}/legacy-redirect`, { signal: signal() })).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' });
  expect(fixture.snapshot().filter(r => r.pathname === '/opaque')).toHaveLength(before);
  await expect(request('/redirect-loop')).rejects.toMatchObject({ code: 'MANIFEST_LIMIT' });
});
test('F-07 malicious manifests, encryption и byte limit; ключи не запрашиваются', async () => {
  const resolver = new Resolver(fetcher(), DEFAULT_LIMITS);
  for (const [route, code] of [['/aes.m3u8','ENCRYPTED_UNSUPPORTED'], ['/drm.mpd','DRM_UNSUPPORTED'], ['/xxe.mpd','INVALID_MANIFEST']]) {
    const error = await resolver.inspect({ ...source, exactUrl: `${fixture.origins[0]}${route}` }, signal()).then(() => null, error => error);
    expect(error).toBeTruthy();
    expect(error.code ?? error.message).toBe(code);
  }
  await expect(boundedText(await request('/oversize.m3u8'))).rejects.toMatchObject({ code: 'MANIFEST_LIMIT' });
  expect(fixture.snapshot().some(r => r.pathname === '/must-not-fetch-key')).toBe(false);
  expect(() => parseHls('#EXTM3U\n#EXTINF:2,\nhttp://169.254.169.254/metadata\n#EXT-X-ENDLIST', 'https://media.example/a.m3u8')).toThrow();
});
test('F-08 три настоящих качества, два разных языка и эталон segmented VTT', async () => {
  const master = await (await fetch(`${fixture.origins[0]}/new/master.m3u8`)).text();
  expect([...(master.matchAll(/RESOLUTION=\d+x(\d+)/g))].map(m => Number(m[1]))).toEqual([90,180,270]);
  const ru = await readFile('.test-data/fixtures-f/media/ru-0.ts'), en = await readFile('.test-data/fixtures-f/media/en-0.ts');
  expect(hash(ru)).not.toBe(hash(en));
  const parts = await Promise.all([0,1,2].map(async i => ({ text: await readFile(`.test-data/fixtures-f/media/sub-${i}.vtt`, 'utf8'), start: i * 2 })));
  const normalize = text => text.trim().replace(/\n{3,}/g, '\n\n');
  expect(normalize(mergeWebVtt(parts))).toBe(normalize(await readFile('.test-data/fixtures-f/media/expected.vtt', 'utf8')));
});
test('F-09 sliding HLS/DASH имеют непрерывные media times вплоть до 15 минут (ускоренный clock, не AT13/14)', async () => {
  let previousHls = -1, previousDash = -1;
  for (elapsed of [0,2,20,300,600,898]) {
    const hls = await (await fetch(`${fixture.origins[0]}/live.m3u8`)).text();
    const sequence = Number(/MEDIA-SEQUENCE:(\d+)/.exec(hls)[1]);
    expect(sequence).toBeGreaterThan(previousHls); previousHls = sequence;
    expect([...hls.matchAll(/#EXTINF/g)].length).toBe(3);
    const dash = parseDash(await (await fetch(`${fixture.origins[0]}/live.mpd`)).text(), `${fixture.origins[0]}/live.mpd`, true);
    const start = dash.representations[0].segments[0].start;
    expect(start).toBeGreaterThan(previousDash); previousDash = start;
    expect(start).toBeGreaterThanOrEqual(elapsed);
  }
  const end = await (await fetch(`${fixture.origins[0]}/live.m3u8?end=1`)).text(); expect(end).toContain('#EXT-X-ENDLIST');
  const gap = await (await fetch(`${fixture.origins[0]}/live-gap.m3u8`)).text(); expect(gap).toContain('#EXT-X-GAP');
  const missing = /([^\n]+\?missing=1)/.exec(gap)[1]; expect((await fetch(`${fixture.origins[0]}${missing}`)).status).toBe(404);
});
test('F-10 synthetic auth и безопасный request log, no CORS override, traversal guard', async () => {
  expect((await fetch(`${fixture.origins[1]}/auth/media`)).status).toBe(401);
  const response = await fetch(`${fixture.origins[1]}/auth/media`, { headers: { Cookie: 'lmd_fixture=session' } });
  expect(response.status).toBe(200); expect(response.headers.has('access-control-allow-origin')).toBe(false); await response.arrayBuffer();
  expect((await fetch(`${fixture.origins[0]}/new/%2e%2e%2fpackage.json`)).status).toBe(404);
  const log = JSON.stringify(fixture.snapshot());
  expect(log).not.toContain('fixture%2Bvalue'); expect(log).not.toContain('lmd_fixture=session');
  expect(log).not.toContain('Authorization');
});
