import type { Engine, EngineDeps, EngineRun, CheckpointV1, JobSnapshot, PlannedSegment, DownloadPlan, EngineEvent, OutputRef, RunLease, ErrorCode } from '../shared/contracts';
import { EngineError, fail, safeError } from '../shared/errors';
import { CONTAINER_MIME } from '../shared/capabilities';
import { validateSelection, validateSettings, TERMINAL_STATES } from '../shared/validation';
import { Resolver } from './resolver';
import { OpfsFiles, jobDirectory } from './files';
import { abortableDelay, boundedText, responseIdentity, verifyIdentity } from './fetch';
import { checkpointRef } from './store';
import { probeConfigurations, probeTracks, remux, type MuxLane } from './remux';
import { directFormat } from '../core/direct';
import { mergeWebVtt, validateTtml } from '../core/subtitles';
import { safeComponent } from '../core/filename';
interface Active {
  run: EngineRun; controller: AbortController; done: Promise<void>; revision: number; state: JobSnapshot['state'];
  writes: Promise<void>;
  poll?: AbortController;
  stop: boolean; pause: boolean; cancelled: boolean; lease: RunLease; checkpoint: CheckpointV1; startedAt: number;
}
export function createEngine(deps: EngineDeps): Engine {
  const hostId = crypto.randomUUID(), resolver = new Resolver(deps.fetcher, deps.limits), runs = new Map<string, Active>();
  const starting = new Map<string, { attempt: number; epoch: number; done: Promise<void> }>();
  const key = (id: string, epoch: number) => { const active = runs.get(id); if (!active || active.run.runEpoch !== epoch) fail('INVALID_STATE'); return active; };
  const emit = async (active: Active, type: EngineEvent['type'], payload: object) => { await deps.onEvent({ jobId: active.run.jobId, attempt: active.run.attempt, runEpoch: active.run.runEpoch, revision: active.revision, type, payload }); };
  const update = async (active: Active, patch: Partial<JobSnapshot>) => {
    for (let i = 0; i < 16; i++) {
      const old = await deps.store.readJob(active.run.jobId);
      if (!old || old.attempt !== active.run.attempt || old.runEpoch !== active.run.runEpoch || TERMINAL_STATES.includes(old.state)) fail('INVALID_STATE');
      const next = { ...old, ...patch, id: old.id, attempt: old.attempt, runEpoch: old.runEpoch, revision: old.revision + 1, updatedAt: Date.now() };
      if (await deps.store.compareAndSwapJob(old.id, old.revision, next)) { active.revision = next.revision; active.state = next.state; await emit(active, 'PROGRESS', { state: next.state, bytesWritten: next.bytesWritten, segmentsDone: next.segmentsDone, outputs: next.outputs }); return; }
    }
    fail('INVALID_STATE');
  };
  const warn = async (active: Active, code: ErrorCode, message?: string) => {
    const error = safeError(new EngineError(code)), old = await deps.store.readJob(active.run.jobId);
    if (message) error.message = message;
    await update(active, { warnings: [...(old?.warnings ?? []), error].slice(-100) }); await emit(active, 'WARNING', error);
  };
  const checkpoint = (active: Active): Promise<void> => {
    const operation = active.writes.then(async () => {
      active.checkpoint.updatedAt = Date.now(); active.checkpoint.revision++;
      const durable = structuredClone(active.checkpoint);
      await deps.store.commitCheckpoint(durable); await emit(active, 'CHECKPOINT', { checkpointRef: checkpointRef(active.run.jobId, active.run.attempt) });
      const resumable = !active.run.plan.isLive && durable.completedSegments.every(s => s.identity.etag && !s.identity.etag.startsWith('W/') || s.identity.lastModified);
      await update(active, { bytesWritten: durable.completedSegments.reduce((sum, s) => sum + s.length, 0), segmentsDone: durable.completedSegments.length, ...(active.state === 'downloading' ? { capabilities: { pause: resumable, resume: resumable } } : {}) });
    });
    active.writes = operation.catch(() => {}); return operation;
  };
  const execute = async (active: Active) => {
    const { run } = active, signal = active.controller.signal, namespace = jobDirectory(run.jobId, run.attempt);
    let files: OpfsFiles | undefined;
    let plan = run.plan;
    let spaceWarning = false;
    const checkSpace = async (required?: number) => {
      if (!await files!.checkSpace(required) && !spaceWarning) {
        spaceWarning = true;
        await warn(active, 'QUOTA_EXCEEDED', 'Оценка квоты недостаточна, но может быть неточной. Запись остановится при фактическом недостатке места.');
      }
    };
    const completed = new Map(active.checkpoint.completedSegments.map(s => [s.segmentId, s]));
    const currentParts = new Map<string, { segments: PlannedSegment[]; tracks: DownloadPlan['tracks']; configurationId: string }>();
    try {
      files = await OpfsFiles.open(); await checkSpace();
      const initialJob = await deps.store.readJob(run.jobId);
      const secondsLimit = initialJob?.liveLimits?.durationSeconds ?? run.settingsSnapshot.liveMaxDurationSeconds;
      const byteLimit = initialJob?.liveLimits?.bytes ?? run.settingsSnapshot.liveMaxBytes;
      const liveLimitReached = () => run.plan.isLive && (
        secondsLimit !== undefined && (Date.now() - active.startedAt) / 1000 >= secondsLimit ||
        byteLimit !== undefined && active.checkpoint.completedSegments.reduce((sum, s) => sum + s.length, 0) >= byteLimit
      );
      await deps.store.putPlan(run.plan);
      await update(active, { state: 'resolving' });
      for (const warning of resolver.plans.get(plan.id)!.warnings) await warn(active, warning.code);
      for (const saved of completed.values()) {
        if (!await files.verify(saved.path, saved.length) || !(saved.identity.etag && !saved.identity.etag.startsWith('W/')) && !saved.identity.lastModified) fail('RESOURCE_CHANGED');
        const planned = run.plan.parts.flatMap(p => p.segments).find(s => s.id === saved.segmentId);
        if (!planned) fail('RESOURCE_CHANGED');
        const resource = resolver.resource(run.plan.id, planned.resourceRef);
        const response = await deps.fetcher.request(run.source, resource.url, { signal, range: resource.range, identity: saved.identity, policy: run.settingsSnapshot });
        verifyIdentity(saved.identity, response.headers); await response.body?.cancel();
      }
      // Pause is available before the first segment completes. Its reference
      // must already resolve to a durable (possibly empty) checkpoint, otherwise
      // that valid early pause cannot be resumed. No unwritten bytes are marked.
      await deps.store.commitCheckpoint(structuredClone(active.checkpoint));
      await update(active, { state: 'downloading', capabilities: { pause: !run.plan.isLive, resume: !run.plan.isLive } });
      const initFiles = new Map<string, File>();
      const attachments = new Map<string, File>();
      const lastSequence = new Map<string, number>(), hlsStarts = new Map<string, number>(), dashEnds = new Map<string, number>();
      do {
        for (const part of plan.parts) {
          let accumulated = currentParts.get(part.id);
          if (!accumulated) { accumulated = { segments: [], tracks: plan.tracks, configurationId: part.configurationId }; currentParts.set(part.id, accumulated); }
          const knownSegments = new Set(accumulated.segments.map(s => s.id));
          const selected = part.segments.filter(s => !knownSegments.has(s.id));
          // Concurrency is bounded per job; each response is backpressured directly to disk.
          let cursor = 0;
          const download = async () => {
            while (cursor < selected.length) {
              signal.throwIfAborted(); const original = selected[cursor++];
              const s = { ...original };
              try {
              if (plan.protocol === 'dash' && plan.isLive) {
                const key = `${part.id}:${s.trackId}`, previousEnd = dashEnds.get(key);
                if (previousEnd !== undefined && s.start > previousEnd + 0.1) await warn(active, 'SEGMENT_MISSING');
                dashEnds.set(key, s.start + s.duration);
              }
              if (plan.protocol === 'hls' && plan.isLive) {
                const last = lastSequence.get(s.trackId);
                if (last !== undefined && s.sequence !== undefined && s.sequence > last + 1) await warn(active, 'SEGMENT_MISSING');
                const knownStart = hlsStarts.get(`${s.trackId}:${s.sequence}`);
                if (knownStart !== undefined) s.start = knownStart;
                else {
                  const previous = [...accumulated!.segments].filter(x => x.trackId === s.trackId).at(-1);
                  if (previous) s.start = previous.start + previous.duration;
                  hlsStarts.set(`${s.trackId}:${s.sequence}`, s.start);
                }
                if (s.sequence !== undefined) lastSequence.set(s.trackId, s.sequence);
              }
              if (!completed.has(s.id)) {
                const resource = resolver.resource(plan.id, s.resourceRef), path = `${namespace}/segments/${crypto.randomUUID()}`;
                const response = await deps.fetcher.request(run.source, resource.url, { signal, range: resource.range, policy: run.settingsSnapshot });
                if (!response.body) fail('HTTP_ERROR');
                const identity = responseIdentity(response.headers);
                try { await checkSpace(identity.length); }
                catch (error) { await response.body.cancel(); throw error; }
                const length = await files!.write(path, response.body, signal);
                const item = { segmentId: s.id, path, length, identity }; completed.set(s.id, item); active.checkpoint.completedSegments.push(item);
                await checkpoint(active);
              }
              if (s.initRef) {
                const resource = resolver.resource(plan.id, s.initRef), initKey = `${resource.url}:${JSON.stringify(resource.range)}`;
                if (!initFiles.has(initKey)) {
                  const response = await deps.fetcher.request(run.source, resource.url, { signal, range: resource.range, policy: run.settingsSnapshot });
                  if (!response.body) fail('HTTP_ERROR');
                  const path = `${namespace}/segments/init-${crypto.randomUUID()}`;
                  await files!.write(path, response.body, signal); initFiles.set(initKey, await files!.read(path));
                }
                attachments.set(s.id, initFiles.get(initKey)!);
              }
              accumulated!.segments.push(s);
              } catch (error) {
                if (plan.tracks.find(t => t.id === s.trackId)?.kind === 'subtitle' && !signal.aborted) { await warn(active, 'UNSUPPORTED_FORMAT'); continue; }
                if (plan.isLive && error instanceof EngineError && error.code === 'SEGMENT_MISSING') { await warn(active, 'SEGMENT_MISSING'); continue; }
                active.controller.abort(error); throw error;
              }
            }
          };
          // Serial live preserves sequence/window bookkeeping. VOD uses requested parallelism.
          const workers = Array.from({ length: plan.isLive ? 1 : Math.min(run.settingsSnapshot.segmentsConcurrency, selected.length) }, download);
          const results = await Promise.allSettled(workers);
          const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected'); if (rejected) throw rejected.reason;
        }
        if (!plan.isLive || active.stop) break;
        if (liveLimitReached()) break;
        const poll = new AbortController(); active.poll = poll;
        const abortPoll = () => poll.abort(signal.reason);
        signal.addEventListener('abort', abortPoll, { once: true });
        const remainingMs = secondsLimit === undefined ? Infinity : Math.max(0, secondsLimit * 1000 - (Date.now() - active.startedAt));
        try { await abortableDelay(Math.min(resolver.plans.get(plan.id)!.refreshSeconds * 1000, remainingMs), poll.signal); }
        catch (error) { if (!active.stop) throw error; }
        finally { signal.removeEventListener('abort', abortPoll); active.poll = undefined; }
        if (active.stop || liveLimitReached()) break;
        const previousPlanId = plan.id;
        plan = await resolver.plan(run.source, run.plan.selection, signal);
        if (plan.protocol !== run.plan.protocol || JSON.stringify(plan.tracks) !== JSON.stringify(run.plan.tracks)) fail('RESOURCE_CHANGED');
        resolver.release(previousPlanId);
        if ([...currentParts.values()].reduce((n, p) => n + p.segments.length, 0) > deps.limits.segments) fail('MANIFEST_LIMIT');
      } while (true);
      signal.throwIfAborted();
      await update(active, { state: 'assembling', capabilities: { pause: false, resume: false } });
      if (plan.protocol !== 'direct') await checkSpace(active.checkpoint.completedSegments.reduce((sum, s) => sum + s.length, 0) + 16 * 1024 * 1024);
      // Split changed decoder configurations even without a discontinuity tag.
      // Rebase all selected lanes together, not audio and video independently.
      if (plan.protocol !== 'direct') for (const [id, part] of [...currentParts]) {
        const configurations = new Map<string, string>(), boundaries = new Set<number>();
        for (const s of [...part.segments].sort((a, b) => a.start - b.start)) {
          const track = part.tracks.find(t => t.id === s.trackId)!;
          if (track.kind === 'subtitle') continue;
          const file = await files.read(completed.get(s.id)!.path), init = attachments.get(s.id);
          const configs = await probeConfigurations(init ? new Blob([init, file]) : file);
          for (const [kind, config] of Object.entries(configs)) {
            if (kind === 'audio' && track.kind === 'video' && part.tracks.some(t => t.kind === 'audio')) continue;
            const key = `${s.trackId}:${kind}`, previous = configurations.get(key);
            if (previous !== undefined && previous !== config) boundaries.add(s.start);
            configurations.set(key, config);
          }
        }
        const start = Math.min(...part.segments.map(s => s.start)), end = Math.max(...part.segments.map(s => s.start + s.duration));
        const cuts = [start, ...[...boundaries].filter(t => t > start && t < end).sort((a, b) => a - b), end];
        if (cuts.length > 2) {
          currentParts.delete(id);
          for (let i = 0; i < cuts.length - 1; i++) currentParts.set(`${id}-config${i}`, { ...part, segments: part.segments.filter(s => s.start < cuts[i + 1] && s.start + s.duration > cuts[i]).map(s => ({ ...s, start: s.start - cuts[i], duration: Math.min(s.duration, cuts[i + 1] - s.start) })) });
        }
      }
      if (currentParts.size > 1) await warn(active, 'RESOURCE_CHANGED');
      let outputIndex = 0; const outputs: OutputRef[] = [];
      const exportEvents: { outputRef: OutputRef; opfsRelativePath: string; mime: string; bytes: number }[] = [];
      const ready = async (path: string, mime: string, suffix: string) => {
        const bytes = (await files!.read(path)).size;
        if (!bytes) fail('MUX_FAILED');
        const job = await deps.store.readJob(run.jobId); if (!job) fail('INVALID_STATE');
        const stem = safeComponent(job.outputName.replace(/\.[a-zA-Z0-9]{1,8}$/, ''));
        const output: OutputRef = { part: ++outputIndex, name: `${stem}${currentParts.size > 1 ? `-part${outputIndex}` : ''}.${suffix}`, mime, bytes, state: 'ready' };
        outputs.push(output); active.checkpoint.outputs.push({ path, committedBytes: bytes });
        await checkpoint(active);
        exportEvents.push({ outputRef: output, opfsRelativePath: path, mime, bytes });
      };
      for (const part of currentParts.values()) {
        part.segments.sort((a, b) => a.start - b.start || (a.sequence ?? 0) - (b.sequence ?? 0));
        const blob = async (s: PlannedSegment): Promise<Blob> => {
          const saved = completed.get(s.id); if (!saved) fail('RESOURCE_CHANGED');
          const file = await files!.read(saved.path), init = attachments.get(s.id);
          return init ? new Blob([init, file]) : file;
        };
        if (run.plan.protocol === 'direct') {
          const saved = completed.get(part.segments[0].id)!;
          const file = await files.read(saved.path), format = directFormat(new Uint8Array(await file.slice(0, 4096).arrayBuffer()));
          // Existing disk-backed input becomes the output: no second full copy.
          await ready(saved.path, format.mime, format.suffix); continue;
        }
        const lanes: MuxLane[] = [], firstStart = Math.max(0, Math.min(...part.segments.map(s => s.start)));
        for (const track of part.tracks) {
          const segments = part.segments.filter(s => s.trackId === track.id);
          if (!segments.length) continue;
          if (track.kind === 'subtitle') {
            try {
              const text: { text: string; start: number }[] = []; let textBudget = deps.limits.manifestBytes;
              for (const s of segments) {
                const content = await boundedText(new Response(await blob(s)), textBudget);
                textBudget -= new TextEncoder().encode(content).length;
                text.push({ text: content, start: s.start - firstStart });
              }
              const ttml = /ttml/.test(track.codec) || /^\s*<\??/.test(text[0].text);
              // Multiple TTML documents stay separate valid sidecars, never invalid XML concatenation.
              const documents = ttml ? text.map(s => validateTtml(s.text)) : [mergeWebVtt(text)];
              for (const [index, doc] of documents.entries()) { const path = `${namespace}/output/sub-${crypto.randomUUID()}`; await files.write(path, new Blob([doc]).stream(), signal); await ready(path, ttml ? 'application/ttml+xml' : 'text/vtt', `${safeComponent(track.language ?? 'und')}${documents.length > 1 ? `-${index + 1}` : ''}.${ttml ? 'ttml' : 'vtt'}`); }
            } catch (error) { if (signal.aborted) throw error; await warn(active, 'UNSUPPORTED_FORMAT'); }
            continue;
          }
          const data = await Promise.all(segments.map(async s => ({ file: await blob(s), start: s.start - firstStart, duration: s.duration })));
          const tracks = await probeTracks(data[0].file);
          if (track.kind === 'video' && !run.plan.selection.audioOnly && tracks.video) lanes.push({ kind: 'video', segments: data });
          if (track.kind === 'audio' || tracks.audio && !part.tracks.some(t => t.kind === 'audio')) lanes.push({ kind: 'audio', segments: data, language: track.language });
        }
        if (lanes.length) { const path = `${namespace}/output/media-${crypto.randomUUID()}`; await remux(lanes, run.plan.container, await files.handle(path, true), signal); await ready(path, CONTAINER_MIME[run.plan.container], run.plan.container); }
      }
      if (!outputs.some(o => /^(?:video|audio)\//.test(o.mime))) fail('MUX_FAILED');
      await update(active, { state: 'awaiting_export', outputs });
      // A coordinator may start exporting immediately inside this callback.
      // Publish only after all required outputs and their durable snapshot exist.
      for (const payload of exportEvents) { signal.throwIfAborted(); await update(active, {}); await emit(active, 'EXPORT_READY', payload); }
    } catch (error) {
      if (active.cancelled) {
        await update(active, { state: 'cancelled' }).catch(() => {});
      } else if (active.pause) {
        await update(active, { state: 'paused', checkpointRef: checkpointRef(run.jobId, run.attempt) }).catch(() => {});
      } else {
        const safe = safeError(active.controller.signal.aborted ? active.controller.signal.reason : error);
        await update(active, { state: 'failed', error: safe }).catch(() => {}); await emit(active, 'FAILED', safe);
      }
    } finally {
      await deps.store.releaseLease(active.lease);
      if (active.cancelled) await deps.store.deleteTemporary(run.jobId, run.attempt);
      await emit(active, 'STOPPED', { state: active.state });
      if (!active.pause) { resolver.release(plan.id); resolver.release(run.plan.id); runs.delete(run.jobId); }
    }
  };
  const begin = async (run: EngineRun, saved?: CheckpointV1) => {
    validateSelection(run.plan.selection); validateSettings(run.settingsSnapshot);
    const existing = runs.get(run.jobId);
    if (existing && !existing.pause) { if (existing.run.attempt !== run.attempt || existing.run.runEpoch !== run.runEpoch) fail('INVALID_STATE'); return; }
    if (!resolver.plans.has(run.plan.id) || run.source.sourceRef !== run.plan.sourceRef) fail('URL_EXPIRED');
    const lease = { jobId: run.jobId, attempt: run.attempt, runEpoch: run.runEpoch, hostId };
    if (!await deps.store.acquireLease(lease)) fail('INVALID_STATE');
    const active: Active = { run, controller: new AbortController(), done: Promise.resolve(), writes: Promise.resolve(), revision: 0, state: 'resolving', stop: false, pause: false, cancelled: false, lease, startedAt: Date.now(), checkpoint: saved ?? { schemaVersion: 1, jobId: run.jobId, attempt: run.attempt, runEpoch: run.runEpoch, planId: run.plan.id, revision: 0, completedSegments: [], outputs: [], updatedAt: Date.now() } };
    runs.set(run.jobId, active); active.done = execute(active);
    // Errors in the event/storage channel still terminate the run; never unhandled rejections.
    void active.done.catch(() => { runs.delete(run.jobId); });
  };
  const start = (run: EngineRun, saved?: CheckpointV1): Promise<void> => {
    const pending = starting.get(run.jobId);
    if (pending) {
      if (pending.attempt !== run.attempt || pending.epoch !== run.runEpoch) return Promise.reject(new EngineError('INVALID_STATE'));
      return pending.done;
    }
    const done = begin(run, saved).finally(() => { starting.delete(run.jobId); });
    starting.set(run.jobId, { attempt: run.attempt, epoch: run.runEpoch, done });
    return done;
  };
  return {
    inspect: (source, signal) => resolver.inspect(source, signal), plan: (source, selection, signal) => resolver.plan(source, validateSelection(selection), signal), start,
    async pause(jobId, epoch) { const a = key(jobId, epoch); const job = await deps.store.readJob(jobId); if (a.run.plan.isLive || a.state !== 'downloading' || !job?.capabilities.pause) fail('INVALID_STATE'); a.pause = true; a.controller.abort(); await a.done; return checkpointRef(jobId, a.run.attempt); },
    async resume(run, ref) { const saved = await deps.store.readCheckpoint(ref); if (!saved || saved.jobId !== run.jobId || saved.attempt !== run.attempt || saved.runEpoch !== run.runEpoch || saved.planId !== run.plan.id) fail('RESOURCE_CHANGED'); await start(run, saved); },
    async stopLiveAndSave(jobId, epoch) { const a = key(jobId, epoch); if (!a.run.plan.isLive || a.state !== 'downloading') fail('INVALID_STATE'); a.stop = true; a.poll?.abort(); await a.done; },
    async cancel(jobId, epoch) { const a = key(jobId, epoch); a.cancelled = true; a.controller.abort(); await a.done; if (a.pause) { await update(a, { state: 'cancelled' }); await deps.store.deleteTemporary(jobId, a.run.attempt); resolver.release(a.run.plan.id); runs.delete(jobId); } },
    async snapshot() { return { hostId, runs: [...runs.values()].map(a => ({ jobId: a.run.jobId, attempt: a.run.attempt, runEpoch: a.run.runEpoch, revision: a.revision, state: a.state })) }; },
  };
}
export { IndexedDbEngineStore } from './store';
export { OpfsFiles } from './files';
export { createAuthorizedFetcher } from './fetch';
