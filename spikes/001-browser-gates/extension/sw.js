chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === 'GATE_PING') reply({ ok: true });
  if (message.type === 'GATE_AUTH') {
    (async () => {
      const url = new URL(message.url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Fixture URLs only');
      if (!(await chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] }))) return { code: 'PERMISSION_REQUIRED' };
      const response = await fetch(url, { credentials: 'include' });
      return { status: response.status, text: await response.text() };
    })().then(reply, e => reply({ error: String(e) }));
    return true;
  }
  if (message.type === 'GATE_START') {
    (async () => {
      if (!(await chrome.offscreen.hasDocument())) {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html', reasons: ['BLOBS'],
          justification: 'Create and retain disk-backed OPFS object URLs for Downloads export',
        });
      }
      return chrome.runtime.sendMessage({ ...message, type: 'ENGINE_START' });
    })().then(reply, e => reply({ ok: false, error: String(e) }));
    return true;
  }
  if (message.type === 'ENGINE_EXPORT') {
    chrome.downloads.download({ url: message.url, filename: 'lmd-gate.bin', saveAs: false })
      .then(id => reply({ ok: true, id }), e => reply({ ok: false, error: String(e) }));
    return true;
  }
});
