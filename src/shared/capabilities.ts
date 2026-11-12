import type { Container } from './contracts';
export function canonicalCodec(codec: string): string {
  const value = codec.toLowerCase();
  if (/^(avc[13]|h264)/.test(value)) return 'avc';
  if (/^(mp4a\.40|aac)/.test(value)) return 'aac';
  if (/^(vp09|vp9)/.test(value)) return 'vp9';
  return value;
}
export function containersFor(codecs: readonly string[], direct = false): Container[] {
  const c = codecs.map(canonicalCodec);
  const result: Container[] = [];
  if (c.length && c.every(x => x === 'avc' || x === 'aac')) {
    result.push('mp4', 'mkv');
    if (c.every(x => x === 'aac')) result.push('m4a');
  }
  if (c.length && c.every(x => x === 'vp9' || x === 'opus')) result.push('webm');
  if (c.length === 1 && c[0] === 'mp3') result.push('mp3');
  if (direct) result.push('original');
  return result;
}
export const CONTAINER_MIME: Record<Container, string> = { mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', m4a: 'audio/mp4', mp3: 'audio/mpeg', original: 'application/octet-stream' };
