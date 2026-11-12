import { OpfsFiles } from '../engine/files';
import { object, exactKeys } from '../shared/validation';
import { EngineError, fail, safeError } from '../shared/errors';
const worker = new Worker(chrome.runtime.getURL('offscreen/worker.js'), { type: 'module' });
let workerReady: () => void;
let workerFailed: (error: Error) => void;
const ready = new Promise<void>((resolve, reject) => { workerReady = resolve; workerFailed = reject; });
const startupTimeout = setTimeout(() => workerFailed(new EngineError('BROWSER_UNSUPPORTED')), 15000);
void ready.then(() => clearTimeout(startupTimeout), () => clearTimeout(startupTimeout));
const pending = new Map<string, (value: unknown) => void>(), urls = new Map<string, string>();
worker.onmessage = ({ data }) => {
  if (data.ready) workerReady();
  else if (data.event) { void chrome.runtime.sendMessage({ version: 1, requestId: crypto.randomUUID(), target: 'coordinator', type: 'ENGINE_EVENT', payload: data.event }).catch(() => {}); }
  else { pending.get(data.requestId)?.(data); pending.delete(data.requestId); }
};
worker.onerror = () => { workerFailed(new EngineError('BROWSER_UNSUPPORTED')); for (const [requestId, resolve] of pending) resolve({ requestId, ok: false, error: safeError(new EngineError('BROWSER_UNSUPPORTED')) }); pending.clear(); };
chrome.runtime.onMessage.addListener((value, sender, reply) => {
  if (value?.target !== 'engine-host') return false;
  if (sender.id !== chrome.runtime.id || sender.tab || sender.url && sender.url !== chrome.runtime.getURL('background/service-worker.js')) return false;
  void (async () => {
    try {
      const v = object(value); exactKeys(v, ['version', 'requestId', 'target', 'type', 'payload']);
      if (v.version !== 1 || typeof v.requestId !== 'string' || typeof v.type !== 'string') fail('INVALID_REQUEST');
      const p = object(v.payload);
      if (v.type === 'HOST_OUTPUT') {
        const files = await OpfsFiles.open(), jobId = String(p.jobId), attempt = Number(p.attempt), part = Number(p.part);
        const key = `${jobId}:${attempt}:${part}`;
        const filePath = String(p.path);
        if (!filePath.startsWith(`jobs/${jobId}/attempt-${attempt}/`) || !Number.isSafeInteger(part)) fail('INVALID_REQUEST');
        if (!urls.has(key)) urls.set(key, URL.createObjectURL(await files.read(filePath)));
        return { requestId: v.requestId, ok: true, data: { objectUrl: urls.get(key) } };
      }
      if (v.type === 'HOST_REVOKE') { const key = `${p.jobId}:${p.attempt}:${p.part}`, url = urls.get(key); if (url) URL.revokeObjectURL(url); urls.delete(key); return { ok: true, data: {} }; }
      if (!/^ENGINE_(INSPECT|PLAN|START|PAUSE|RESUME|STOP_LIVE|CANCEL|SNAPSHOT|RECONCILE|CLEAN|ORPHANS|USAGE)$/.test(v.type)) fail('INVALID_REQUEST');
      await ready;
      return await new Promise(resolve => { pending.set(v.requestId as string, resolve); worker.postMessage(v); });
    } catch (error) { return { ok: false, error: safeError(error) }; }
  })().then(reply);
  return true;
});
