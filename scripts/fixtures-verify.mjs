import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
const root = path.resolve('.test-data/fixtures-f/media');
const generated = JSON.parse(await readFile('.test-data/fixtures-f/generated.json', 'utf8'));
const results = [];
for (const file of generated.files) assert.equal(createHash('sha256').update(await readFile(path.join(root,file.name))).digest('hex'), file.sha256);
const probe = file => JSON.parse(execFileSync('ffprobe', ['-v','error','-show_streams','-show_format','-of','json',path.join(root,file)], { encoding: 'utf8' }));
for (const height of [90,180,270]) {
  const actual = probe(`q${height}.m3u8`); assert.equal(actual.streams[0].height,height); assert(Math.abs(Number(actual.format.duration)-6) < 0.5);
  results.push({ id: `quality-${height}`, status: 'passed', height: actual.streams[0].height, duration: Number(actual.format.duration) });
}
const video = execFileSync('ffmpeg', ['-v','error','-i',path.join(root,'q180.m3u8'),'-vf','scale=1:1,format=gray','-f','rawvideo','pipe:1']);
const flashes = [];
for (let i=0;i<video.length;i++) if(video[i]>200 && (i===0 || video[i-1]<=200)) flashes.push(i/25);
assert.equal(flashes.length,3);
for (const [lang,hz] of [['ru',880],['en',440]]) {
  const audio = execFileSync('ffmpeg', ['-v','error','-i',path.join(root,`${lang}.m3u8`),'-ac','1','-ar','48000','-f','f32le','pipe:1'], { maxBuffer: 4*1024*1024 });
  const tones=[]; let active=false;
  for(let i=0;i<audio.length/4;i+=480) {
    let peak=0; for(let j=i;j<Math.min(i+480,audio.length/4);j++) peak=Math.max(peak,Math.abs(audio.readFloatLE(j*4)));
    const present=peak>0.15; if(present&&!active) tones.push(i/48000); active=present;
  }
  assert.equal(tones.length,3);
  const offsets=flashes.map((t,i)=>tones[i]-t); assert(offsets.every(x=>Math.abs(x)<=0.1));
  let crossings=0; const start=Math.round((tones[1]+0.03)*48000), length=2400;
  for(let i=start+1;i<start+length;i++) if(audio.readFloatLE((i-1)*4)<=0 && audio.readFloatLE(i*4)>0) crossings++;
  const frequency=crossings/(length/48000); assert(Math.abs(frequency-hz)<30);
  results.push({ id:`markers-${lang}`, status:'passed', flashes, tones, offsetsSeconds:offsets, frequencyHz:frequency, expectedHz:hz });
}
const live=probe('live-source.mp4'); assert(Number(live.format.duration)>=906); assert.deepEqual(live.streams.map(s=>s.codec_name),['h264','aac']);
for(const seconds of [0,450,900]) execFileSync('ffmpeg',['-v','error','-ss',String(seconds),'-i',path.join(root,'live-source.mp4'),'-t','1','-f','null','-'],{stdio:'pipe'});
results.push({id:'live-source-continuous-PTS-seek',status:'passed',duration:Number(live.format.duration),seekSeconds:[0,450,900],scope:'Верификация входа; не browser live15min acceptance'});
await writeFile('docs/evidence/t_ab1783c7/media-verification.json', JSON.stringify({checkedAt:new Date().toISOString(),verifiedHashes:generated.files.length,results},null,2));
console.log(JSON.stringify(results,null,2));
