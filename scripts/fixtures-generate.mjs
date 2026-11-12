import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { generateProfiles } from './fixtures-profiles.mjs';

// Только новые synthetic inputs; существующий engine corpus не перезаписывается.
export const mediaRoot = path.resolve('.test-data/fixtures-f/media');
export async function generateFixtures({ liveSeconds = 906 } = {}) {
  if (!Number.isInteger(liveSeconds) || liveSeconds < 8 || liveSeconds > 3600 || liveSeconds % 2) throw new Error('Нужна чётная длительность 8–3600 секунд');
  await mkdir(mediaRoot, { recursive: true });
  const commands = [];
  const ffmpeg = args => { commands.push(['ffmpeg', '-v', 'error', '-y', ...args]); execFileSync('ffmpeg', commands.at(-1).slice(1), { stdio: 'pipe' }); };
  const output = file => path.join(mediaRoot, file);
  const markerVideo = (size, duration, rate = 25) => `color=c=black:s=${size}:r=${rate}:d=${duration},drawbox=color=white:t=fill:enable=lt(mod(t\\,2)\\,0.12)`;
  const markerAudio = (frequency, duration) => `aevalsrc=if(lt(mod(t\\,2)\\,0.12)\\,0.7*sin(2*PI*${frequency}*t)\\,0):s=48000:d=${duration}`;
  for (const [width, height] of [[160, 90], [320, 180], [480, 270]]) {
    ffmpeg(['-f', 'lavfi', '-i', markerVideo(`${width}x${height}`, 6), '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '0', '-g', '50', '-pix_fmt', 'yuv420p', '-f', 'hls', '-hls_time', '2', '-hls_segment_filename', output(`q${height}-%d.ts`), output(`q${height}.m3u8`)]);
  }
  for (const [language, frequency] of [['ru', 880], ['en', 440]]) {
    ffmpeg(['-f', 'lavfi', '-i', markerAudio(frequency, 6), '-c:a', 'aac', '-b:a', '96k', '-metadata:s:a:0', `language=${language === 'ru' ? 'rus' : 'eng'}`, '-f', 'hls', '-hls_time', '2', '-hls_segment_filename', output(`${language}-%d.ts`), output(`${language}.m3u8`)]);
  }
  await writeFile(output('master.m3u8'), '#EXTM3U\n#EXT-X-VERSION:3\n' + ['ru', 'en'].map(lang => `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="${lang}",LANGUAGE="${lang}",URI="${lang}.m3u8"\n`).join('') + '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="ru",LANGUAGE="ru",URI="sub.m3u8"\n' + [[160,90,100000],[320,180,200000],[480,270,300000]].map(([w,h,b]) => `#EXT-X-STREAM-INF:BANDWIDTH=${b},RESOLUTION=${w}x${h},CODECS="avc1.42c00c,mp4a.40.2",AUDIO="a",SUBTITLES="s"\nq${h}.m3u8\n`).join(''));
  await writeFile(output('sub.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:2\n' + [0,1,2].map(i => `#EXTINF:2,\nsub-${i}.vtt\n`).join('') + '#EXT-X-ENDLIST\n');
  for (let i = 0; i < 3; i++) await writeFile(output(`sub-${i}.vtt`), `WEBVTT\n\n00:00.000 --> 00:00.120\nМаркер ${i}\n`);
  await writeFile(output('expected.vtt'), 'WEBVTT\n\n' + [0,2,4].map((t,i) => `00:00:0${t}.000 --> 00:00:0${t}.120\nМаркер ${i}\n`).join('\n'));
  // Длинный, но малый по байтам источник: настоящие непрерывные PTS, не повтор одного fragment.
  ffmpeg(['-f', 'lavfi', '-i', markerVideo('160x90', liveSeconds, 10), '-f', 'lavfi', '-i', markerAudio(880, liveSeconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-bf', '0', '-g', '20', '-c:a', 'aac', '-b:a', '32k', '-shortest', output('live-source.mp4')]);
  ffmpeg(['-i', output('live-source.mp4'), '-c', 'copy', '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_filename', output('live-%05d.ts'), output('live-static.m3u8')]);
  ffmpeg(['-i', output('live-source.mp4'), '-c', 'copy', '-f', 'dash', '-seg_duration', '2', '-init_seg_name', 'live-init-$RepresentationID$.mp4', '-media_seg_name', 'live-chunk-$RepresentationID$-$Number%05d$.m4s', output('live-static.mpd')]);
  await generateProfiles(mediaRoot, ffmpeg);
  const files = [];
  for (const name of (await readdir(mediaRoot)).sort()) {
    const info = await stat(output(name));
    files.push({ name, bytes: info.size, sha256: createHash('sha256').update(await readFile(output(name))).digest('hex') });
  }
  const record = { schemaVersion: 1, liveSeconds, generatedAt: new Date().toISOString(), ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0], commands, markers: { timesSeconds: [0,2,4], whiteFlashAndToneSeconds: 0.12, audioHz: { ru: 880, en: 440 }, toleranceSeconds: 0.1 }, files };
  await writeFile(path.resolve('.test-data/fixtures-f/generated.json'), JSON.stringify(record, null, 2));
  console.log(`Сгенерированы входы F: ${files.length} файлов, live ${liveSeconds} секунд.`);
  return record;
}
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) await generateFixtures();
