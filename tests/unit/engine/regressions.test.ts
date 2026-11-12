import { expect, test, vi } from 'vitest';
import { parseDash } from '../../../src/core/dash';
import { muxLanguage } from '../../../src/core/language';
import { Resolver } from '../../../src/engine/resolver';
import { createAuthorizedFetcher } from '../../../src/engine/fetch';
import { OpfsFiles } from '../../../src/engine/files';
import { selectPreferred } from '../../../src/core/selection';
import { DEFAULT_LIMITS, DEFAULT_SETTINGS, type AuthorizedSource } from '../../../src/shared/contracts';
import { validateEnvelope, validateHintBinding, validateSelection, validateSettings } from '../../../src/shared/validation';
const source: AuthorizedSource = { sourceRef: 'session', exactUrl: 'https://cdn.example/manifest', allowedOrigins: ['https://cdn.example'], localModeOrigins: [] };
const signal = () => new AbortController().signal;

test('JSON enum fields reject arrays instead of coercing them to valid strings', () => {
  expect(() => validateSelection({ audioOnly: false, subtitleTrackIds: [], container: ['mp4'] })).toThrow();
  expect(() => validateSettings({ ...DEFAULT_SETTINGS, quality: { mode: ['best'] } })).toThrow();
  expect(() => validateSettings({ ...DEFAULT_SETTINGS, permissionMode: ['all_http_https'] })).toThrow();
  expect(() => validateEnvelope({ version: 1, requestId: crypto.randomUUID(), type: 'GET_JOBS', payload: { filter: ['all'] } })).toThrow();
  expect(() => validateHintBinding({ tab: { id: 1 }, frameId: 0, documentId: 'doc' }, { tabId: 1, frameId: 0, documentId: 'doc', generation: 1, documentKey: 'key' }, { generation: 1, documentKey: 'key', kind: ['video'], url: 'https://cdn.example/a' })).toThrow();
});

test('quota failure during writer creation releases the network body and keeps its error code', async () => {
  const files = new OpfsFiles({} as FileSystemDirectoryHandle); let cancelled = false;
  vi.spyOn(files, 'handle').mockRejectedValue(new DOMException('quota', 'QuotaExceededError'));
  vi.spyOn(files, 'remove').mockResolvedValue();
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  await expect(files.write('jobs/test/segment', body, signal())).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  expect(cancelled).toBe(true);
});

test('job request policy overrides constructor defaults without a new semaphore', async () => {
  let calls = 0;
  const fetcher = createAuthorizedFetcher({ retries: 3, fetch: async () => { calls++; return new Response('', { status: 500 }); } });
  await expect(fetcher.request(source, source.exactUrl, { signal: signal(), policy: { retries: 0, firstByteTimeoutMs: 100, stallTimeoutMs: 100 } })).rejects.toMatchObject({ code: 'HTTP_ERROR' });
  expect(calls).toBe(1);
});

test('very long Retry-After cannot overflow a timer into an early retry', async () => {
  let calls = 0;
  const fetcher = createAuthorizedFetcher({ fetch: async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '9999999999999' } }); } });
  await expect(fetcher.request(source, source.exactUrl, { signal: signal() })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  expect(calls).toBe(1);
});

test('audio-only preference uses audio codec and does not require a manual video variant', () => {
  const media = { protocol: 'hls' as const, isLive: false, variants: [{ id: 'v', codecs: ['avc1.42', 'mp4a.40.2'], hasAudio: true }], audioTracks: [], subtitleTracks: [], containers: ['mp4' as const, 'mkv' as const] };
  expect(selectPreferred(media, { ...DEFAULT_SETTINGS, container: 'm4a' }, true).selection.container).toBe('m4a');
  expect(selectPreferred({ ...media, variants: [], audioTracks: [{ id: 'a', kind: 'audio', label: 'Russian', codec: 'aac', language: 'ru' }] }, { ...DEFAULT_SETTINGS, quality: { mode: 'manual' }, container: 'm4a' }, true).selection.audioTrackId).toBe('a');
});

test('sniffing tolerates byte-sized network chunks and preserves manifest bytes', async () => {
  const bytes = new TextEncoder().encode('#EXTM3U\n#EXTINF:2,\nvideo.ts\n#EXT-X-ENDLIST\n');
  const resolver = new Resolver(createAuthorizedFetcher({ fetch: async () => {
    let offset = 0;
    return new Response(new ReadableStream({ pull(c) { if (offset === bytes.length) c.close(); else c.enqueue(bytes.slice(offset, ++offset)); } }));
  } }), DEFAULT_LIMITS);
  const plan = await resolver.plan(source, { audioOnly: false, subtitleTrackIds: [], container: 'mp4' }, signal());
  expect(plan.protocol).toBe('hls'); expect(plan.parts[0].segments).toHaveLength(1);
});

test('DASH long-running negative-repeat timeline materializes only the live window', () => {
  const xml = '<MPD type="dynamic" availabilityStartTime="2026-01-01T00:00:00Z" timeShiftBufferDepth="PT6S"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v"><SegmentTemplate media="$Time$.m4s"><SegmentTimeline><S d="2" r="-1"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>';
  const now = Date.parse('2026-02-01T00:00:00Z');
  const d = parseDash(xml, source.exactUrl, false, now);
  expect(d.representations[0].segments).toHaveLength(3);
  const edge = (now - Date.parse('2026-01-01T00:00:00Z')) / 1000;
  expect(d.representations[0].segments.map(s => s.start)).toEqual([edge - 6, edge - 4, edge - 2]);
});

test('DASH live segment identity is timestamp-based when startNumber resets in sliding MPD', async () => {
  let time = 0;
  const resolver = new Resolver(createAuthorizedFetcher({ fetch: async () => new Response(`<MPD type="dynamic"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v"><SegmentTemplate media="$Time$.m4s"><SegmentTimeline><S t="${time}" d="2"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>`) }), DEFAULT_LIMITS);
  const first = await resolver.plan(source, { audioOnly: false, subtitleTrackIds: [], container: 'mp4' }, signal());
  time = 2;
  const next = await resolver.plan(source, first.selection, signal());
  expect(first.parts[0].segments[0].sequence).toBe(next.parts[0].segments[0].sequence);
  expect(first.parts[0].segments[0].id).not.toBe(next.parts[0].segments[0].id);
});

test('BCP47 language selection becomes valid mux language metadata without guessing', () => {
  expect(muxLanguage('en-US')).toBe('eng'); expect(muxLanguage('ru')).toBe('rus');
  expect(muxLanguage('fra')).toBe('fra'); expect(muxLanguage('unrecognized')).toBe('und');
});

test('429 honors Retry-After and stops after three retries', async () => {
  vi.useFakeTimers();
  try {
    let calls = 0; const started = Date.now();
    const fetcher = createAuthorizedFetcher({ fetch: async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': '2' } }); } });
    const result = expect(fetcher.request(source, source.exactUrl, { signal: signal() })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await vi.runAllTimersAsync(); await result;
    expect(calls).toBe(4); expect(Date.now() - started).toBeGreaterThanOrEqual(6000);
  } finally { vi.useRealTimers(); }
});

test('first-byte timeout is bounded and returns NETWORK_TIMEOUT', async () => {
  vi.useFakeTimers();
  try {
    const fetcher = createAuthorizedFetcher({ retries: 0, firstByteTimeoutMs: 10, fetch: async (_url, init) => new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })) });
    const result = expect(fetcher.request(source, source.exactUrl, { signal: signal() })).rejects.toMatchObject({ code: 'NETWORK_TIMEOUT' });
    await vi.runAllTimersAsync(); await result;
  } finally { vi.useRealTimers(); }
});

test('stalled body errors, releases global slot, and permits the next request', async () => {
  vi.useFakeTimers();
  try {
    let calls = 0;
    const fetcher = createAuthorizedFetcher({ concurrency: 1, retries: 0, firstByteTimeoutMs: 10, stallTimeoutMs: 10, fetch: async () => {
      calls++;
      if (calls > 1) return new Response('okay');
      let first = true;
      return new Response(new ReadableStream({ pull(c) { if (first) { first = false; c.enqueue(new Uint8Array([1])); } } }));
    } });
    const response = await fetcher.request(source, source.exactUrl, { signal: signal() });
    const result = expect(response.arrayBuffer()).rejects.toMatchObject({ code: 'NETWORK_TIMEOUT' });
    await vi.runAllTimersAsync(); await result;
    expect(await (await fetcher.request(source, source.exactUrl, { signal: signal() })).text()).toBe('okay');
  } finally { vi.useRealTimers(); }
});
