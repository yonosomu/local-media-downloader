import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Дополняет только собственный F corpus. Не запускает/не изменяет engine suite.
export async function generateProfiles(root, ffmpeg) {
  const file = name => path.join(root, name);
  ffmpeg(['-i', file('live-source.mp4'), '-t', '6', '-c', 'copy', file('source.mp4')]);
  for (const [name, args] of [
    ['source.mkv', ['-c', 'copy']],
    ['source.webm', ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus']],
    ['audio.m4a', ['-vn', '-c:a', 'copy']], ['audio.mp3', ['-vn', '-c:a', 'libmp3lame']],
    ['audio.ogg', ['-vn', '-c:a', 'libopus']], ['audio.wav', ['-vn', '-c:a', 'pcm_s16le']],
  ]) ffmpeg(['-i', file('source.mp4'), ...args, file(name)]);
  ffmpeg(['-i', file('source.mp4'), '-c', 'copy', '-hls_time', '2', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', file('fmp4-%d.m4s'), file('fmp4.m3u8')]);
  const playlist = await readFile(file('fmp4.m3u8'), 'utf8');
  const init = await readFile(file('init.mp4'));
  const fragments = await Promise.all([...playlist.matchAll(/^fmp4-\d+\.m4s$/gm)].map(m => readFile(file(m[0]))));
  await writeFile(file('range.mp4'), Buffer.concat([init, ...fragments]));
  let offset = init.length;
  await writeFile(file('range.m3u8'), `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="range.mp4",BYTERANGE="${init.length}@0"\n` + fragments.map(bytes => { const start = offset; offset += bytes.length; return `#EXTINF:2,\n#EXT-X-BYTERANGE:${bytes.length}@${start}\nrange.mp4\n`; }).join('') + '#EXT-X-ENDLIST\n');
  ffmpeg(['-i', file('source.mp4'), '-c', 'copy', '-f', 'dash', '-seg_duration', '2', file('dash.mpd')]);
  ffmpeg(['-i', file('source.mp4'), '-c', 'copy', '-f', 'dash', '-single_file', '1', '-use_template', '0', '-use_timeline', '0', '-seg_duration', '2', file('list.mpd')]);
  ffmpeg(['-i', file('source.mp4'), '-an', '-c:v', 'copy', '-movflags', '+dash+global_sidx+frag_keyframe', '-frag_duration', '2000000', file('base.mp4')]);
  const bytes = await readFile(file('base.mp4'));
  let index = 0;
  while (index + 8 < bytes.length && bytes.toString('ascii', index + 4, index + 8) !== 'sidx') {
    const length = bytes.readUInt32BE(index);
    if (length < 8) throw new Error('Неверный MP4 box');
    index += length;
  }
  if (bytes.toString('ascii', index + 4, index + 8) !== 'sidx') throw new Error('Нет sidx');
  await writeFile(file('base.mpd'), `<MPD mediaPresentationDuration="PT6S"><Period><AdaptationSet mimeType="video/mp4"><Representation id="v" codecs="avc1.42c00b"><BaseURL>base.mp4</BaseURL><SegmentBase indexRange="${index}-${index + bytes.readUInt32BE(index) - 1}"><Initialization range="0-${index - 1}"/></SegmentBase></Representation></AdaptationSet></Period></MPD>`);
  const dash = await readFile(file('dash.mpd'), 'utf8');
  const period = /<Period[\s\S]*?<\/Period>/.exec(dash)[0];
  await writeFile(file('periods.mpd'), `<MPD mediaPresentationDuration="PT12S">${[0, 1].map(i => period.replace(/<Period[^>]*>/, `<Period id="p${i}" start="PT${i * 6}S" duration="PT6S">`)).join('')}</MPD>`);
  await writeFile(file('template.mpd'), dash.replace(/<SegmentTemplate[\s\S]*?<\/SegmentTemplate>/g, template => template.replace(/<SegmentTimeline>[\s\S]*?<\/SegmentTimeline>/, '').replace('<SegmentTemplate ', ' <SegmentTemplate duration="2" ').replace(/timescale="\d+"/, 'timescale="1"')));
  await writeFile(file('discontinuity.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nq90-0.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:2,\nq90-1.ts\n#EXT-X-ENDLIST\n');
  await writeFile(file('config-change.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nq90-0.ts\n#EXTINF:2,\nq180-0.ts\n#EXT-X-ENDLIST\n');
  await writeFile(file('text.ttml'), '<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="ru"><body><div><p begin="0s" end="0.12s">Маркер 0</p><p begin="2s" end="2.12s">Маркер 1</p><p begin="4s" end="4.12s">Маркер 2</p></div></body></tt>');
  await writeFile(file('subtitles.mpd'), dash.replace('</Period>', '<AdaptationSet mimeType="application/ttml+xml" lang="ru"><Representation id="text" codecs="ttml"><BaseURL>text.ttml</BaseURL></Representation></AdaptationSet></Period>'));
  await writeFile(file('external.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:00.120\nМаркер 0\n\n00:00:02.000 --> 00:00:02.120\nМаркер 1\n');
  await writeFile(file('encrypted.m3u8'), '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="/forbidden-key"\n#EXTINF:2,\nq90-0.ts\n#EXT-X-ENDLIST\n');
  await writeFile(file('session-key.m3u8'), '#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="/forbidden-key"\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nq90.m3u8\n');
  await writeFile(file('drm.mpd'), dash.replace('</AdaptationSet>', '<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/></AdaptationSet>'));
  await writeFile(file('xxe.mpd'), '<!DOCTYPE MPD [<!ENTITY x SYSTEM "file:///not-a-real-secret">]><MPD><Period>&x;</Period></MPD>');
  await writeFile(file('private.m3u8'), '#EXTM3U\n#EXTINF:2,\nhttp://169.254.169.254/blocked\n#EXT-X-ENDLIST\n');
  await writeFile(file('invalid.m3u8'), '#EXTM3U\n#EXTINF:not-a-number,\n');
}
