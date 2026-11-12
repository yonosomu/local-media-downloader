import { expect, test } from 'vitest';

test('HLS fMP4 byte ranges resolve into an ordered immutable timeline', async () => {
  const module = await import('../../src/core/hls.ts').catch(() => ({}));
  expect('parseHls' in module, 'HLS planning is not implemented').toBe(true);
  if (!('parseHls' in module)) return;
  const plan = module.parseHls(`#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:41
#EXT-X-MAP:URI="data.mp4",BYTERANGE="100@0"
#EXTINF:2,
#EXT-X-BYTERANGE:50@100
data.mp4?sig=keep%2Bme
#EXTINF:2,
#EXT-X-BYTERANGE:60
data.mp4?sig=keep%2Bme
#EXT-X-ENDLIST`, 'https://cdn.example/v/index.m3u8');
  expect(plan.kind).toBe('media');
  if (plan.kind !== 'media') return;
  expect(plan.live).toBe(false);
  expect(plan.segments.map(s => [s.sequence, s.start, s.duration, s.range])).toEqual([[41, 0, 2, { offset: 100, length: 50 }], [42, 2, 2, { offset: 150, length: 60 }]]);
  expect(plan.segments[0].url).toBe('https://cdn.example/v/data.mp4?sig=keep%2Bme');
  expect(plan.segments[0].init).toEqual({ url: 'https://cdn.example/v/data.mp4', range: { offset: 0, length: 100 } });
});

test('encrypted HLS is refused rather than planned as clear media', async () => {
  const { parseHls } = await import('../../src/core/hls');
  for (const key of ['#EXT-X-KEY:METHOD=AES-128,URI="key"', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"', '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="key"']) {
    expect(() => parseHls(`#EXTM3U\n${key}\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST`, 'https://cdn.example/a.m3u8')).toThrow('ENCRYPTED_UNSUPPORTED');
  }
  expect(() => parseHls('#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST', 'https://cdn.example/a.m3u8')).not.toThrow();
});

test('HLS master exposes quality, audio groups and subtitle language without losing URI signatures', async () => {
  const { parseHls } = await import('../../src/core/hls');
  const master = parseHls(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Русский, основной",LANGUAGE="ru",URI="ru.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",URI="en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Русский",LANGUAGE="ru",URI="s.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="avc1.42E01E,mp4a.40.2",AUDIO="aud",SUBTITLES="subs"
360.m3u8?sig=a%2Bb
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,AUDIO="aud"
720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,AUDIO="aud"
1080.m3u8`, 'https://cdn.example/master.m3u8');
  expect(master.kind).toBe('master');
  if (master.kind !== 'master') return;
  expect(master.variants.map(v => v.height)).toEqual([360, 720, 1080]);
  expect(master.variants[0].codecs).toEqual(['avc1.42E01E', 'mp4a.40.2']);
  expect(master.variants[0].url).toBe('https://cdn.example/360.m3u8?sig=a%2Bb');
  expect(master.tracks.map(t => [t.kind, t.language, t.group])).toEqual([['audio', 'ru', 'aud'], ['audio', 'en', 'aud'], ['subtitle', 'ru', 'subs']]);
  expect(master.tracks[0].label).toBe('Русский, основной');
});
