import type { ResolvedMedia, Selection, SettingsV1, Track, Variant } from '../shared/contracts';
import { canonicalCodec, containersFor } from '../shared/capabilities';
import { fail } from '../shared/errors';
function languageTrack(tracks: Track[], languages: string[]): Track | undefined {
  for (const language of languages) { const match = tracks.find(t => t.language?.toLowerCase() === language.toLowerCase()); if (match) return match; }
  return tracks[0];
}
export function chooseVariant(variants: Variant[], quality: SettingsV1['quality'], manualId?: string): Variant | undefined {
  if (quality.mode === 'manual') { const v = variants.find(v => v.id === manualId); if (!v) fail('INVALID_REQUEST'); return v; }
  const sorted = [...variants].sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || (b.bitrate ?? 0) - (a.bitrate ?? 0));
  if (quality.mode === 'max_height') return sorted.find(v => v.height !== undefined && v.height <= quality.maxHeight!) ?? sorted.at(-1);
  return sorted[0];
}
export function selectPreferred(media: ResolvedMedia, settings: SettingsV1, audioOnly = false, manualId?: string): { selection: Selection; languageFallback: boolean; actualAudioLanguage?: string } {
  const variant = media.variants.length ? chooseVariant(media.variants, settings.quality, manualId) : undefined, audio = languageTrack(media.audioTracks, settings.audioLanguages);
  const subtitles = settings.subtitlesEnabled ? settings.subtitleLanguages.flatMap(language => media.subtitleTracks.filter(t => t.language?.toLowerCase() === language.toLowerCase()).map(t => t.id)) : [];
  const codecs = [...(!audioOnly ? variant?.codecs ?? [] : !audio ? (variant?.codecs ?? []).filter(c => ['aac', 'opus', 'mp3'].includes(canonicalCodec(c))) : []), ...(audio?.codec ? [audio.codec] : [])];
  const allowed = codecs.length ? containersFor(codecs, media.protocol === 'direct') : media.containers;
  const container = allowed.includes(settings.container) ? settings.container : allowed[0];
  if (!container) fail('UNSUPPORTED_FORMAT');
  return { selection: { variantId: variant?.id, audioTrackId: audio?.id, subtitleTrackIds: [...new Set(subtitles)], audioOnly, container }, languageFallback: !!audio && !settings.audioLanguages.some(l => l.toLowerCase() === audio.language?.toLowerCase()), ...(audio?.language ? { actualAudioLanguage: audio.language } : {}) };
}
