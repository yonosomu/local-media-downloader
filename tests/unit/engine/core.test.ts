import { expect, test } from 'vitest';
import { parseDash, parseSidx } from '../../../src/core/dash';
import { parseXml } from '../../../src/core/xml';
import { containersFor } from '../../../src/shared/capabilities';
import { outputName, relativeDirectory, safeComponent } from '../../../src/core/filename';
import { mergeWebVtt, validateTtml } from '../../../src/core/subtitles';
import { DEFAULT_SETTINGS } from '../../../src/shared/contracts';
import { validateEnvelope, validateSettings, validateHostSender, validateHintBinding } from '../../../src/shared/validation';
const wrap = (content: string, attrs = 'mediaPresentationDuration="PT4S"') => `<MPD ${attrs}><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" codecs="avc1.42001e" bandwidth="800000">${content}</Representation></AdaptationSet></Period></MPD>`;
const source = 'https://cdn.example/movie/index.mpd';
test('DASH templates, relative BaseURL, inherited timeline and template escapes', () => {
  const d = parseDash(`<MPD mediaPresentationDuration="PT4S"><BaseURL>../media/</BaseURL><Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="10" media="$RepresentationID$-$Number%03d$-$Time$.m4s?sig=a%2Bb" initialization="init.mp4"><SegmentTimeline><S t="20" d="20" r="1"/></SegmentTimeline></SegmentTemplate><Representation id="v" codecs="avc1.42" bandwidth="8"><SegmentTemplate presentationTimeOffset="20"/></Representation></AdaptationSet></Period></MPD>`, source);
  expect(d.representations[0].segments.map(s => [s.url, s.start, s.duration])).toEqual([['https://cdn.example/media/v-001-20.m4s?sig=a%2Bb', 0, 2], ['https://cdn.example/media/v-002-40.m4s?sig=a%2Bb', 2, 2]]);
});
test('DASH List, Base index, sequential Period and finite negative repeats', () => {
  const list = parseDash(wrap('<SegmentList duration="2"><Initialization sourceURL="init.mp4" range="0-99"/><SegmentURL media="all.mp4" mediaRange="100-199"/><SegmentURL media="all.mp4" mediaRange="200-299"/></SegmentList>'), source);
  expect(list.representations[0].segments[1].range).toEqual({ offset: 200, length: 100 });
  const base = parseDash(wrap('<BaseURL>all.mp4</BaseURL><SegmentBase indexRange="100-155"><Initialization range="0-99"/></SegmentBase>'), source);
  expect(base.representations[0].segmentBase?.init?.range).toEqual({ offset: 0, length: 100 });
  const periods = parseDash('<MPD mediaPresentationDuration="PT8S">' + [0, 4].map(start => `<Period start="PT${start}S" duration="PT4S"><AdaptationSet mimeType="video/mp4"><Representation id="v"><SegmentTemplate timescale="1" media="$Time$.m4s"><SegmentTimeline><S d="2" r="-1"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period>`).join('') + '</MPD>', source);
  expect(periods.representations.flatMap(r => r.segments.map(s => s.start))).toEqual([0, 2, 4, 6]);
});
test('DASH live uses available completed window, not the full history', () => {
  const d = parseDash(wrap('<SegmentTemplate media="$Number$.m4s" duration="2"/>', 'type="dynamic" availabilityStartTime="2026-01-01T00:00:00Z" timeShiftBufferDepth="PT6S"'), source, false, Date.parse('2026-01-01T00:01:40Z'));
  expect(d.representations[0].segments.map(s => s.sequence)).toEqual([48, 49, 50]);
});
test('bounded XML rejects DTD, malformed trees, duplicate attributes and unknown entities', () => {
  for (const xml of ['<!DOCTYPE MPD SYSTEM "file:///etc/passwd"><MPD/>', '<MPD><Period></MPD>', '<MPD a="1" a="2"/>', '<MPD>&secret;</MPD>', '<MPD/><MPD/>']) expect(() => parseXml(xml)).toThrow();
  expect(parseXml('<MPD a="a&amp;b"><BaseURL>x</BaseURL></MPD>').attrs.a).toBe('a&b');
  expect(() => parseDash(wrap('<ContentProtection/>'), source)).toThrow('DRM');
  expect(() => parseDash(wrap('<BaseURL>http://127.0.0.1/all.mp4</BaseURL><SegmentBase indexRange="0-50"/>'), source)).toThrow();
  expect(() => parseDash(wrap('<SegmentTemplate media="$Time$"><SegmentTimeline><S d="1" r="100001"/></SegmentTimeline></SegmentTemplate>'), source)).toThrow();
});
test('sidx maps absolute offsets, time and duration and rejects indirect references', () => {
  const b = new Uint8Array(56), v = new DataView(b.buffer); v.setUint32(0, 56); b.set([115, 105, 100, 120], 4); v.setUint32(16, 1000); v.setUint32(20, 2000); v.setUint32(24, 4); v.setUint16(30, 2); v.setUint32(32, 100); v.setUint32(36, 2000); v.setUint32(44, 200); v.setUint32(48, 2000);
  expect(parseSidx(b, 100).map(s => [s.range, s.start, s.duration])).toEqual([[{ offset: 160, length: 100 }, 2, 2], [{ offset: 260, length: 200 }, 4, 2]]);
  v.setUint32(32, 0x80000001); expect(() => parseSidx(b, 100)).toThrow();
});
test('codec/container table refuses renamed AAC as MP3', () => {
  expect(containersFor(['avc1.42001e', 'mp4a.40.2'])).toEqual(['mp4', 'mkv']);
  expect(containersFor(['vp09.00', 'opus'])).toEqual(['webm']);
  expect(containersFor(['aac'])).toContain('m4a'); expect(containersFor(['aac'])).not.toContain('mp3');
});
test('filename normalization, directories and unknown template tokens', () => {
  expect(outputName('{title} [{height}p] [{audioLang}]', { title: 'Movie' }, 'mp4')).toBe('Movie.mp4');
  expect(safeComponent('CON.mp4')).toBe('_CON.mp4');
  for (const p of ['../a', '/tmp', 'C:\\a', 'a/../b', 'a//b', 'a/CON']) expect(() => relativeDirectory(p)).toThrow();
  expect(() => outputName('{unknown}', {}, 'mp4')).toThrow();
});
test('segmented VTT offsets and dedup, timestamp mapping, TTML rejects external images', () => {
  const vtt = 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n';
  const result = mergeWebVtt([{ text: vtt, start: 0 }, { text: vtt, start: 0 }, { text: vtt, start: 2 }]);
  expect(result.match(/Hello/g)).toHaveLength(2); expect(result).toContain('00:00:02.000 --> 00:00:03.000');
  expect(mergeWebVtt([{ text: 'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:900000\n\n00:00.000 --> 00:01.000\nHello', start: 10 }])).toContain('00:00:10.000');
  expect(validateTtml('<tt><body><p begin="1s">Text</p></body></tt>')).toContain('Text');
  expect(() => validateTtml('<tt><image src="https://evil.example/a"/></tt>')).toThrow();
});
test('settings and command boundaries reject unknown fields and forged/stale sender', () => {
  expect(validateSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  for (const settings of [{ ...DEFAULT_SETTINGS, jobsConcurrency: 5 }, { ...DEFAULT_SETTINGS, schemaVersion: 2 }, { ...DEFAULT_SETTINGS, exactUrl: 'secret' }, { ...DEFAULT_SETTINGS, firstByteTimeoutMs: Infinity }]) expect(() => validateSettings(settings)).toThrow();
  const envelope = { version: 1, requestId: crypto.randomUUID(), type: 'PAUSE_JOB', payload: { jobId: 'job', expectedRevision: 2 } };
  expect(validateEnvelope(envelope).type).toBe('PAUSE_JOB');
  expect(() => validateEnvelope({ ...envelope, payload: { ...envelope.payload, url: 'https://evil.example' } })).toThrow();
  expect(() => validateHostSender({ id: 'x', url: 'chrome-extension://x/popup.html' }, 'x', 'chrome-extension://x/offscreen/host.html')).toThrow();
  expect(() => validateHintBinding({ tab: { id: 1 }, frameId: 0, documentId: 'doc' }, { tabId: 1, frameId: 0, documentId: 'doc', generation: 2, documentKey: 'key' }, { kind: 'video', generation: 1, documentKey: 'key', url: 'https://cdn.example/a' })).toThrow();
});
