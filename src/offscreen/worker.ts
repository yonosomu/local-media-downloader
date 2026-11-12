import { createEngine, createAuthorizedFetcher, IndexedDbEngineStore, OpfsFiles } from '../engine/index';
import { DEFAULT_LIMITS } from '../shared/contracts';
import type { AuthorizedSource, EngineRun, Selection } from '../shared/contracts';
import { fail, safeError } from '../shared/errors';
import { directFormat } from '../core/direct';
const files = await OpfsFiles.open(), store = await IndexedDbEngineStore.open(files);
const base = createAuthorizedFetcher({ concurrency: 16 });
const engine = createEngine({ store, limits: DEFAULT_LIMITS, fetcher: { async request(source, url, options) {
  const origin = new URL(url).origin;
  if (url !== source.exactUrl) postMessage({ event: { type: 'RESOURCE_OBSERVED', sourceRef: source.sourceRef, exactUrl: url } });
  if (!source.allowedOrigins.includes(origin)) { postMessage({ event: { type: 'PERMISSION_REQUIRED', sourceRef: source.sourceRef, origin } }); fail('PERMISSION_REQUIRED'); }
  return base.request(source, url, options);
} }, onEvent: async event => { postMessage({ event }); } });
const runs = new Map<string, EngineRun>();
async function temporaryBytes(): Promise<number> {
  const root = await navigator.storage.getDirectory();
  const jobs = await root.getDirectoryHandle('jobs').catch(error => { if (error instanceof DOMException && error.name === 'NotFoundError') return undefined; throw error; });
  const size = async (directory: FileSystemDirectoryHandle): Promise<number> => {
    let bytes = 0;
    for await (const entry of directory.values()) bytes += entry.kind === 'file' ? (await (entry as FileSystemFileHandle).getFile()).size : await size(entry as FileSystemDirectoryHandle);
    return bytes;
  };
  return jobs ? size(jobs) : 0;
}
self.onmessage = async ({ data }) => {
  const { requestId, type, payload: p } = data;
  try {
    let result: unknown;
    if (type === 'ENGINE_INSPECT') {
      const source = p.source as AuthorizedSource, signal = AbortSignal.timeout(90000);
      const media = await engine.inspect(source, signal);
      if (media.protocol !== 'direct') result = media;
      else {
        const response = await base.request(source, source.exactUrl, { signal });
        if (!response.body) fail('HTTP_ERROR');
        const reader = response.body.getReader(), head = new Uint8Array(4096); let at = 0;
        try { while (at < head.length) { const chunk = await reader.read(); if (chunk.done) break; const piece = chunk.value.subarray(0, head.length - at); head.set(piece, at); at += piece.length; } }
        finally { await reader.cancel(); }
        const format = directFormat(head.subarray(0, at), response.headers.get('content-type') ?? '');
        const length = Number(response.headers.get('content-length'));
        result = { ...media, originalSuffix: format.suffix, ...(Number.isSafeInteger(length) && length > 0 ? { size: { bytes: length, estimated: false } } : {}) };
      }
    }
    else if (type === 'ENGINE_PLAN') result = await engine.plan(p.source as AuthorizedSource, p.selection as Selection, AbortSignal.timeout(90000));
    else if (type === 'ENGINE_START') { const run = p.run as EngineRun; runs.set(run.jobId, run); await engine.start(run); result = {}; }
    else if (type === 'ENGINE_PAUSE') result = await engine.pause(p.jobId, p.runEpoch);
    else if (type === 'ENGINE_RESUME') { const run = runs.get(p.jobId); if (!run) fail('URL_EXPIRED'); await engine.resume(run, p.checkpoint); result = {}; }
    else if (type === 'ENGINE_STOP_LIVE') { await engine.stopLiveAndSave(p.jobId, p.runEpoch); result = {}; }
    else if (type === 'ENGINE_CANCEL') { const snapshot = await engine.snapshot(); if (snapshot.runs.some(r => r.jobId === p.jobId && r.runEpoch === p.runEpoch)) await engine.cancel(p.jobId, p.runEpoch); runs.delete(p.jobId); result = {}; }
    else if (type === 'ENGINE_SNAPSHOT') result = await engine.snapshot();
    else if (type === 'ENGINE_RECONCILE') { result = await store.reconcileHost(await engine.snapshot()); }
    else if (type === 'ENGINE_CLEAN') { await store.deleteTemporary(p.jobId, p.attempt); runs.delete(p.jobId); result = {}; }
    else if (type === 'ENGINE_ORPHANS') result = await store.listOrphans();
    else if (type === 'ENGINE_USAGE') { const e = await navigator.storage.estimate(); result = { temporaryBytes: await temporaryBytes(), ...(e.quota !== undefined ? { quotaBytes: e.quota } : {}) }; }
    else fail('INVALID_REQUEST');
    postMessage({ requestId, ok: true, data: result });
  } catch (error) { postMessage({ requestId, ok: false, error: safeError(error) }); }
};
postMessage({ ready: true });
