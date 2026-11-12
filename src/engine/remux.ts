import { Input, BlobSource, ALL_FORMATS, Output, Mp4OutputFormat, WebMOutputFormat, MkvOutputFormat, Mp3OutputFormat, StreamTarget, EncodedAudioPacketSource, EncodedVideoPacketSource, EncodedPacketSink, type InputTrack, type InputVideoTrack, type InputAudioTrack, type EncodedPacket, type OutputFormat } from 'mediabunny';
import type { Container } from '../shared/contracts';
import { canonicalCodec, containersFor } from '../shared/capabilities';
import { fail } from '../shared/errors';
import { muxLanguage } from '../core/language';
export interface MuxSegment { file: Blob; start: number; duration: number }
export interface MuxLane { kind: 'video' | 'audio'; segments: MuxSegment[]; language?: string }
function format(container: Container): OutputFormat {
  if (container === 'mp4' || container === 'm4a') return new Mp4OutputFormat({ fastStart: 'fragmented' });
  if (container === 'webm') return new WebMOutputFormat();
  if (container === 'mkv') return new MkvOutputFormat();
  if (container === 'mp3') return new Mp3OutputFormat();
  return fail('UNSUPPORTED_FORMAT');
}
interface Packet { packet: EncodedPacket; decoderConfig: VideoDecoderConfig | AudioDecoderConfig; codec: string; configuration: string }
function configuration(config: VideoDecoderConfig | AudioDecoderConfig): string {
  const description = config.description;
  const data = description ? ArrayBuffer.isView(description) ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength) : new Uint8Array(description) : undefined;
  return JSON.stringify({ ...config, description: data ? Array.from(data) : undefined });
}
async function* packets(lane: MuxLane, signal: AbortSignal, commonOrigin: number): AsyncGenerator<Packet> {
  const timelineOrigin = commonOrigin;
  let trackOffset: number | undefined;
  for (const segment of lane.segments) {
    signal.throwIfAborted();
    const input = new Input({ source: new BlobSource(segment.file), formats: ALL_FORMATS });
    try {
      const track = lane.kind === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
      if (!track) fail('UNSUPPORTED_FORMAT');
      const codec = await track.getCodec(), decoderConfig = await track.getDecoderConfig();
      if (!codec || !decoderConfig) fail('UNSUPPORTED_FORMAT');
      // Preserve A/V offset within a multiplexed input, normalize each timeline segment.
      const first = await input.getFirstTimestamp();
      trackOffset ??= first - timelineOrigin - segment.start;
      // Continuous TS/fMP4 already carries a common clock. Re-basing each
      // segment independently can overlap the boundary audio packet. Only
      // standalone/reset-clock segments need a new local origin.
      const continuous = Math.abs(first - timelineOrigin - segment.start - trackOffset) < 0.25;
      const origin = continuous ? timelineOrigin : first - segment.start - trackOffset;
      for await (const packet of new EncodedPacketSink(track as InputTrack).packets()) {
        signal.throwIfAborted();
        const local = packet.timestamp - first;
        if (local < -0.1 || segment.duration > 0 && local >= segment.duration - 0.000001) continue;
        const timestamp = packet.timestamp - origin;
        if (timestamp < -0.001) continue;
        const remaining = segment.start + trackOffset + segment.duration - timestamp;
        if (segment.duration > 0 && remaining <= 0.000001) continue;
        yield { packet: packet.clone({ timestamp: Math.max(0, timestamp), duration: segment.duration > 0 ? Math.min(packet.duration, remaining) : packet.duration }), decoderConfig, codec, configuration: configuration(decoderConfig) };
      }
    } finally { input.dispose(); }
  }
}
/** Encoded packets only, at most one pending packet per selected lane. Output is disk-backed. */
export async function remux(lanes: MuxLane[], container: Container, handle: FileSystemFileHandle, signal: AbortSignal): Promise<number> {
  // One origin for the selected source clocks preserves split-track A/V offsets.
  // Independent per-track zeroing would silently remove a legitimate audio delay.
  const origins = await Promise.all(lanes.map(async lane => {
    if (!lane.segments.length) fail('MUX_FAILED');
    const input = new Input({ source: new BlobSource(lane.segments[0].file), formats: ALL_FORMATS });
    try { return await input.getFirstTimestamp() - lane.segments[0].start; }
    finally { input.dispose(); }
  }));
  const commonOrigin = Math.min(...origins);
  const iterators = lanes.map(lane => packets(lane, signal, commonOrigin));
  const heads = await Promise.all(iterators.map(i => i.next()));
  const present = heads.filter((h): h is IteratorYieldResult<Packet> => !h.done);
  if (present.length !== lanes.length || !containersFor(present.map(h => h.value.codec)).includes(container)) { for (const i of iterators) await i.return(undefined); fail('UNSUPPORTED_FORMAT'); }
  const writable = await handle.createWritable();
  const output = new Output({ format: format(container), target: new StreamTarget(writable) });
  const sources: (EncodedAudioPacketSource | EncodedVideoPacketSource)[] = [];
  const configs = present.map(h => h.value.configuration);
  try {
    for (let i = 0; i < lanes.length; i++) {
      const codec = canonicalCodec(present[i].value.codec);
      if (lanes[i].kind === 'video') {
        const source = new EncodedVideoPacketSource(codec as Awaited<ReturnType<InputVideoTrack['getCodec']>> & string); sources.push(source); output.addVideoTrack(source);
      } else {
        const source = new EncodedAudioPacketSource(codec as Awaited<ReturnType<InputAudioTrack['getCodec']>> & string); sources.push(source); output.addAudioTrack(source, { languageCode: muxLanguage(lanes[i].language) });
      }
    }
    await output.start();
    while (heads.some(h => !h.done)) {
      signal.throwIfAborted();
      let index = -1;
      for (let i = 0; i < heads.length; i++) if (!heads[i].done && (index === -1 || heads[i].value!.packet.timestamp < heads[index].value!.packet.timestamp)) index = i;
      const value = heads[index].value!;
      // Never silently mux a changed decoder config into the previous track.
      if (value.configuration !== configs[index]) fail('RESOURCE_CHANGED');
      const source = sources[index];
      if (source instanceof EncodedVideoPacketSource) await source.add(value.packet, { decoderConfig: value.decoderConfig as VideoDecoderConfig });
      else await source.add(value.packet, { decoderConfig: value.decoderConfig as AudioDecoderConfig });
      heads[index] = await iterators[index].next();
    }
    for (const source of sources) source.close();
    await output.finalize();
    return (await handle.getFile()).size;
  } catch (error) { await output.cancel().catch(() => {}); await writable.abort().catch(() => {}); throw error; }
  finally { for (const i of iterators) await i.return(undefined); }
}
export async function probeTracks(file: Blob): Promise<{ video: boolean; audio: boolean; codecs: string[] }> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try { const video = await input.getPrimaryVideoTrack(), audio = await input.getPrimaryAudioTrack(); return { video: !!video, audio: !!audio, codecs: (await Promise.all([video?.getCodec(), audio?.getCodec()])).filter((c): c is NonNullable<typeof c> => !!c) }; }
  finally { input.dispose(); }
}
export async function probeConfigurations(file: Blob): Promise<Partial<Record<'video' | 'audio', string>>> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const result: Partial<Record<'video' | 'audio', string>> = {};
    const video = await input.getPrimaryVideoTrack(), audio = await input.getPrimaryAudioTrack();
    if (video) { const config = await video.getDecoderConfig(); if (config) result.video = configuration(config); }
    if (audio) { const config = await audio.getDecoderConfig(); if (config) result.audio = configuration(config); }
    return result;
  } finally { input.dispose(); }
}
