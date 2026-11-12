import { mediaUrl } from './security';

export interface ByteRange { readonly offset: number; readonly length: number }
export interface Resource { readonly url: string; readonly range?: ByteRange }
export interface Segment extends Resource {
  readonly sequence: number; readonly start: number; readonly duration: number;
  readonly discontinuity: number; readonly init?: Resource;
}
export interface MediaPlaylist {
  readonly kind: 'media'; readonly live: boolean; readonly targetDuration: number;
  readonly segments: readonly Segment[];
}
export interface HlsVariant extends Resource {
  readonly id: string; readonly width?: number; readonly height?: number;
  readonly bitrate: number; readonly codecs: readonly string[];
  readonly audioGroup?: string; readonly subtitleGroup?: string; readonly fps?: number;
}
export interface HlsTrack {
  readonly id: string; readonly kind: 'audio' | 'subtitle'; readonly group: string;
  readonly label: string; readonly language?: string; readonly url?: string;
}
export interface MasterPlaylist {
  readonly kind: 'master'; readonly variants: readonly HlsVariant[]; readonly tracks: readonly HlsTrack[];
}
export function attributes(text: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  for (const match of text.matchAll(pattern)) result[match[1]] = match[2].replace(/^"|"$/g, '');
  return result;
}
function number(value: string | undefined, integer = false): number {
  const n = Number(value);
  if (value === undefined || value.trim() === '' || !Number.isFinite(n) || n < 0 || (integer && !Number.isSafeInteger(n))) throw new Error('INVALID_MANIFEST');
  return n;
}
function byteRange(value: string, previous?: ByteRange): ByteRange {
  const [length, offset] = value.split('@');
  const result = { length: number(length, true), offset: offset === undefined ? (previous ? previous.offset + previous.length : -1) : number(offset, true) };
  if (result.length === 0 || result.offset < 0 || !Number.isSafeInteger(result.offset + result.length)) throw new Error('INVALID_MANIFEST');
  return Object.freeze(result);
}
export function parseHls(text: string, source: string, allowPrivate = false): MediaPlaylist | MasterPlaylist {
  if (new TextEncoder().encode(text).length > 8 * 1024 * 1024) throw new Error('MANIFEST_LIMIT');
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/).map(s => s.trim());
  if (lines[0] !== '#EXTM3U') throw new Error('INVALID_MANIFEST');
  for (const line of lines) {
    if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
      if (attributes(line.slice(line.indexOf(':') + 1)).METHOD !== 'NONE') throw new Error('ENCRYPTED_UNSUPPORTED');
    }
  }
  if (lines.some(line => line.startsWith('#EXT-X-STREAM-INF:'))) return parseMaster(lines, source, allowPrivate);
  let sequence = 0, start = 0, discontinuity = 0, duration: number | undefined;
  let targetDuration = 6, live = true, pendingRange: string | undefined, init: Resource | undefined;
  const segments: Segment[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith('#EXT-X-TARGETDURATION:')) { targetDuration = number(line.split(':')[1]); if (!targetDuration) throw new Error('INVALID_MANIFEST'); }
    else if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) discontinuity = number(line.split(':')[1], true);
    else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) sequence = number(line.split(':')[1], true);
    else if (line.startsWith('#EXTINF:')) duration = number(line.slice(8).split(',')[0]);
    else if (line === '#EXT-X-ENDLIST') live = false;
    else if (line === '#EXT-X-DISCONTINUITY') discontinuity++;
    else if (line.startsWith('#EXT-X-BYTERANGE:')) pendingRange = line.slice(17);
    else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = attributes(line.slice(11));
      if (!attrs.URI) throw new Error('INVALID_MANIFEST');
      init = Object.freeze({ url: mediaUrl(attrs.URI, source, allowPrivate), ...(attrs.BYTERANGE ? { range: byteRange(attrs.BYTERANGE) } : {}) });
    } else if (line && !line.startsWith('#')) {
      if (duration === undefined) throw new Error('INVALID_MANIFEST');
      const url = mediaUrl(line, source, allowPrivate);
      const previous = segments.at(-1);
      const range = pendingRange ? byteRange(pendingRange, previous?.url === url ? previous.range : undefined) : undefined;
      segments.push(Object.freeze({ url, sequence: sequence++, start, duration, discontinuity, ...(range ? { range } : {}), ...(init ? { init } : {}) }));
      start += duration; duration = undefined; pendingRange = undefined;
      if (!Number.isSafeInteger(sequence) || !Number.isFinite(start)) throw new Error('INVALID_MANIFEST');
      if (segments.length > 100000) throw new Error('MANIFEST_LIMIT');
    }
  }
  if (!segments.length || duration !== undefined) throw new Error('INVALID_MANIFEST');
  return Object.freeze({ kind: 'media', live, targetDuration, segments: Object.freeze(segments) });
}

function parseMaster(lines: string[], source: string, allowPrivate: boolean): MasterPlaylist {
  const variants: HlsVariant[] = [], tracks: HlsTrack[] = [];
  let pending: Record<string, string> | undefined;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = attributes(line.slice(13));
      if (a.TYPE === 'AUDIO' || a.TYPE === 'SUBTITLES') {
        if (!a['GROUP-ID'] || !a.NAME) throw new Error('INVALID_MANIFEST');
        tracks.push(Object.freeze({ id: `track-${tracks.length}`, kind: a.TYPE === 'AUDIO' ? 'audio' : 'subtitle', group: a['GROUP-ID'], label: a.NAME, language: a.LANGUAGE, ...(a.URI ? { url: mediaUrl(a.URI, source, allowPrivate) } : {}) }));
      }
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      if (pending) throw new Error('INVALID_MANIFEST');
      pending = attributes(line.slice(18));
    } else if (line && !line.startsWith('#') && pending) {
      const [width, height] = pending.RESOLUTION?.split('x').map(s => number(s, true)) ?? [];
      variants.push(Object.freeze({
        id: `variant-${variants.length}`, url: mediaUrl(line, source, allowPrivate),
        bitrate: number(pending['AVERAGE-BANDWIDTH'] ?? pending.BANDWIDTH, true), width, height,
        codecs: Object.freeze(pending.CODECS?.split(',').map(s => s.trim()) ?? []),
        audioGroup: pending.AUDIO, subtitleGroup: pending.SUBTITLES,
        fps: pending['FRAME-RATE'] ? number(pending['FRAME-RATE']) : undefined,
      }));
      pending = undefined;
    }
    if (variants.length + tracks.length > 100000) throw new Error('MANIFEST_LIMIT');
  }
  if (pending || !variants.length) throw new Error('INVALID_MANIFEST');
  return Object.freeze({ kind: 'master', variants: Object.freeze(variants), tracks: Object.freeze(tracks) });
}
