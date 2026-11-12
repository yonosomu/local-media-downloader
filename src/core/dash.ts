import { child, children, localName, parseXml, type XmlNode } from './xml';
import { mediaUrl } from './security';
import { fail } from '../shared/errors';
import type { ByteRange, Resource } from './hls';
export interface DashSegment extends Resource { start: number; duration: number; sequence: number; init?: Resource }
export interface DashRepresentation {
  id: string; periodId: string; periodStart: number; kind: 'video' | 'audio' | 'subtitle'; codec: string; mime: string;
  language?: string; role?: string; width?: number; height?: number; bitrate?: number; fps?: number;
  segments: DashSegment[]; segmentBase?: { url: string; indexRange: ByteRange; init?: Resource; timescale: number; presentationTimeOffset: number };
}
export interface DashManifest { live: boolean; minimumUpdatePeriod: number; representations: DashRepresentation[]; duration?: number; availabilityStartTime?: number; timeShiftBufferDepth?: number }
export function isoDuration(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!m || !m.slice(1).some(x => x !== undefined)) fail('INVALID_MANIFEST');
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}
function n(value: string | undefined, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!value || !/^\d+$/.test(value)) fail('INVALID_MANIFEST');
  const result = Number(value); if (!Number.isSafeInteger(result)) fail('INVALID_MANIFEST'); return result;
}
export function dashRange(value: string): ByteRange {
  const m = /^(\d+)-(\d+)$/.exec(value); if (!m) fail('INVALID_MANIFEST');
  const offset = n(m[1]), end = n(m[2]); if (end < offset || !Number.isSafeInteger(end + 1)) fail('INVALID_MANIFEST');
  return { offset, length: end - offset + 1 };
}
function template(value: string, id: string, bandwidth: number | undefined, number: number, time: number): string {
  return value.replace(/\$\$|\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/g, (match, token: string, width: string) => {
    if (match === '$$') return '$';
    const v = token === 'RepresentationID' ? id : token === 'Bandwidth' ? bandwidth : token === 'Number' ? number : time;
    if (v === undefined || (width && Number(width) > 32)) fail('INVALID_MANIFEST');
    return String(v).padStart(Number(width ?? 0), '0');
  });
}
export function parseDash(text: string, source: string, allowPrivate = false, now = Date.now()): DashManifest {
  const mpd = parseXml(text); if (localName(mpd) !== 'MPD') fail('INVALID_MANIFEST');
  const all: XmlNode[] = [mpd];
  for (let i = 0; i < all.length; i++) { if (localName(all[i]) === 'ContentProtection') fail('DRM_UNSUPPORTED'); all.push(...all[i].children); }
  const live = mpd.attrs.type === 'dynamic', duration = isoDuration(mpd.attrs.mediaPresentationDuration);
  const ast = mpd.attrs.availabilityStartTime === undefined ? undefined : Date.parse(mpd.attrs.availabilityStartTime);
  if (ast !== undefined && !Number.isFinite(ast)) fail('INVALID_MANIFEST');
  if (mpd.attrs.type && !['static', 'dynamic'].includes(mpd.attrs.type)) fail('INVALID_MANIFEST');
  const depth = isoDuration(mpd.attrs.timeShiftBufferDepth);
  const url = (value: string, base: string) => mediaUrl(value, base, allowPrivate);
  const baseOf = (node: XmlNode, base: string) => child(node, 'BaseURL') ? url(child(node, 'BaseURL')!.text.trim(), base) : base;
  const rootBase = baseOf(mpd, source), periods = children(mpd, 'Period');
  if (!periods.length) fail('INVALID_MANIFEST');
  const representations: DashRepresentation[] = [];
  let previousEnd = 0, segmentCount = 0;
  for (let p = 0; p < periods.length; p++) {
    const period = periods[p], periodId = period.attrs.id ?? `period-${p}`;
    const start = isoDuration(period.attrs.start) ?? previousEnd;
    if (start < previousEnd) fail('INVALID_MANIFEST');
    const nextStart = isoDuration(periods[p + 1]?.attrs.start);
    const periodDuration = isoDuration(period.attrs.duration) ?? (nextStart !== undefined ? nextStart - start : duration !== undefined ? duration - start : undefined);
    if (!live && periodDuration === undefined) fail('INVALID_MANIFEST');
    if (periodDuration !== undefined && periodDuration <= 0) fail('INVALID_MANIFEST');
    previousEnd = start + (periodDuration ?? 0);
    const periodBase = baseOf(period, rootBase);
    for (const adaptation of children(period, 'AdaptationSet')) for (const representation of children(adaptation, 'Representation')) {
      const a = { ...adaptation.attrs, ...representation.attrs }, id = a.id ?? `representation-${representations.length}`;
      const mime = a.mimeType ?? '', codec = a.codecs ?? '';
      const kind = a.contentType === 'audio' || mime.startsWith('audio/') ? 'audio' : a.contentType === 'text' || /text|ttml|vtt/.test(mime) ? 'subtitle' : 'video';
      const base = baseOf(representation, baseOf(adaptation, periodBase));
      const r: DashRepresentation = { id, periodId, periodStart: start, kind, codec, mime, segments: [],
        ...(a.lang ? { language: a.lang } : {}), ...(child(adaptation, 'Role') ? { role: child(adaptation, 'Role')!.attrs.value } : {}),
        ...(a.width ? { width: n(a.width) } : {}), ...(a.height ? { height: n(a.height) } : {}), ...(a.bandwidth ? { bitrate: n(a.bandwidth) } : {}) };
      if (a.frameRate) { const [top, bottom = '1'] = a.frameRate.split('/'); r.fps = n(top) / n(bottom); if (!Number.isFinite(r.fps)) fail('INVALID_MANIFEST'); }
      const hierarchy = [mpd, period, adaptation, representation];
      const modes = hierarchy.map(node => node.children.find(x => ['SegmentTemplate', 'SegmentList', 'SegmentBase'].includes(localName(x)))).filter((x): x is XmlNode => !!x);
      const mode = modes.at(-1);
      if (!mode) {
        if (kind !== 'subtitle') fail('INVALID_MANIFEST');
        r.segments.push({ url: base, start, duration: periodDuration ?? 0, sequence: 0 });
      } else {
        const name = localName(mode), nodes = modes.filter(x => localName(x) === name), attrs = Object.assign(Object.create(null), ...nodes.map(x => x.attrs));
        const timescale = n(attrs.timescale, 1), pto = n(attrs.presentationTimeOffset, 0), startNumber = n(attrs.startNumber, 1);
        if (!timescale) fail('INVALID_MANIFEST');
        const lastChild = (tag: string) => nodes.map(x => child(x, tag)).filter((x): x is XmlNode => !!x).at(-1);
        let init: Resource | undefined;
        const initialization = lastChild('Initialization');
        if (initialization) init = { url: url(initialization.attrs.sourceURL ?? base, base), ...(initialization.attrs.range ? { range: dashRange(initialization.attrs.range) } : {}) };
        if (name === 'SegmentTemplate' && attrs.initialization) init = { url: url(template(attrs.initialization, id, r.bitrate, startNumber, 0), base) };
        const append = (resource: Resource, time: number, d: number, number: number) => {
          if (time < pto || !Number.isSafeInteger(time + d)) fail('INVALID_MANIFEST');
          const seconds = start + (time - pto) / timescale;
          const edge = ast === undefined ? undefined : (now - ast) / 1000;
          if (live && edge !== undefined && (seconds + d / timescale > edge || seconds + d / timescale <= edge - (depth ?? 300))) return;
          if (++segmentCount > 100000) fail('MANIFEST_LIMIT');
          r.segments.push({ ...resource, start: seconds, duration: d / timescale, sequence: number, ...(init ? { init } : {}) });
        };
        if (name === 'SegmentBase') {
          if (!attrs.indexRange) fail('INVALID_MANIFEST');
          r.segmentBase = { url: base, indexRange: dashRange(attrs.indexRange), init, timescale, presentationTimeOffset: pto };
        } else {
          const timeline = lastChild('SegmentTimeline'), list = name === 'SegmentList' ? nodes.map(x => children(x, 'SegmentURL')).filter(x => x.length).at(-1) ?? [] : [];
          let sequence = startNumber, time = pto, listIndex = 0;
          const add = (t: number, d: number) => {
            const item = list[listIndex++];
            if (name === 'SegmentList' && !item) fail('INVALID_MANIFEST');
            if (name === 'SegmentTemplate' && !attrs.media) fail('INVALID_MANIFEST');
            append({ url: url(name === 'SegmentTemplate' ? template(attrs.media, id, r.bitrate, sequence, t) : item.attrs.media ?? base, base), ...(item?.attrs.mediaRange ? { range: dashRange(item.attrs.mediaRange) } : {}) }, t, d, sequence++);
          };
          if (timeline) {
            const entries = children(timeline, 'S');
            for (let i = 0; i < entries.length; i++) {
              const s = entries[i].attrs, d = n(s.d); if (!d) fail('INVALID_MANIFEST');
              if (s.t !== undefined) time = n(s.t);
              let repeat: number;
              if (s.r === '-1') {
                const boundary = entries[i + 1]?.attrs.t !== undefined ? n(entries[i + 1].attrs.t) : periodDuration !== undefined ? pto + periodDuration * timescale : live && ast !== undefined ? pto + ((now - ast) / 1000 - start) * timescale : undefined;
                if (boundary === undefined) fail('INVALID_MANIFEST'); repeat = Math.max(0, Math.ceil((boundary - time) / d) - 1);
              } else repeat = n(s.r, 0);
              let first = 0, last = repeat;
              if (live && ast !== undefined) {
                const edge = ((now - ast) / 1000 - start) * timescale + pto;
                first = Math.max(0, Math.ceil((edge - (depth ?? 300) * timescale - time) / d) - 1);
                last = Math.min(repeat, Math.floor((edge - time) / d) - 1);
              }
              first = Math.min(first, repeat + 1);
              if (last - first > 100000 || !Number.isSafeInteger(time + (repeat + 1) * d)) fail('MANIFEST_LIMIT');
              sequence += first; listIndex += first;
              for (let j = first; j <= last; j++) add(time + j * d, d);
              const rest = repeat + 1 - Math.max(first, last + 1);
              sequence += rest; listIndex += rest; time += (repeat + 1) * d;
            }
          } else {
            const d = n(attrs.duration); if (!d) fail('INVALID_MANIFEST');
            let count = list.length;
            if (name === 'SegmentTemplate') {
              if (live) {
                if (ast === undefined) fail('INVALID_MANIFEST');
                const edge = Math.max(0, (now - ast) / 1000 - start);
                const first = Math.max(0, Math.floor((edge - (depth ?? 300)) * timescale / d)); sequence += first; time += first * d;
                count = Math.max(0, Math.floor(edge * timescale / d) - first);
              } else count = Math.ceil(periodDuration! * timescale / d);
            }
            if (count > 100000) fail('MANIFEST_LIMIT');
            for (let i = 0; i < count; i++) { add(time, d); time += d; }
          }
          if (name === 'SegmentList' && listIndex !== list.length) fail('INVALID_MANIFEST');
        }
      }
      representations.push(r); if (representations.length > 10000) fail('MANIFEST_LIMIT');
    }
  }
  if (!representations.length) fail('INVALID_MANIFEST');
  return { live, minimumUpdatePeriod: Math.max(1, isoDuration(mpd.attrs.minimumUpdatePeriod) ?? 5), representations, ...(duration !== undefined ? { duration } : {}), ...(ast !== undefined ? { availabilityStartTime: ast } : {}), ...(depth !== undefined ? { timeShiftBufferDepth: depth } : {}) };
}
/** ISO BMFF sidx, including 64-bit version1. Hierarchical references are not media ranges. */
export function parseSidx(bytes: Uint8Array, absoluteOffset: number): DashSegment[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u64 = (at: number) => { const v = view.getBigUint64(at); if (v > BigInt(Number.MAX_SAFE_INTEGER)) fail('MANIFEST_LIMIT'); return Number(v); };
  let pos = 0;
  try {
    while (pos + 8 <= bytes.length) {
      let size = view.getUint32(pos), header = 8; const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
      if (size === 1) { size = u64(pos + 8); header = 16; }
      if (size < header || pos + size > bytes.length) fail('INVALID_MANIFEST');
      if (type !== 'sidx') { pos += size; continue; }
      let at = pos + header; const version = view.getUint8(at); if (version > 1) fail('INVALID_MANIFEST'); at += 8;
      const timescale = view.getUint32(at); at += 4; if (!timescale) fail('INVALID_MANIFEST');
      let time = version ? u64(at) : view.getUint32(at); at += version ? 8 : 4;
      const firstOffset = version ? u64(at) : view.getUint32(at); at += version ? 8 : 4;
      at += 2; const count = view.getUint16(at); at += 2;
      let offset = absoluteOffset + pos + size + firstOffset;
      const result: DashSegment[] = [];
      for (let i = 0; i < count; i++) {
        if (at + 12 > pos + size) fail('INVALID_MANIFEST');
        const reference = view.getUint32(at), length = reference & 0x7fffffff, duration = view.getUint32(at + 4); at += 12;
        if (reference >>> 31 || !length || !duration || !Number.isSafeInteger(offset + length)) fail('INVALID_MANIFEST');
        result.push({ url: '', range: { offset, length }, start: time / timescale, duration: duration / timescale, sequence: i }); offset += length; time += duration;
      }
      return result;
    }
  } catch (error) { if (error instanceof RangeError) fail('INVALID_MANIFEST'); throw error; }
  return fail('INVALID_MANIFEST');
}
