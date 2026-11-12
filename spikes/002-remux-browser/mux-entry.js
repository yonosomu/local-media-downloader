import { Input, BlobSource, ALL_FORMATS, Output, Mp4OutputFormat, StreamTarget, EncodedVideoPacketSource, EncodedAudioPacketSource, EncodedPacketSink } from 'mediabunny';

window.runMux = async () => {
  const inputs = await Promise.all(['video.mp4', 'audio.m4a'].map(async name => new Input({ source: new BlobSource(await (await fetch(name)).blob()), formats: ALL_FORMATS })));
  const video = await inputs[0].getPrimaryVideoTrack();
  const audio = await inputs[1].getPrimaryAudioTrack();
  if (!video || !audio) throw new Error('Missing tracks');
  const videoSource = new EncodedVideoPacketSource(await video.getCodec());
  const audioSource = new EncodedAudioPacketSource(await audio.getCodec());
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle('mux.mp4', { create: true });
  const stream = await handle.createWritable();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented' }), target: new StreamTarget(stream) });
  output.addVideoTrack(videoSource);
  output.addAudioTrack(audioSource, { languageCode: 'rus' });
  await output.start();
  await Promise.all([[video, videoSource], [audio, audioSource]].map(async ([track, source]) => {
    const decoderConfig = await track.getDecoderConfig();
    for await (const packet of new EncodedPacketSink(track).packets()) await source.add(packet, { decoderConfig });
    source.close();
  }));
  await output.finalize();
  for (const input of inputs) input.dispose();
  const url = URL.createObjectURL(await handle.getFile());
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'mux.mp4'; anchor.click();
};

window.runLargeMux = async minBytes => {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle('large-mux.mp4', { create: true });
  const target = new StreamTarget(await handle.createWritable());
  let bytes = 0;
  target.on('write', ({ end }) => { bytes = Math.max(bytes, end); });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented' }), target });
  let videoSource, audioSource;
  // Each cycle reads a separate synthetic segment. Inputs and packet data are
  // discarded at each boundary; output remains disk-backed throughout.
  for (let cycle = 0; bytes < minBytes || cycle === 0; cycle++) {
    const inputs = await Promise.all(['large-video.mp4', 'audio.m4a'].map(async name => new Input({ source: new BlobSource(await (await fetch(`${name}?segment=${cycle}`)).blob()), formats: ALL_FORMATS })));
    try {
      const video = await inputs[0].getPrimaryVideoTrack();
      const audio = await inputs[1].getPrimaryAudioTrack();
      if (!video || !audio) throw new Error('Missing tracks');
      if (!cycle) {
        videoSource = new EncodedVideoPacketSource(await video.getCodec());
        audioSource = new EncodedAudioPacketSource(await audio.getCodec());
        output.addVideoTrack(videoSource);
        output.addAudioTrack(audioSource, { languageCode: 'rus' });
        await output.start();
      }
      await Promise.all([[video, videoSource], [audio, audioSource]].map(async ([track, source]) => {
        const decoderConfig = await track.getDecoderConfig();
        for await (const packet of new EncodedPacketSink(track).packets()) {
          if (packet.timestamp < 0 || packet.timestamp >= 4) continue;
          await source.add(packet.clone({ timestamp: packet.timestamp + cycle * 4, duration: Math.min(packet.duration, 4 - packet.timestamp) }), { decoderConfig });
        }
      }));
      window.gateState = { cycle, bytes };
    } finally { for (const input of inputs) input.dispose(); }
  }
  videoSource.close(); audioSource.close();
  await output.finalize();
  const url = URL.createObjectURL(await handle.getFile());
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'large-mux.mp4'; anchor.click();
};
