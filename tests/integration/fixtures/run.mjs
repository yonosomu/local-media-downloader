import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import path from 'node:path';
import { build } from 'esbuild';
import { startFixtureServer } from '../../../scripts/fixtures-server.mjs';
import { mediaRoot } from '../../../scripts/fixtures-generate.mjs';

const evidence = path.resolve('docs/evidence/t_ab1783c7');
await mkdir(evidence, { recursive: true });
const results = [];
const check = async (id, expected, action) => {
  const started = performance.now();
  try { const actual = await action(); results.push({ id, expected, status: 'passed', actual, elapsedMs: performance.now() - started }); }
  catch (error) { results.push({ id, expected, status: 'failed', error: String(error), elapsedMs: performance.now() - started }); }
  console.log(id, results.at(-1).status, results.at(-1).error ?? '');
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const generated = JSON.parse(await readFile('.test-data/fixtures-f/generated.json', 'utf8'));
const fixture = await startFixtureServer();
const [origin, cdn] = fixture.origins;
const get = route => fetch(origin + route);
try {
  await check('F-HTTP-DIRECT', '7 исходных форматов и MIME без суффикса; SHA-256 HTTP равен файлу', async () => {
    const actual = [];
    for (const name of ['source.mp4', 'source.webm', 'source.mkv', 'audio.mp3', 'audio.m4a', 'audio.ogg', 'audio.wav']) {
      const response = await get('/media/' + name); assert.equal(response.status, 200);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      const sha256 = hash(Buffer.from(await response.arrayBuffer()));
      assert.equal(sha256, generated.files.find(f => f.name === name).sha256);
      actual.push({ name, sha256, type: response.headers.get('content-type') });
    }
    const noSuffix = await get('/extensionless'); assert.equal(noSuffix.headers.get('content-type'), 'video/mp4');
    assert.equal(hash(Buffer.from(await noSuffix.arrayBuffer())), actual[0].sha256); return actual;
  });
  await check('F-HTTP-RANGES', '206 точные байты; 416 malformed/OOB; управляемые 200/wrong-range/ETag', async () => {
    const response = await fetch(origin + '/media/range.mp4', { headers: { Range: 'bytes=100-199' } });
    assert.equal(response.status, 206); assert.match(response.headers.get('content-range'), /^bytes 100-199\//);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), (await readFile(path.join(mediaRoot, 'range.mp4'))).subarray(100, 200));
    for (const range of ['bytes=999999999-', 'bytes=20-10', 'bytes=-10', 'bytes=0-1,3-4']) { const r = await fetch(origin + '/media/range.mp4', { headers: { Range: range } }); assert.equal(r.status, 416); await r.arrayBuffer(); }
    const ignored = await fetch(origin + '/fault/ignore-range', { headers: { Range: 'bytes=100-199' } }); assert.equal(ignored.status, 200); await ignored.arrayBuffer();
    const wrong = await fetch(origin + '/fault/wrong-range', { headers: { Range: 'bytes=100-199' } }); assert.match(wrong.headers.get('content-range'), /^bytes 101-199\//); await wrong.arrayBuffer();
    const first = await get('/fault/etag-change'), old = first.headers.get('etag'); await first.arrayBuffer();
    const second = await get('/fault/etag-change'); assert.notEqual(second.headers.get('etag'), old); await second.arrayBuffer();
    const head = await fetch(origin + '/media/source.mp4', { method: 'HEAD' }); assert.equal((await head.arrayBuffer()).byteLength, 0); return { rangeBytes: 100, invalidRanges: 4, etagChanged: true, ignoredStatus: 200 };
  });
  await check('F-HTTP-AUTH-SIGNED-REDIRECT', '401 → synthetic HttpOnly session; CDN302; подпись/expiry403; без секретов в request log', async () => {
    assert.equal((await get('/auth/source.mp4')).status, 401);
    const login = await get('/auth/login'); const cookie = login.headers.get('set-cookie'); assert(cookie.includes('HttpOnly')); assert(cookie.includes('SameSite=Lax')); await login.text();
    const auth = await fetch(cdn + '/auth/source.mp4', { headers: { Cookie: cookie.split(';')[0] } }); assert.equal(auth.status, 200); await auth.arrayBuffer();
    const redirect = await fetch(origin + '/redirect', { redirect: 'manual' }); assert.equal(redirect.status, 302); assert.equal(new URL(redirect.headers.get('location')).origin, cdn); await redirect.arrayBuffer();
    fixture.setElapsed(1);
    const signed = await get('/signed?signature=synthetic-only&expires=10'); assert.equal(signed.status, 200); await signed.arrayBuffer();
    for (const q of ['signature=wrong&expires=10', 'signature=synthetic-only&expires=0']) assert.equal((await get('/signed?' + q)).status, 403);
    assert(!JSON.stringify(fixture.requests).includes('synthetic-only')); assert(!JSON.stringify(fixture.requests).includes('lmd_fixture'));
    return { authenticated: true, crossOrigin: origin !== cdn, redacted: true };
  });
  await check('F-HTTP-FAILURES', '401/403/404/429/500; rate-limit2 затем200; header timeout/stall/offline различимы', async () => {
    for (const status of [401, 403, 404, 429, 500]) { const r = await get('/status/' + status); assert.equal(r.status, status); await r.arrayBuffer(); }
    const statuses = [];
    for (let i = 0; i < 3; i++) { const r = await get('/fault/rate-limit'); statuses.push(r.status); if (r.status === 429) assert.equal(r.headers.get('retry-after'), '1'); await r.arrayBuffer(); }
    assert.deepEqual(statuses, [429, 429, 200]);
    await assert.rejects(fetch(origin + '/fault/timeout', { signal: AbortSignal.timeout(100) }));
    const stall = await fetch(origin + '/fault/stall', { signal: AbortSignal.timeout(100) }); assert.equal(stall.status, 200); await assert.rejects(stall.arrayBuffer());
    await assert.rejects(get('/fault/offline'));
    assert.equal((await get('/forbidden-key')).status, 404);
    return { statuses, headerTimeout: true, bodyStall: true, disconnected: true };
  });
  await check('F-LIVE-WINDOWS', 'движущееся окно/конец >15min; уникальные пути и непрерывный original timeline', async () => {
    const samples = [];
    for (const t of [0, 4, 12, 900, generated.liveSeconds]) {
      fixture.setElapsed(t);
      const hls = await (await get('/live/hls.m3u8')).text(), dash = await (await get('/live/dash.mpd')).text();
      const seq = Number(/MEDIA-SEQUENCE:(\d+)/.exec(hls)[1]);
      assert.equal(seq, Math.max(0, Math.min(generated.liveSeconds / 2, Math.floor(t / 2) + 1) - 3));
      assert.equal(hls.includes('#EXT-X-ENDLIST'), t >= generated.liveSeconds);
      assert.equal(dash.includes('type="static"'), t >= generated.liveSeconds);
      const paths = [...hls.matchAll(/^\/media\/(.+)$/gm)].map(m => m[1]); assert.equal(new Set(paths).size, paths.length);
      for (const name of paths) { const r = await get('/media/' + name); assert.equal(r.status, 200); await r.arrayBuffer(); }
      assert(dash.includes(`startNumber="${seq + 1}"`));
      samples.push({ t, sequence: seq, hlsPaths: paths, dashStartNumber: seq + 1 });
    }
    fixture.setElapsed(12); const gap = await (await get('/live/gap.m3u8')).text(); assert(gap.includes('MEDIA-SEQUENCE:5'));
    fixture.setElapsed(0); return samples;
  });
  await check('F-HTTP-BOUNDS', 'нет file traversal/неизвестного corpus; loopback-only; invalid scenario отклонён', async () => {
    for (const route of ['/package.json', '/media/../package.json', '/media/%2e%2e%2fpackage.json', '/media/generated.json']) assert.equal((await get(route)).status, 404);
    await assert.rejects(startFixtureServer({ host: '0.0.0.0' })); await assert.rejects(startFixtureServer({ scenarioId: 'not-a-case' })); return { deniedPaths: 4, rejectedConfigs: 2 };
  });
  await check('F-REAL-ENGINE-PLANS', 'реальные resolver/validators на HTTP, не mock; 3Q/CDN/все manifest профили/negative limits', async () => {
    await build({ entryPoints: ['tests/integration/fixtures/plan-checks.ts'], outfile: '.test-data/fixtures-f/plan-checks.mjs', bundle: true, platform: 'node', format: 'esm', target: 'node26' });
    const { runPlanChecks } = await import(path.resolve('.test-data/fixtures-f/plan-checks.mjs'));
    const before = fixture.requests.length;
    const plans = await runPlanChecks(fixture.origins);
    assert(!fixture.requests.slice(before).some(r => r.path.includes('forbidden-key'))); return plans;
  });
} finally { await fixture.close(); }
const report = { schemaVersion: 1, scope: 'Проверки входов и HTTP-стенда, НЕ продуктовые AT и НЕ browser auth acceptance', generatedAt: new Date().toISOString(), node: process.version, commands: ['node scripts/fixtures-generate.mjs', 'node tests/integration/fixtures/run.mjs'], results, requests: fixture.requests };
await writeFile(path.join(evidence, 'server-results.json'), JSON.stringify(report, null, 2));
await writeFile(path.join(evidence, 'generation.json'), JSON.stringify(generated, null, 2));
console.log(`Результат: ${results.filter(r => r.status === 'passed').length}/${results.length}; docs/evidence/t_ab1783c7/server-results.json`);
assert(results.every(r => r.status === 'passed'));
