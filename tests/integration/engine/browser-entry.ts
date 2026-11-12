import { createEngine, IndexedDbEngineStore, OpfsFiles, createAuthorizedFetcher } from '../../../src/engine/index';
import { DEFAULT_LIMITS, DEFAULT_SETTINGS, type Selection, type JobSnapshot, type EngineEvent, type AuthorizedFetcher } from '../../../src/shared/contracts';
const files = await OpfsFiles.open();
const store = await IndexedDbEngineStore.open(files, `engine-component-${crypto.randomUUID()}`);
const events: EngineEvent[] = [];
const engine = createEngine({ store, fetcher: createAuthorizedFetcher(), limits: DEFAULT_LIMITS, onEvent: async e => { events.push(e); } });
const downloads = new Map<string, { url: string; name: string }>();
const api = {
  async run(url: string, selection: Selection, options: { stopAfterMs?: number; timeoutMs?: number; liveMaxDurationSeconds?: number } = {}) {
    const source = { sourceRef: crypto.randomUUID(), exactUrl: url, allowedOrigins: [new URL(url).origin], localModeOrigins: [new URL(url).origin] }, signal = new AbortController().signal;
    const plan = await engine.plan(source, selection, signal), id = crypto.randomUUID();
    const job: JobSnapshot = { schemaVersion: 1, id, requestId: crypto.randomUUID(), candidateId: 'test', state: 'queued', selection, outputName: 'result', createdAt: Date.now(), updatedAt: Date.now(), bytesWritten: 0, attempt: 1, revision: 0, runEpoch: 1, capabilities: { pause: false, resume: false }, warnings: [], outputs: [] };
    await store.createJob(job, 'a'.repeat(64));
    await engine.start({ jobId: id, attempt: 1, runEpoch: 1, plan, source, settingsSnapshot: { ...DEFAULT_SETTINGS, ...(options.liveMaxDurationSeconds !== undefined ? { liveMaxDurationSeconds: options.liveMaxDurationSeconds } : {}) } });
    const startedAt = Date.now(), deadline = startedAt + (options.timeoutMs ?? 45000);
    while (Date.now() < deadline) {
      const current = (await store.readJob(id))!;
      if (current.state === 'failed') throw new Error(JSON.stringify(current.error));
      if (options.stopAfterMs !== undefined && current.state === 'downloading' && Date.now() - startedAt >= options.stopAfterMs) await engine.stopLiveAndSave(id, 1);
      if (current.state === 'awaiting_export' && !(await engine.snapshot()).runs.some(r => r.jobId === id)) {
        const outputs = events.filter(e => e.jobId === id && e.type === 'EXPORT_READY').map(e => e.payload as { opfsRelativePath: string; outputRef: { name: string }; mime: string });
        const tokens = [];
        for (const output of outputs) { const file = await files.read(output.opfsRelativePath), token = crypto.randomUUID(); downloads.set(token, { url: URL.createObjectURL(file), name: output.outputRef.name }); tokens.push({ token, name: output.outputRef.name }); }
        return { job: current, outputs: tokens, plan, events: events.filter(e => e.jobId === id) };
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Component timeout');
  },
  download(token: string) { const item = downloads.get(token)!; document.getElementById('component-download')?.remove(); const a = document.createElement('a'); a.id = 'component-download'; a.textContent = 'Save component output'; a.href = item.url; a.download = item.name; document.body.append(a); },
  release(token: string) { const item = downloads.get(token)!; URL.revokeObjectURL(item.url); downloads.delete(token); },
  async cleanup(jobId: string) { await store.deleteTemporary(jobId, 1); },
  async lifecycleChecks(url: string) {
    const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
    const wait = async (predicate: () => Promise<boolean>) => {
      const deadline = Date.now() + 15000;
      while (!await predicate()) { if (Date.now() > deadline) throw new Error('Lifecycle timeout'); await new Promise(resolve => setTimeout(resolve, 10)); }
    };
    const transport = createAuthorizedFetcher(); let block = true, blocked = false, exportCount = 0;
    const fetcher: AuthorizedFetcher = { async request(source, value, options) {
      if (block && value.endsWith('ts-1.ts')) {
        blocked = true;
        await new Promise<void>((_, reject) => { if (options.signal.aborted) reject(options.signal.reason); else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); });
      }
      return transport.request(source, value, options);
    } };
    const localEngine = createEngine({ store, fetcher, limits: DEFAULT_LIMITS, onEvent: async event => {
      if (event.type === 'EXPORT_READY') {
        const job = (await store.readJob(event.jobId))!;
        assert(job.state === 'awaiting_export' || job.state === 'exporting', 'Export published before durable ready');
        assert(job.outputs.length > 0, 'Export output absent from job');
        assert(await store.compareAndSwapJob(job.id, job.revision, { ...job, state: 'exporting', revision: job.revision + 1 }), 'Export CAS failed');
        exportCount++;
      }
    } });
    const source = { sourceRef: crypto.randomUUID(), exactUrl: url, allowedOrigins: [new URL(url).origin], localModeOrigins: [new URL(url).origin] };
    const selection: Selection = { audioOnly: false, subtitleTrackIds: [], container: 'mp4' };
    const create = async () => {
      const plan = await localEngine.plan(source, selection, new AbortController().signal), id = crypto.randomUUID();
      const job: JobSnapshot = { schemaVersion: 1, id, requestId: crypto.randomUUID(), candidateId: 'lifecycle', state: 'queued', selection, outputName: 'lifecycle.mp4', createdAt: Date.now(), updatedAt: Date.now(), bytesWritten: 0, attempt: 1, revision: 0, runEpoch: 1, capabilities: { pause: false, resume: false }, warnings: [], outputs: [] };
      await store.createJob(job, 'c'.repeat(64));
      return { jobId: id, attempt: 1, runEpoch: 1, plan, source, settingsSnapshot: { ...DEFAULT_SETTINGS, segmentsConcurrency: 1 } };
    };
    const run = await create();
    await Promise.all([localEngine.start(run), localEngine.start(run)]);
    await wait(async () => blocked && (await store.readJob(run.jobId))!.segmentsDone === 1);
    const ref = await localEngine.pause(run.jobId, 1), paused = (await store.readJob(run.jobId))!;
    assert(paused.state === 'paused', 'Pause not committed');
    const checkpoint = (await store.readCheckpoint(ref))!;
    assert(checkpoint.completedSegments.length === 1, 'Partial segment checkpointed');
    block = false;
    await localEngine.resume(run, ref);
    await wait(async () => !(await localEngine.snapshot()).runs.some(r => r.jobId === run.jobId));
    assert((await store.readJob(run.jobId))!.state === 'exporting', 'Late engine update overwrote exporter');
    assert(exportCount === 1, 'Duplicate export');
    await store.deleteTemporary(run.jobId, 1);
    block = true; blocked = false;
    const cancelled = await create(); await localEngine.start(cancelled);
    await wait(async () => blocked);
    let staleRejected = false; try { await localEngine.cancel(cancelled.jobId, 0); } catch { staleRejected = true; }
    assert(staleRejected, 'Stale epoch accepted');
    await localEngine.cancel(cancelled.jobId, 1);
    assert((await store.readJob(cancelled.jobId))!.state === 'cancelled', 'Cancel not committed');
    assert(!await store.readCheckpoint(`${cancelled.jobId}:1`), 'Cancel checkpoint leaked');
    assert(!(await localEngine.snapshot()).runs.length, 'Cancel run leaked');
    for (const saved of checkpoint.completedSegments) assert(!await files.verify(saved.path, saved.length), 'Temporary data leaked');
    return { concurrentStart: true, pauseResume: true, durableCheckpoint: true, exportOrdering: true, cancel: true, staleEpoch: true };
  },
  async storeChecks() {
    const id = crypto.randomUUID(), job: JobSnapshot = { schemaVersion: 1, id, requestId: crypto.randomUUID(), candidateId: 'test', state: 'queued', selection: { audioOnly: false, subtitleTrackIds: [], container: 'mp4' }, outputName: 'test', createdAt: Date.now(), updatedAt: Date.now(), bytesWritten: 0, attempt: 1, revision: 0, runEpoch: 1, capabilities: { pause: true, resume: true }, warnings: [], outputs: [] };
    const fingerprint = 'b'.repeat(64); await store.createJob(job, fingerprint);
    const same = await store.createJob({ ...job, id: crypto.randomUUID() }, fingerprint);
    if (same.id !== id) throw new Error('CREATE dedupe failed');
    let mismatch = false;
    try { await store.createJob(job, 'd'.repeat(64)); } catch { mismatch = true; }
    if (!mismatch) throw new Error('Changed requestId payload accepted');
    const next = { ...job, revision: 1, state: 'downloading' as const };
    const results = await Promise.all([store.compareAndSwapJob(id, 0, next), store.compareAndSwapJob(id, 0, next)]);
    if (results.filter(Boolean).length !== 1) throw new Error('CAS race');
    if (await store.acquireLease({ jobId: id, attempt: 1, runEpoch: 0, hostId: 'other' })) throw new Error('Stale lease accepted');
    const recover = { ...job, id: crypto.randomUUID(), requestId: crypto.randomUUID() };
    await store.createJob(recover, 'e'.repeat(64));
    const lease = { jobId: recover.id, attempt: 1, runEpoch: 1, hostId: 'old-host' };
    if (!await store.acquireLease(lease)) throw new Error('Recovery lease absent');
    await store.compareAndSwapJob(recover.id, 0, { ...recover, state: 'downloading', revision: 1 });
    if ((await store.reconcileHost({ hostId: 'old-host', runs: [{ jobId: recover.id, attempt: 1, runEpoch: 1, revision: 1, state: 'downloading' }] })).length) throw new Error('Live lease interrupted');
    const interrupted = await store.reconcileHost({ hostId: 'new-host', runs: [] });
    if (!interrupted.includes(recover.id) || (await store.readJob(recover.id))!.state !== 'interrupted') throw new Error('Lost host not interrupted');
    const current = (await store.readJob(recover.id))!;
    if (!await store.compareAndSwapJob(recover.id, current.revision, { ...current, state: 'queued', attempt: 2, runEpoch: 2, revision: current.revision + 1 })) throw new Error('Recovery retry CAS');
    if (!await store.acquireLease({ ...lease, attempt: 2, runEpoch: 2, hostId: 'new-host' })) throw new Error('Stale lease blocked retry');
    await store.releaseLease({ ...lease, attempt: 2, runEpoch: 2, hostId: 'new-host' });
    const orphanId = crypto.randomUUID(), pausedId = crypto.randomUUID();
    await files.write(`jobs/${orphanId}/attempt-1/segments/uncheckpointed`, new Blob(['crash tail']).stream(), new AbortController().signal);
    const paused = { ...job, id: pausedId, requestId: crypto.randomUUID() };
    await store.createJob(paused, 'f'.repeat(64));
    await files.write(`jobs/${pausedId}/attempt-1/segments/retained`, new Blob(['paused']).stream(), new AbortController().signal);
    await store.compareAndSwapJob(pausedId, 0, { ...paused, state: 'paused', revision: 1 });
    const orphans = await store.listOrphans();
    if (!orphans.some(o => o.jobId === orphanId && o.updatedAt > 0)) throw new Error('Uncheckpointed disk orphan invisible');
    if (orphans.some(o => o.jobId === pausedId)) throw new Error('Paused data marked orphan');
    await store.deleteTemporary(orphanId, 1); await store.deleteTemporary(pausedId, 1);
    return { dedupe: true, payloadMismatch: true, casWinners: results.filter(Boolean).length, staleEpochRejected: true, liveLeasePreserved: true, lostHostInterrupted: true, retryLeaseAcquired: true, diskOrphansFound: true, pausedFilesPreserved: true };
  },
};
declare global { interface Window { engineComponent: typeof api } }
window.engineComponent = api;
