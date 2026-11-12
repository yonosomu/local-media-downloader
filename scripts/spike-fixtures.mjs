import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
const base = 'spikes/002-remux-browser/extension';
const fixtures = [
  { name: 'video.mp4', args: ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=4', '-an', '-c:v', 'libx264', '-bf', '0', '-pix_fmt', 'yuv420p'] },
  { name: 'audio.m4a', args: ['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=4', '-af', 'volume=if(lt(mod(t\\,1)\\,0.1)\\,0.8\\,0):eval=frame', '-c:a', 'aac', '-b:a', '128k'] },
  { name: 'large-video.mp4', args: ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=4', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '14', '-bf', '0', '-g', '25', '-pix_fmt', 'yuv420p'] },
];
const records = [];
for (const fixture of fixtures) {
  const output = `${base}/${fixture.name}`;
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...fixture.args, '-y', output], { stdio: 'inherit' });
  records.push({ ...fixture, output, bytes: (await stat(output)).size, sha256: createHash('sha256').update(await readFile(output)).digest('hex'), ffprobe: JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { encoding: 'utf8' })) });
}
await writeFile('spikes/002-remux-browser/evidence/fixtures.json', JSON.stringify(records, null, 2));
console.log('Synthetic fixtures generated:', records.length);
