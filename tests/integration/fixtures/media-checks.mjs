import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { mediaRoot } from '../../../scripts/fixtures-generate.mjs';

const ffmpeg = args => execFileSync('ffmpeg', ['-v', 'error', '-nostdin', ...args], { maxBuffer: 8 * 1024 * 1024 });
const probe = name => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path.join(mediaRoot, name)], { encoding: 'utf8' }));
// Малые decode windows; никогда не загружать весь 15-minute PCM/видео в RAM.
export function measureMarker(videoFile, audioFile, expectedSeconds) {
  const start = Math.max(0, expectedSeconds - 0.2);
  const video = ffmpeg(['-i', videoFile, '-ss', String(start), '-t', '0.5', '-an', '-vf', 'scale=1:1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-']);
  const rate = Number(JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate', '-of', 'json', videoFile], { encoding: 'utf8' })).streams[0].r_frame_rate.split('/').reduce((a, b) => Number(a) / Number(b)));
  const videoIndex = video.findIndex(v => v > 128);
  const audio = ffmpeg(['-i', audioFile, '-ss', String(start), '-t', '0.5', '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-']);
  let audioIndex = -1;
  for (let i = 0; i < audio.length / 2; i++) if (Math.abs(audio.readInt16LE(i * 2)) > 3000) { audioIndex = i; break; }
  assert(videoIndex >= 0 && audioIndex >= 0, `Не найден flash/tone у ${expectedSeconds}`);
  const videoSeconds = start + videoIndex / rate, audioSeconds = start + audioIndex / 48000;
  assert(Math.abs(videoSeconds - expectedSeconds) <= 0.1, 'Flash не в ожидаемом месте');
  assert(Math.abs(audioSeconds - expectedSeconds) <= 0.1, `Tone ${audioSeconds} не у ${expectedSeconds}, input ${audioFile}`);
  assert(Math.abs(videoSeconds - audioSeconds) <= 0.1, 'A/V marker >100ms');
  return { expectedSeconds, videoSeconds, audioSeconds, deltaSeconds: Math.abs(videoSeconds - audioSeconds) };
}

const generated = JSON.parse(await readFile('.test-data/fixtures-f/generated.json', 'utf8'));
const metadata = [], markers = [], variants = [];
for (const name of ['source.mp4', 'source.webm', 'source.mkv', 'audio.mp3', 'audio.m4a', 'audio.ogg', 'audio.wav', 'range.mp4', 'base.mp4', 'live-source.mp4']) {
  const p = probe(name);
  ffmpeg(['-xerror', '-i', path.join(mediaRoot, name), '-f', 'null', '-']);
  metadata.push({ name, sha256: generated.files.find(f => f.name === name).sha256, duration: Number(p.format.duration), bytes: Number(p.format.size), container: p.format.format_name, streams: p.streams.map(s => ({ codec: s.codec_name, kind: s.codec_type, width: s.width, height: s.height, rate: s.r_frame_rate, language: s.tags?.language })) });
}
assert(metadata.find(m => m.name === 'live-source.mp4').duration >= 906);
for (const height of [90, 180, 270]) {
  const p = probe(`q${height}.m3u8`); assert.equal(p.streams.find(s => s.codec_type === 'video').height, height);
  variants.push({ height, codecs: p.streams.map(s => s.codec_name) });
}
for (const [lang, expectedHz] of [['ru', 880], ['en', 440]]) {
  const pcm = ffmpeg(['-i', path.join(mediaRoot, `${lang}.m3u8`), '-t', '0.12', '-ac', '1', '-ar', '48000', '-f', 's16le', '-']);
  // Положительные zero crossings в устойчивой середине импульса, не AAC-атака.
  let crossings = 0;
  for (let i = 1441; i < 4320; i++) if (pcm.readInt16LE((i - 1) * 2) <= 0 && pcm.readInt16LE(i * 2) > 0) crossings++;
  const measuredHz = crossings / 0.06; assert(Math.abs(measuredHz - expectedHz) < 40);
  variants.push({ lang, expectedHz, measuredHz });
}
for (const t of [0, 2, 4, 452, 904]) markers.push(measureMarker(path.join(mediaRoot, 'live-source.mp4'), path.join(mediaRoot, 'live-source.mp4'), t));
// Раздельные входы 25fps + AAC, не только исходный мультиплексированный MP4.
for (const t of [0, 2, 4]) markers.push({ split: true, ...measureMarker(path.join(mediaRoot, 'q180.m3u8'), path.join(mediaRoot, 'en.m3u8'), t) });
assert.equal(await readFile(path.join(mediaRoot, 'expected.vtt'), 'utf8'), 'WEBVTT\n\n' + [0, 2, 4].map((t, i) => `00:00:0${t}.000 --> 00:00:0${t}.120\nМаркер ${i}\n`).join('\n'));
await mkdir('docs/evidence/t_ab1783c7', { recursive: true });
await writeFile('docs/evidence/t_ab1783c7/media-results.json', JSON.stringify({ schemaVersion: 1, scope: 'Эталоны INPUT, не результаты remux расширением/плеерная приёмка', command: 'node tests/integration/fixtures/media-checks.mjs', metadata, variants, markers, ffmpeg: generated.ffmpeg, status: 'passed' }, null, 2));
console.log(`Эталоны: ${metadata.length} файлов decode/ffprobe, ${markers.length} marker windows, 3 качества, 2 разных тона. passed`);
