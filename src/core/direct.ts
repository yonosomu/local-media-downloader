import { fail } from '../shared/errors';
export function directFormat(bytes: Uint8Array, mime = ''): { suffix: string; mime: string } {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (ascii(4, 8) === 'ftyp') {
    if (/(?:audio\/mp4|audio\/x-m4a)/i.test(mime) || /^M4[AB ]/.test(ascii(8, 12))) return { suffix: 'm4a', mime: 'audio/mp4' };
    return { suffix: 'mp4', mime: 'video/mp4' };
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return /webm/i.test(mime) || ascii(0, bytes.length).includes('webm') ? { suffix: 'webm', mime: 'video/webm' } : { suffix: 'mkv', mime: 'video/x-matroska' };
  if (ascii(0, 3) === 'ID3' || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0) return { suffix: 'mp3', mime: 'audio/mpeg' };
  if (ascii(0, 4) === 'OggS') return { suffix: 'ogg', mime: 'audio/ogg' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return { suffix: 'wav', mime: 'audio/wav' };
  return fail('UNSUPPORTED_FORMAT');
}
