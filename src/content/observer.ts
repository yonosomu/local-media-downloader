(() => {
  const scope = globalThis as typeof globalThis & { lmdObserverInstalled?: boolean };
  if (scope.lmdObserverInstalled) { void chrome.runtime.sendMessage({ type: 'CONTENT_HELLO' }); return; }
  scope.lmdObserverInstalled = true;
  let binding: { generation: number; documentKey: string } | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const sent = new Set<string>();
  async function hello(): Promise<void> { const reply = await chrome.runtime.sendMessage({ type: 'CONTENT_HELLO' }).catch(() => undefined); if (reply?.ok) { binding = reply.data.binding; sent.clear(); scan(); } }
  function scan(): void {
    if (!binding) return;
    for (const element of [...document.querySelectorAll<HTMLMediaElement | HTMLSourceElement>('video,audio,source')].slice(0, 100)) {
      const url = element instanceof HTMLMediaElement ? element.currentSrc || element.src : element.src;
      if (!url || !/^https?:/.test(url) || sent.has(url)) continue;
      sent.add(url); if (sent.size > 200) sent.delete(sent.values().next().value!);
      const payload = { ...binding, kind: element.tagName.toLowerCase(), url, title: document.title.slice(0, 512), mime: element instanceof HTMLSourceElement ? element.type.slice(0, 128) : '' };
      void chrome.runtime.sendMessage({ version: 1, requestId: crypto.randomUUID(), type: 'DISCOVERY_HINT', payload }).then(reply => { if (!reply?.ok) sent.delete(url); }).catch(() => {});
    }
  }
  function schedule(): void { if (!timer) timer = setTimeout(() => { timer = undefined; scan(); }, 300); }
  new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'type'] });
  document.addEventListener('loadedmetadata', schedule, true); document.addEventListener('play', schedule, true);
  chrome.runtime.onMessage.addListener(message => { if (message?.type === 'LMD_REBIND') void hello(); });
  void hello();
})();
