import type { AuthorizedSource, AuthorizedFetcher, DownloadPlan, Selection, ResolvedMedia, PlannedTrack, PlannedSegment, RuntimeLimits, SafeError } from '../shared/contracts';
import { canonicalCodec, containersFor } from '../shared/capabilities';
import { fail, safeError } from '../shared/errors';
import { parseHls, type MediaPlaylist, type Resource } from '../core/hls';
import { parseDash, parseSidx, type DashManifest, type DashRepresentation } from '../core/dash';
import { authorizeUrl, boundedText } from './fetch';
import { probeResource } from './probe';
export interface PlanRuntime { resources: Map<string, Resource>; media: ResolvedMedia; refreshSeconds: number; warnings: SafeError[] }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export class Resolver {
  readonly plans = new Map<string, PlanRuntime>();
  constructor(private readonly fetcher: AuthorizedFetcher, private readonly limits: RuntimeLimits) {}
  private async text(source: AuthorizedSource, url: string, signal: AbortSignal): Promise<string> { return boundedText(await this.fetcher.request(source, authorizeUrl(source, url), { signal }), this.limits.manifestBytes); }
  private async document(source: AuthorizedSource, signal: AbortSignal): Promise<{ protocol: 'direct' | 'hls' | 'dash'; text?: string }> {
    const response = await this.fetcher.request(source, source.exactUrl, { signal });
    if (!response.body) fail('HTTP_ERROR');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    // Network chunks are arbitrary: a single byte is not enough to sniff HLS/XML.
    while (size < 4096) { const chunk = await reader.read(); if (chunk.done) break; chunks.push(chunk.value); size += chunk.value.length; }
    if (!size) { await reader.cancel(); fail('UNSUPPORTED_FORMAT'); }
    const head = new Uint8Array(Math.min(size, 4096)); let offset = 0;
    for (const chunk of chunks) { const portion = chunk.subarray(0, head.length - offset); head.set(portion, offset); offset += portion.length; if (offset === head.length) break; }
    const prefix = new TextDecoder().decode(head).replace(/^\uFEFF/, '').trimStart();
    if (/^<(?:!doctype\s+html|html|head|body)/i.test(prefix)) { await reader.cancel(); fail('AUTH_REQUIRED'); }
    const protocol = prefix.startsWith('#EXTM3U') ? 'hls' : /<(?:[\w-]+:)?MPD(?:\s|>)/.test(prefix) || /dash\+xml/.test(response.headers.get('content-type') ?? '') ? 'dash' : 'direct';
    if (protocol === 'direct') { await reader.cancel(); return { protocol }; }
    let pending = 0;
    const body = new ReadableStream<Uint8Array>({ async pull(controller) { if (pending < chunks.length) controller.enqueue(chunks[pending++]); else { const c = await reader.read(); if (c.done) controller.close(); else controller.enqueue(c.value); } }, cancel: reason => reader.cancel(reason) });
    return { protocol, text: await boundedText(new Response(body), this.limits.manifestBytes) };
  }
  async inspect(source: AuthorizedSource, signal: AbortSignal): Promise<ResolvedMedia> {
    const doc = await this.document(source, signal);
    if (doc.protocol === 'direct') return { protocol: 'direct', isLive: false, variants: [{ id: 'original', codecs: [], hasAudio: true }], audioTracks: [], subtitleTracks: [], containers: ['original'] };
    if (doc.protocol === 'dash') return this.dashMedia(parseDash(doc.text!, source.exactUrl, source.localModeOrigins.includes(new URL(source.exactUrl).origin)));
    const h = parseHls(doc.text!, source.exactUrl, source.localModeOrigins.includes(new URL(source.exactUrl).origin));
    if (h.kind === 'media') {
      const first = h.segments[0], metadata = await probeResource(this.fetcher, source, [...(first.init ? [first.init] : []), first], signal);
      return { protocol: 'hls', isLive: h.live, variants: [{ id: 'media', codecs: metadata.codecs, hasAudio: metadata.hasAudio, width: metadata.width, height: metadata.height }], audioTracks: [], subtitleTracks: [], containers: containersFor(metadata.codecs), ...(h.live ? {} : { duration: h.segments.reduce((sum, s) => sum + s.duration, 0) }) };
    }
    const variant = h.variants[0], child = parseHls(await this.text(source, variant.url, signal), variant.url, source.localModeOrigins.includes(new URL(variant.url).origin));
    if (child.kind !== 'media') fail('INVALID_MANIFEST');
    return { protocol: 'hls', isLive: child.live, variants: h.variants.map(v => ({ id: v.id, width: v.width, height: v.height, bitrate: v.bitrate, fps: v.fps, codecs: [...v.codecs], hasAudio: !v.audioGroup })), audioTracks: h.tracks.filter(t => t.kind === 'audio').map(t => ({ id: t.id, kind: 'audio', language: t.language, label: t.label, codec: h.variants.find(v => v.audioGroup === t.group)?.codecs.find(c => ['aac', 'opus', 'mp3'].includes(canonicalCodec(c))) })), subtitleTracks: h.tracks.filter(t => t.kind === 'subtitle').map(t => ({ id: t.id, kind: 'subtitle', language: t.language, label: t.label })), containers: [...new Set(h.variants.flatMap(v => containersFor(v.codecs)))] };
  }
  private dashMedia(d: DashManifest): ResolvedMedia {
    const firstPeriod = d.representations[0].periodId, reps = d.representations.filter(r => r.periodId === firstPeriod);
    return { protocol: 'dash', isLive: d.live, duration: d.duration,
      variants: reps.filter(r => r.kind === 'video').map(r => ({ id: r.id, width: r.width, height: r.height, bitrate: r.bitrate, fps: r.fps, codecs: [r.codec], hasAudio: false })),
      audioTracks: reps.filter(r => r.kind === 'audio').map(r => ({ id: r.id, kind: 'audio', language: r.language, label: r.language ?? r.id, codec: r.codec, role: r.role, bitrate: r.bitrate })),
      subtitleTracks: reps.filter(r => r.kind === 'subtitle').map(r => ({ id: r.id, kind: 'subtitle', language: r.language, label: r.language ?? r.id, codec: r.codec })), containers: [...new Set(reps.filter(r => r.kind !== 'subtitle').flatMap(r => containersFor([r.codec, ...(r.kind === 'video' && reps.some(a => a.kind === 'audio') ? [reps.find(a => a.kind === 'audio')!.codec] : [])])))],
    };
  }
  async plan(source: AuthorizedSource, selection: Selection, signal: AbortSignal): Promise<DownloadPlan> {
    const doc = await this.document(source, signal), resources = new Map<string, Resource>();
    const warnings: SafeError[] = [];
    const plan: DownloadPlan = { schemaVersion: 1, id: crypto.randomUUID(), protocol: doc.protocol, isLive: false, selection: structuredClone(selection), container: selection.container, tracks: [], parts: [], sourceRef: source.sourceRef };
    let refreshSeconds = 5;
    const ref = (resource: Resource) => {
      authorizeUrl(source, resource.url);
      const key = crypto.randomUUID(); resources.set(key, resource); return key;
    };
    const segment = (s: Resource & { start: number; duration: number; sequence: number; init?: Resource }, trackId: string, discontinuity: number): PlannedSegment => ({ id: `${trackId}-${discontinuity}-${doc.protocol === 'dash' ? s.start : s.sequence}`, trackId, resourceRef: ref({ url: s.url, ...(s.range ? { range: s.range } : {}) }), ...(s.init ? { initRef: ref(s.init) } : {}), ...(s.range ? { range: s.range } : {}), start: s.start, duration: s.duration, sequence: s.sequence, discontinuity });
    const add = (items: PlannedSegment[], periodId?: string) => {
      for (const s of items) {
        const key = `${periodId ?? 'hls'}-${s.discontinuity}`;
        let part = plan.parts.find(p => p.id === key);
        if (!part) { part = { id: key, periodId, configurationId: key, segments: [] }; plan.parts.push(part); }
        part.segments.push({ ...s, id: `${periodId ?? 'hls'}-${s.id}` });
      }
    };
    let media: ResolvedMedia;
    if (doc.protocol === 'direct') {
      if (selection.container !== 'original' || selection.audioOnly || selection.subtitleTrackIds.length || selection.audioTrackId || (selection.variantId && selection.variantId !== 'original')) fail('UNSUPPORTED_FORMAT');
      plan.tracks = [{ id: 'original', kind: 'video', codec: '' }];
      plan.parts = [{ id: 'direct', configurationId: 'original', segments: [{ id: 'direct', trackId: 'original', resourceRef: ref({ url: source.exactUrl }), start: 0, duration: 0, discontinuity: 0 }] }];
      media = { protocol: 'direct', isLive: false, variants: [], audioTracks: [], subtitleTracks: [], containers: ['original'] };
    } else if (doc.protocol === 'hls') {
      if (selection.container === 'original') fail('UNSUPPORTED_FORMAT');
      const root = parseHls(doc.text!, source.exactUrl, source.localModeOrigins.includes(new URL(source.exactUrl).origin));
      const resolve = async (url: string, depth = 0): Promise<MediaPlaylist> => {
        if (depth >= this.limits.playlistDepth) fail('MANIFEST_LIMIT');
        const h = parseHls(await this.text(source, url, signal), url, source.localModeOrigins.includes(new URL(url).origin));
        if (h.kind === 'media') return h;
        if (h.variants.length !== 1) fail('INVALID_MANIFEST');
        return resolve(h.variants[0].url, depth + 1);
      };
      if (root.kind === 'media') {
        if (selection.variantId && selection.variantId !== 'media' || selection.audioTrackId || selection.subtitleTrackIds.length) fail('INVALID_REQUEST');
        const track: PlannedTrack = { id: 'media', kind: selection.audioOnly ? 'audio' : 'video', codec: '' }; plan.tracks.push(track);
        add(root.segments.map(s => segment(s, track.id, s.discontinuity))); plan.isLive = root.live; refreshSeconds = Math.max(1, root.targetDuration / 2);
      } else {
        const variant = root.variants.find(v => v.id === selection.variantId) ?? (!selection.variantId ? [...root.variants].sort((a, b) => b.bitrate - a.bitrate)[0] : undefined);
        if (!variant) fail('INVALID_REQUEST');
        const codecs = selection.audioOnly ? variant.codecs.filter(c => ['aac', 'opus', 'mp3'].includes(canonicalCodec(c))) : variant.codecs;
        if (codecs.length && !containersFor(codecs).includes(selection.container)) fail('UNSUPPORTED_FORMAT');
        const audio = selection.audioTrackId ? root.tracks.find(t => t.id === selection.audioTrackId && t.kind === 'audio' && t.group === variant.audioGroup) : root.tracks.find(t => t.kind === 'audio' && t.group === variant.audioGroup);
        if (selection.audioTrackId && !audio) fail('INVALID_REQUEST');
        const selected = selection.subtitleTrackIds.map(id => { const t = root.tracks.find(t => t.id === id && t.kind === 'subtitle' && t.group === variant.subtitleGroup); if (!t?.url) fail('INVALID_REQUEST'); return t; });
        const targets = [ ...(!selection.audioOnly || !audio?.url ? [{ id: variant.id, kind: selection.audioOnly ? 'audio' as const : 'video' as const, url: variant.url, codec: variant.codecs.join(',') }] : []), ...(audio?.url ? [{ id: audio.id, kind: 'audio' as const, url: audio.url, codec: '', language: audio.language }] : []), ...selected.map(t => ({ id: t.id, kind: 'subtitle' as const, url: t.url!, codec: 'webvtt', language: t.language })) ];
        for (const t of targets) {
          try {
            const h = await resolve(t.url); plan.tracks.push({ id: t.id, kind: t.kind, codec: t.codec, ...('language' in t && t.language ? { language: t.language } : {}) });
            add(h.segments.map(s => segment(s, t.id, s.discontinuity))); plan.isLive ||= h.live; refreshSeconds = Math.max(1, h.targetDuration / 2);
          } catch (error) { if (signal.aborted || t.kind !== 'subtitle') throw error; warnings.push(safeError(error)); }
        }
      }
      media = { protocol: 'hls', isLive: plan.isLive, variants: [], audioTracks: [], subtitleTracks: [], containers: [] };
    } else {
      const d = parseDash(doc.text!, source.exactUrl, source.localModeOrigins.includes(new URL(source.exactUrl).origin));
      media = this.dashMedia(d); plan.isLive = d.live; refreshSeconds = d.minimumUpdatePeriod;
      const first = d.representations[0].periodId;
      const firstReps = d.representations.filter(r => r.periodId === first);
      const video = selection.audioOnly ? undefined : firstReps.find(r => r.kind === 'video' && r.id === selection.variantId) ?? (!selection.variantId ? firstReps.filter(r => r.kind === 'video').sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0] : undefined);
      const audio = firstReps.find(r => r.kind === 'audio' && r.id === selection.audioTrackId) ?? (!selection.audioTrackId ? firstReps.find(r => r.kind === 'audio') : undefined);
      if (selection.variantId && !selection.audioOnly && !video || selection.audioTrackId && !audio || selection.audioOnly && !audio) fail('INVALID_REQUEST');
      const subtitles = selection.subtitleTrackIds.map(id => { const r = firstReps.find(r => r.id === id && r.kind === 'subtitle'); if (!r) fail('INVALID_REQUEST'); return r; });
      const chosen = [video, audio, ...subtitles].filter((r): r is DashRepresentation => !!r);
      if (!chosen.length) fail('INVALID_REQUEST');
      const codecs = chosen.filter(r => r.kind !== 'subtitle').map(r => r.codec);
      if (codecs.every(Boolean) && !containersFor(codecs).includes(selection.container)) fail('UNSUPPORTED_FORMAT');
      plan.tracks = chosen.map(r => ({ id: r.id, kind: r.kind, codec: r.codec, language: r.language, role: r.role }));
      for (const period of [...new Set(d.representations.map(r => r.periodId))]) for (const wanted of chosen) {
        const r = d.representations.find(r => r.periodId === period && r.id === wanted.id && r.kind === wanted.kind) ?? d.representations.find(r => r.periodId === period && r.kind === wanted.kind && r.language === wanted.language && r.height === wanted.height && r.codec === wanted.codec);
        if (!r) fail('INVALID_MANIFEST');
        if (r.segmentBase) {
          const base = r.segmentBase;
          const response = await this.fetcher.request(source, authorizeUrl(source, base.url), { signal, range: base.indexRange });
          if (base.indexRange.length > this.limits.manifestBytes) { await response.body?.cancel(); fail('MANIFEST_LIMIT'); }
          const data = new Uint8Array(await response.arrayBuffer());
          r.segments = parseSidx(data, base.indexRange.offset).map(s => ({ ...s, url: base.url, start: r.periodStart + s.start - base.presentationTimeOffset / base.timescale, init: base.init }));
        }
        add(r.segments.map(s => segment(s, wanted.id, 0)), period);
      }
    }
    const count = plan.parts.reduce((sum, p) => sum + p.segments.length, 0); if (count > this.limits.segments) fail('MANIFEST_LIMIT');
    this.plans.set(plan.id, { resources, media, refreshSeconds, warnings });
    return freeze(plan);
  }
  resource(planId: string, resourceRef: string): Resource { const r = this.plans.get(planId)?.resources.get(resourceRef); if (!r) fail('URL_EXPIRED'); return r; }
  release(planId: string): void { this.plans.delete(planId); }
}
