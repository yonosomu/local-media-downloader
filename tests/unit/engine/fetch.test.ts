import { expect, test } from 'vitest';
import { createAuthorizedFetcher, boundedText, retryAfter, Semaphore } from '../../../src/engine/fetch';
import { Resolver } from '../../../src/engine/resolver';
import { DEFAULT_LIMITS, type AuthorizedSource } from '../../../src/shared/contracts';
const source: AuthorizedSource = { sourceRef: 'private-ref', exactUrl: 'https://cdn.example/a?sig=keep%2Bme', allowedOrigins: ['https://cdn.example'], localModeOrigins: [] };
const signal = () => new AbortController().signal;
test('authorization precedes fetch and signed URI is unchanged', async () => {
  const calls: string[] = [];
  const fetcher = createAuthorizedFetcher({ fetch: async input => { calls.push(String(input)); return new Response('okay'); } });
  expect(await (await fetcher.request(source, source.exactUrl, { signal: signal() })).text()).toBe('okay');
  expect(calls).toEqual([source.exactUrl]);
  await expect(fetcher.request(source, 'http://127.0.0.1/a', { signal: signal() })).rejects.toThrow();
  await expect(fetcher.request(source, 'https://other.example/a', { signal: signal() })).rejects.toThrow(); expect(calls).toHaveLength(1);
});
test('range 200 and changed identity are refused; correct 206 is exact', async () => {
  for (const response of [new Response('entire'), new Response('part', { status: 206, headers: { 'Content-Range': 'bytes 0-3/8' } }), new Response('part', { status: 206, headers: { 'Content-Range': 'bytes 4-7/8', ETag: 'new' } })]) {
    const fetcher = createAuthorizedFetcher({ fetch: async () => response });
    await expect(fetcher.request(source, source.exactUrl, { signal: signal(), range: { offset: 4, length: 4 }, identity: { etag: 'old' } })).rejects.toThrow();
  }
  const fetcher = createAuthorizedFetcher({ fetch: async () => new Response('part', { status: 206, headers: { 'Content-Range': 'bytes 4-7/8', ETag: 'old' } }) });
  expect(await (await fetcher.request(source, source.exactUrl, { signal: signal(), range: { offset: 4, length: 4 }, identity: { etag: 'old' } })).text()).toBe('part');
});
test('body length mismatch and bounded manifest streaming reject without full buffering', async () => {
  const fetcher = createAuthorizedFetcher({ fetch: async () => new Response('bad', { headers: { 'content-length': '5' } }) });
  await expect((await fetcher.request(source, source.exactUrl, { signal: signal() })).text()).rejects.toThrow();
  await expect(boundedText(new Response('Привет'), 8)).rejects.toThrow();
});
test('401/403/HTML never retry; redirects validate new origin before fetching it', async () => {
  for (const response of [new Response('', { status: 401 }), new Response('', { status: 403 }), new Response('<html>', { headers: { 'content-type': 'text/html' } })]) {
    let calls = 0; const fetcher = createAuthorizedFetcher({ fetch: async () => { calls++; return response; } });
    await expect(fetcher.request(source, source.exactUrl, { signal: signal() })).rejects.toThrow(); expect(calls).toBe(1);
  }
  let calls = 0;
  const fetcher = createAuthorizedFetcher({ fetch: async () => { calls++; return new Response('', { status: 302, headers: { Location: 'http://127.0.0.1/a' } }); } });
  await expect(fetcher.request(source, source.exactUrl, { signal: signal() })).rejects.toThrow(); expect(calls).toBe(1);
  expect(retryAfter('2')).toBe(2000); expect(retryAfter('Wed, 01 Jan 2025 00:00:02 GMT', Date.parse('2025-01-01T00:00:00Z'))).toBe(2000);
});
test('semaphore releases aborted waiters and preserves maximum', async () => {
  const semaphore = new Semaphore(1), first = await semaphore.acquire(signal()), abort = new AbortController();
  const waiting = semaphore.acquire(abort.signal); abort.abort(); await expect(waiting).rejects.toThrow(); first();
  const release = await semaphore.acquire(signal()); release(); release();
});
test('global fetch slot lives through body consumption and is released by cancel', async () => {
  let calls = 0;
  const fetcher = createAuthorizedFetcher({ concurrency: 1, fetch: async () => { calls++; return new Response('abc'); } });
  const first = await fetcher.request(source, source.exactUrl, { signal: signal() });
  const pending = fetcher.request(source, source.exactUrl, { signal: signal() });
  await Promise.resolve(); expect(calls).toBe(1); await first.body!.cancel(); await (await pending).body!.cancel(); expect(calls).toBe(2);
});
test('planner persists opaque refs only; separate audio-only never fetches video manifest', async () => {
  const calls: string[] = [];
  const fetcher = createAuthorizedFetcher({ fetch: async input => {
    calls.push(String(input));
    if (String(input).includes('audio')) return new Response('#EXTM3U\n#EXTINF:2,\na.m4a?token=secret\n#EXT-X-ENDLIST');
    return new Response('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Russian",LANGUAGE="ru",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100,CODECS="avc1.42,mp4a.40.2",AUDIO="a"\nvideo.m3u8');
  } });
  const resolver = new Resolver(fetcher, DEFAULT_LIMITS);
  const plan = await resolver.plan(source, { audioOnly: true, audioTrackId: 'track-0', subtitleTrackIds: [], container: 'm4a' }, signal());
  expect(plan.tracks.map(t => t.kind)).toEqual(['audio']); expect(calls.some(c => c.includes('video.m3u8'))).toBe(false);
  expect(JSON.stringify(plan)).not.toContain('token'); expect(JSON.stringify(plan)).not.toContain('https:'); expect(Object.isFrozen(plan.parts[0].segments)).toBe(true);
});
