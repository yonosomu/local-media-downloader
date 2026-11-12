import { Resolver } from '../../../src/engine/resolver';
import { createAuthorizedFetcher } from '../../../src/engine/fetch';
import { DEFAULT_LIMITS, type AuthorizedSource, type Selection } from '../../../src/shared/contracts';
import { safeError } from '../../../src/shared/errors';

export async function runPlanChecks(origins: string[]) {
  const source = (route: string): AuthorizedSource => ({ sourceRef: 'fixture-plan', exactUrl: origins[0] + route, allowedOrigins: origins, localModeOrigins: origins });
  const resolver = new Resolver(createAuthorizedFetcher({ retries: 0 }), DEFAULT_LIMITS);
  const signal = () => AbortSignal.timeout(10000);
  const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
  const selection: Selection = { audioOnly: false, subtitleTrackIds: [], container: 'mp4' };
  const results: { id: string; actual: unknown }[] = [];
  const media = await resolver.inspect(source('/media/master.m3u8'), signal());
  assert(media.variants.map(v => v.height).join(',') === '90,180,270', 'Нет трёх качеств');
  assert(media.audioTracks.map(t => t.language).join(',') === 'ru,en', 'Нет двух языков');
  const plan = await resolver.plan(source('/cdn/master.m3u8'), { ...selection, variantId: media.variants[1].id, audioTrackId: media.audioTracks[1].id, subtitleTrackIds: [media.subtitleTracks[0].id] }, signal());
  assert(plan.tracks.some(t => t.language === 'en'), 'Не выбран en');
  assert(!JSON.stringify(plan).includes('http:'), 'URL попал в durable plan');
  results.push({ id: 'F-PLAN-HLS-3Q-CDN', actual: { heights: media.variants.map(v => v.height), tracks: plan.tracks, segments: plan.parts.flatMap(p => p.segments).length } });
  for (const file of ['fmp4.m3u8', 'range.m3u8', 'discontinuity.m3u8', 'config-change.m3u8', 'dash.mpd', 'template.mpd', 'list.mpd', 'base.mpd', 'periods.mpd', 'subtitles.mpd']) {
    const p = await resolver.plan(source('/media/' + file), selection, signal());
    assert(p.parts.length > 0 && p.parts.every(p => p.segments.length > 0), 'Пустой план ' + file);
    if (file === 'periods.mpd') assert(p.parts.length === 2, 'Потерян Period');
    if (file === 'range.m3u8' || file === 'base.mpd') assert(p.parts.flatMap(p => p.segments).some(s => s.range), 'Нет ranges ' + file);
    results.push({ id: 'F-PLAN-' + file, actual: { parts: p.parts.length, segments: p.parts.flatMap(p => p.segments).length, tracks: p.tracks } });
  }
  for (const [route, expected] of [
    ['/media/encrypted.m3u8', 'ENCRYPTED_UNSUPPORTED'], ['/media/session-key.m3u8', 'ENCRYPTED_UNSUPPORTED'], ['/media/drm.mpd', 'DRM_UNSUPPORTED'], ['/media/xxe.mpd', 'INVALID_MANIFEST'],
    ['/auth-html.mp4', 'AUTH_REQUIRED'], ['/limits/large.m3u8', 'MANIFEST_LIMIT'], ['/limits/segments.m3u8', 'MANIFEST_LIMIT'], ['/limits/depth/0.m3u8', 'MANIFEST_LIMIT'],
  ]) {
    let code;
    try { await resolver.plan(source(route), selection, signal()); } catch (error) { code = safeError(error).code; }
    assert(code === expected, `${route}: ${code}, ожидалось ${expected}`);
    results.push({ id: 'F-REJECT-' + route, actual: code });
  }
  for (const route of ['/live/hls.m3u8', '/live/dash.mpd']) {
    const p = await resolver.plan(source(route), selection, signal());
    assert(p.isLive, 'Не live ' + route);
    results.push({ id: 'F-PLAN-' + route, actual: { live: p.isLive, segments: p.parts.flatMap(p => p.segments).length } });
  }
  return results;
}
