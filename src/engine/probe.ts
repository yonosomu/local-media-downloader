import { Input, ALL_FORMATS, CustomSource } from 'mediabunny';
import type { AuthorizedFetcher, AuthorizedSource, ResourceIdentity } from '../shared/contracts';
import type { Resource } from '../core/hls';
import { fail } from '../shared/errors';
import { responseIdentity } from './fetch';
/** Bounded random-access metadata probe. No uncontrolled library network requests. */
export async function probeResource(fetcher: AuthorizedFetcher, source: AuthorizedSource, resources: Resource[], signal: AbortSignal) {
  const pieces: { resource: Resource; length: number; identity: ResourceIdentity; offset: number }[] = [];
  let size = 0, budget = 8 * 1024 * 1024;
  for (const resource of resources) {
    const response = await fetcher.request(source, resource.url, { signal, ...(resource.range ? { range: resource.range } : {}) });
    const identity = responseIdentity(response.headers), length = resource.range?.length ?? identity.length;
    await response.body?.cancel();
    if (!length || !Number.isSafeInteger(size + length)) fail('UNSUPPORTED_FORMAT');
    pieces.push({ resource, length, identity, offset: size }); size += length;
  }
  const input = new Input({ formats: ALL_FORMATS, source: new CustomSource({
    getSize: () => size, maxCacheSize: 2 * 1024 * 1024, prefetchProfile: 'none',
    async read(start, end) {
      budget -= end - start; if (budget < 0) fail('MANIFEST_LIMIT');
      const chunks: Uint8Array[] = [];
      for (const piece of pieces) {
        const from = Math.max(start, piece.offset), to = Math.min(end, piece.offset + piece.length); if (to <= from) continue;
        const response = await fetcher.request(source, piece.resource.url, { signal, identity: piece.identity, range: { offset: (piece.resource.range?.offset ?? 0) + from - piece.offset, length: to - from } });
        chunks.push(new Uint8Array(await response.arrayBuffer()));
      }
      const result = new Uint8Array(end - start); let at = 0; for (const c of chunks) { result.set(c, at); at += c.length; } return result;
    },
  }) });
  try {
    const video = await input.getPrimaryVideoTrack(), audio = await input.getPrimaryAudioTrack();
    return { codecs: (await Promise.all([video?.getCodec(), audio?.getCodec()])).filter((c): c is NonNullable<typeof c> => !!c), hasVideo: !!video, hasAudio: !!audio,
      ...(video ? { width: await video.getDisplayWidth(), height: await video.getDisplayHeight() } : {}), ...(audio ? { channels: await audio.getNumberOfChannels(), audioCodec: await audio.getCodec() } : {}) };
  } finally { input.dispose(); }
}
