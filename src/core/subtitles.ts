import { fail } from '../shared/errors';
import { parseXml, localName } from './xml';
export interface SubtitleSegment { text: string; start: number }
interface Cue { start: number; end: number; body: string }
function time(value: string): number {
  const m = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(value);
  if (!m) fail('INVALID_MANIFEST');
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}
function stamp(seconds: number): string {
  const ms = Math.round(seconds * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
export function mergeWebVtt(segments: SubtitleSegment[]): string {
  const cues: Cue[] = [], seen = new Set<string>();
  for (const segment of segments) {
    if (new TextEncoder().encode(segment.text).length > 8 * 1024 * 1024) fail('MANIFEST_LIMIT');
    const text = segment.text.replace(/^\uFEFF/, '').replace(/\r/g, '');
    if (!/^WEBVTT(?:[ \t].*)?\n/.test(text)) fail('INVALID_MANIFEST');
    const map = /X-TIMESTAMP-MAP=(?:LOCAL:([^,\n]+),MPEGTS:(\d+)|MPEGTS:(\d+),LOCAL:([^,\n]+))/.exec(text);
    let offset = segment.start;
    if (map) {
      const local = time(map[1] ?? map[4]), ticks = Number(map[2] ?? map[3]); if (!Number.isSafeInteger(ticks) || ticks < 0 || ticks >= 2 ** 33) fail('INVALID_MANIFEST');
      let mapped = ticks / 90000;
      const wrap = 2 ** 33 / 90000; mapped += Math.round((segment.start - mapped) / wrap) * wrap;
      offset = mapped - local;
    }
    for (const block of text.split(/\n\s*\n/).slice(1)) {
      const lines = block.split('\n');
      if (/^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0])) continue;
      const index = lines.findIndex(l => l.includes('-->')); if (index < 0) continue;
      const match = /^(\S+)\s+-->\s+(\S+)(.*)$/.exec(lines[index]); if (!match) fail('INVALID_MANIFEST');
      const start = time(match[1]) + offset, end = time(match[2]) + offset, body = `${match[3]}\n${lines.slice(index + 1).join('\n')}`;
      if (start < 0 || end <= start || !Number.isFinite(end)) fail('INVALID_MANIFEST');
      const key = `${start}:${end}:${body}`; if (!seen.has(key)) { seen.add(key); cues.push({ start, end, body }); }
      if (cues.length > 100000) fail('MANIFEST_LIMIT');
    }
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return `WEBVTT\n\n${cues.map(c => `${stamp(c.start)} --> ${stamp(c.end)}${c.body}`).join('\n\n')}\n`;
}
export function validateTtml(text: string): string {
  const root = parseXml(text); if (localName(root) !== 'tt') fail('UNSUPPORTED_FORMAT');
  const todo = [root];
  while (todo.length) {
    const node = todo.pop()!;
    // Text sidecars only: do not preserve external resources, scripts or image payloads.
    if (['image', 'script', 'audio', 'data'].includes(localName(node)) || Object.keys(node.attrs).some(k => /(?:^|:)(?:src|href)$/i.test(k))) fail('UNSUPPORTED_FORMAT');
    todo.push(...node.children);
  }
  return text;
}
