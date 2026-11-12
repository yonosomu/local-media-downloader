let busy = false;
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message.type !== 'ENGINE_START') return;
  if (busy) { reply({ ok: false, error: 'busy' }); return; }
  busy = true;
  run(message).catch(console.error).finally(() => { busy = false; });
  reply({ ok: true });
});
async function run({ size, delay }) {
  const root = await navigator.storage.getDirectory();
  const status = async value => {
    const handle = await root.getFileHandle('status.json', { create: true });
    const stream = await handle.createWritable();
    await stream.write(JSON.stringify(value));
    await stream.close();
  };
  try {
    const handle = await root.getFileHandle('output.bin', { create: true });
    const stream = await handle.createWritable();
    const block = new Uint8Array(1024 * 1024);
    for (let i = 0; i < block.length; i++) block[i] = i % 251;
    await status({ state: 'writing', written: 0 });
    for (let offset = 0; offset < size; offset += block.length) {
      await stream.write(block.subarray(0, Math.min(block.length, size - offset)));
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    }
    await stream.close();
    const url = URL.createObjectURL(await handle.getFile());
    const exported = await chrome.runtime.sendMessage({ type: 'ENGINE_EXPORT', url });
    await status({ state: exported.ok ? 'exporting' : 'failed', size, ...exported });
    // Keep the URL alive until this disposable profile closes. Production must
    // revoke on Downloads completion and clean OPFS; this is only an API gate.
  } catch (e) { await status({ state: 'failed', error: String(e) }); }
}
