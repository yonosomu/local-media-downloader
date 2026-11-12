import type { AuthorizedSource, EngineSnapshot, JobSnapshot, MediaCandidate, ResolvedMedia, RuntimeSource, EngineEvent, OutputRef, DownloadPlan } from '../shared/contracts';
import { DEFAULT_SETTINGS } from '../shared/contracts';
import { validateEnvelope, validateHintBinding, validateSelection, validateHostSender, object, exactKeys, integer } from '../shared/validation';
import { EngineError, fail, safeError } from '../shared/errors';
import { IndexedDbEngineStore } from '../engine/store';
import { OpfsFiles } from '../engine/files';
import { Registry, checkedUrl, isMedia, isSegment, originPattern, safeTitle, uiSender, jobActive, discoveryAllowed, type Binding, type RegistryState } from './model';
import { all, get, put, openDatabase, mutate, fingerprint, receipt, reserve, finish, type JobContext, type ExportIntent } from './database';
import { readSettings, writeSettings } from './settings';
import { watchRequests } from './web-request';
const registry = new Registry(), hostUrl = chrome.runtime.getURL('offscreen/host.html');
async function localOrigins(): Promise<string[]> { return (await chrome.storage.local.get('localModeOrigins')).localModeOrigins as string[] ?? []; }
async function jobSources(): Promise<Record<string, RuntimeSource>> { return (await chrome.storage.session.get('jobSources')).jobSources as Record<string, RuntimeSource> ?? {}; }
let db: IDBDatabase, store: IndexedDbEngineStore, initializing: Promise<void> | undefined;
let serial = Promise.resolve(), pumping = false;
const ports = new Set<chrome.runtime.Port>(), inspecting = new Map<string, Promise<void>>(), probeQueue: (() => Promise<void>)[] = [];
const requestBindings = new Map<string, Binding>(), hintRates = new Map<string, { start: number; count: number }>();
let probes = 0;
const pendingBroadcast = new Map<string, ReturnType<typeof setTimeout>>(), lastBroadcast = new Map<string, number>();
function exclusive<T>(fn: () => Promise<T>): Promise<T> { const next = serial.then(fn, fn); serial = next.then(() => {}, () => {}); return next; }
async function rpc<T>(type: string, payload: object = {}): Promise<T> {
  const result = await chrome.runtime.sendMessage({ version: 1, requestId: crypto.randomUUID(), target: 'engine-host', type, payload });
  if (!result?.ok) { const code = result?.error?.code; throw new EngineError(code ?? 'BROWSER_UNSUPPORTED'); }
  return result.data as T;
}
async function persist(): Promise<void> { await chrome.storage.session.set({ registry: registry.snapshot() }); }

async function notify(type: string, payload: object, revision = Date.now(), jobId?: string): Promise<void> {
  const event = { version: 1, type, revision, ...(jobId ? { jobId } : {}), payload };
  for (const port of ports) try { port.postMessage(event); } catch { ports.delete(port); }
}
async function changed(jobId: string): Promise<void> {
  const send = async () => { pendingBroadcast.delete(jobId); lastBroadcast.set(jobId, Date.now()); const job = await store.readJob(jobId); if (job) await notify('JOB_CHANGED', { job: await view(job) }, job.revision, jobId); };
  const delay = Math.max(0, 250 - (Date.now() - (lastBroadcast.get(jobId) ?? 0)));
  if (!pendingBroadcast.has(jobId)) { if (!delay) await send(); else pendingBroadcast.set(jobId, setTimeout(() => { void send(); }, delay)); }
}
async function mediaChanged(tabId: number): Promise<void> { registry.revision++; await persist(); await badge(tabId); await notify('MEDIA_CHANGED', { tabId }, registry.revision); }
async function badge(tabId: number): Promise<void> { const count = registry.entries.filter(e => e.candidate.tabId === tabId).length; await chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {}); }
async function context(jobId: string): Promise<JobContext> { const c = await get<JobContext>(db, 'exports', `context:${jobId}`); if (!c) fail('INVALID_STATE'); return c; }
async function view(job: JobSnapshot): Promise<JobSnapshot & { title: string; domain: string; isLive: boolean }> { const c = await get<JobContext>(db, 'exports', `context:${job.id}`); return { ...job, title: c?.title ?? 'Медиа', domain: c?.domain ?? '', isLive: c?.isLive ?? false }; }
async function allowedSource(source: RuntimeSource): Promise<AuthorizedSource> {
  if (!source || source.expiresAt !== undefined && source.expiresAt < Date.now()) fail('URL_EXPIRED');
  const origins = (await chrome.permissions.getAll()).origins ?? [], local = await localOrigins();
  const candidates = new Set([new URL(source.exactUrl).origin, ...source.discoveredOrigins]);
  // Expand concrete host permissions only, never hand a wildcard authority to the engine.
  for (const pattern of origins) if (!pattern.includes('*://') && !pattern.includes('://*.') && !/^(http|https):\/\/\*\//.test(pattern)) { try { candidates.add(new URL(pattern).origin); } catch { /* non-HTTP pattern */ } }
  const allowedOrigins: string[] = [];
  for (const origin of candidates) if (await chrome.permissions.contains({ origins: [originPattern(origin)] })) allowedOrigins.push(origin);
  checkedUrl(source.exactUrl, local);
  if (!allowedOrigins.includes(new URL(source.exactUrl).origin)) fail('PERMISSION_REQUIRED');
  // Local authority is bound to the source origin; a remote manifest can never inherit it.
  const sourceOrigin = new URL(source.exactUrl).origin;
  return { sourceRef: source.sourceRef, exactUrl: source.exactUrl, allowedOrigins, localModeOrigins: local.includes(sourceOrigin) ? [sourceOrigin] : [] };
}
async function ensure(): Promise<void> {
  if (!initializing) initializing = (async () => {
    if (!chrome.offscreen?.createDocument || !chrome.runtime.getContexts || !chrome.downloads?.download || !chrome.storage.session || !chrome.scripting) fail('BROWSER_UNSUPPORTED');
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    registry.restore((await chrome.storage.session.get('registry')).registry as RegistryState | undefined);
    const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [hostUrl] });
    if (!contexts.length) await chrome.offscreen.createDocument({ url: 'offscreen/host.html', reasons: [chrome.offscreen.Reason.BLOBS, chrome.offscreen.Reason.WORKERS], justification: 'Потоковая обработка медиа в worker и дисковые Blob URL до подтверждения Downloads.' });
    await rpc<EngineSnapshot>('ENGINE_SNAPSHOT');
    db = await openDatabase(); store = await IndexedDbEngineStore.open(await OpfsFiles.open());
    await rpc('ENGINE_RECONCILE');
    await reconcileExports();
    const snapshot = await rpc<EngineSnapshot>('ENGINE_SNAPSHOT');
    for (const job of await store.listRecoverable()) {
      if (['resolving', 'downloading', 'assembling'].includes(job.state) && !snapshot.runs.some(r => r.jobId === job.id && r.attempt === job.attempt && r.runEpoch === job.runEpoch)) await mutate(db, job.id, j => ({ ...j, state: 'interrupted', capabilities: { pause: false, resume: false }, error: safeError(new EngineError('URL_EXPIRED')) }));
      if (job.state === 'awaiting_export' && !snapshot.runs.some(r => r.jobId === job.id) && !(await all<ExportIntent>(db, 'exports')).some(e => e.jobId === job.id && e.attempt === job.attempt && e.status)) await mutate(db, job.id, j => ({ ...j, state: 'interrupted', error: safeError(new EngineError('EXPORT_CANCELLED')) }));
    }
    await syncScripts();
    await chrome.alarms.create('lmd-maintenance', { periodInMinutes: 5 });
    void maintenance();
  })().catch(error => { initializing = undefined; throw error; });
  await initializing;
}
async function syncScripts(): Promise<void> {
  const origins = (await chrome.permissions.getAll()).origins?.filter(p => /^https?:/.test(p)) ?? [];
  await chrome.scripting.unregisterContentScripts().catch(() => {});
  if (origins.length) await chrome.scripting.registerContentScripts([{ id: 'lmd-dom', matches: origins, js: ['content/observer.js'], allFrames: true, runAt: 'document_idle', persistAcrossSessions: true }]);
}
async function bindingFor(tabId: number, frameId: number, documentId?: string): Promise<Binding> {
  const frame = await chrome.webNavigation.getFrame({ tabId, frameId });
  if (!frame?.documentId || documentId && frame.documentId !== documentId) fail('INVALID_REQUEST');
  return registry.bind(tabId, frameId, frame.documentId, new URL(frame.url).origin);
}
function scheduleProbe(work: () => Promise<void>): void {
  if (probeQueue.length >= 200) return;
  probeQueue.push(work);
  const drain = () => { while (probes < 4 && probeQueue.length) { probes++; void probeQueue.shift()!().catch(() => {}).finally(() => { probes--; drain(); }); } };
  drain();
}
async function discover(binding: Binding, exactUrl: string, title: string, mime = ''): Promise<void> {
  if (!registry.current(binding) || isSegment(exactUrl, mime)) return;
  const settings = (await readSettings()).settings;
  const tab = await chrome.tabs.get(binding.tabId).catch(() => undefined);
  if (!tab?.url || !discoveryAllowed(settings, new URL(tab.url).hostname)) return;
  const local = await localOrigins();
  checkedUrl(exactUrl, local);
  const origin = new URL(exactUrl).origin;
  if (!await chrome.permissions.contains({ origins: [originPattern(origin)] })) return;
  if (registry.entries.some(e => e.source.documentKey === binding.documentKey && (e.source.exactUrl === exactUrl || e.relatedUrls?.includes(exactUrl)))) return;
  const source: RuntimeSource = { sourceRef: crypto.randomUUID(), exactUrl, tabId: binding.tabId, frameId: binding.frameId, documentKey: binding.documentKey, generation: binding.generation, discoveredOrigins: [origin], expiresAt: Date.now() + 1800000 };
  const id = crypto.randomUUID();
  const candidate: MediaCandidate = { id, tabId: binding.tabId, frameId: binding.frameId, documentKey: binding.documentKey, generation: binding.generation, revision: 0, title: safeTitle(title || tab.title || 'Медиа'), sourceOrigin: origin, protocol: /\.mpd(?:$|[?#])|dash\+xml/i.test(exactUrl + mime) ? 'dash' : /\.m3u8(?:$|[?#])|mpegurl/i.test(exactUrl + mime) ? 'hls' : 'direct', isLive: false, variants: [], audioTracks: [], subtitleTracks: [], sourceRef: source.sourceRef, detectedAt: Date.now(), support: 'unknown', capabilities: { pause: false, resume: false, requiresSourceTab: false, containers: [] } };
  registry.entries.push({ candidate, source, requiredOrigins: [] }); registry.trim(); await mediaChanged(binding.tabId);
  scheduleProbe(() => inspect(id));
}
async function inspect(id: string): Promise<void> {
  if (inspecting.has(id)) return inspecting.get(id);
  const work = (async () => {
    const entry = registry.find(id), bindingKey = entry.candidate.documentKey;
    try {
      const media = await rpc<ResolvedMedia>('ENGINE_INSPECT', { source: await allowedSource(entry.source) });
      if (!registry.entries.includes(entry) || entry.candidate.documentKey !== bindingKey) return;
      Object.assign(entry.candidate, { ...media, capabilities: { pause: false, resume: false, requiresSourceTab: false, containers: media.containers }, revision: entry.candidate.revision + 1, support: 'supported' });
      delete (entry.candidate as MediaCandidate & { containers?: unknown }).containers;
      delete entry.candidate.unsupportedReason; delete entry.error;
    } catch (error) { if (registry.entries.includes(entry)) { entry.error = safeError(error).code; entry.candidate.support = 'unsupported'; entry.candidate.unsupportedReason = safeError(error).message; entry.candidate.revision++; } }
    if (registry.entries.includes(entry)) await mediaChanged(entry.candidate.tabId);
  })().finally(() => inspecting.delete(id)); inspecting.set(id, work); return work;
}
async function pump(): Promise<void> {
  if (pumping) return; pumping = true;
  try {
    const settings = (await readSettings()).settings, jobs = await all<JobSnapshot>(db, 'jobs');
    let running = jobs.filter(j => jobActive(j) && j.state !== 'queued').length;
    for (const job of jobs.filter(j => j.state === 'queued').sort((a, b) => a.createdAt - b.createdAt)) {
      if (running >= settings.jobsConcurrency) break;
      running++;
      await mutate(db, job.id, j => j.state === 'queued' ? { ...j, state: 'resolving' } : j);
      void startJob(job.id).catch(async error => { await mutate(db, job.id, j => jobActive(j) ? { ...j, state: 'failed', error: safeError(error) } : j); await changed(job.id); await recordHistory(job.id); void pump(); });
    }
  } finally { pumping = false; }
}
async function startJob(jobId: string): Promise<void> {
  const job = await store.readJob(jobId); if (!job || job.state !== 'resolving') return;
  const c = await context(job.id), source = registry.entries.find(e => e.source.sourceRef === c.sourceRef)?.source ?? (await jobSources())[job.id];
  if (!source) fail('URL_EXPIRED');
  const authorized = await allowedSource(source), plan = c.planId ? await store.readPlan(c.planId) : await rpc<DownloadPlan>('ENGINE_PLAN', { source: authorized, selection: job.selection });
  if (!plan) fail('URL_EXPIRED');
  if (!c.planId) { await store.putPlan(plan); await put(db, 'exports', { ...c, planId: plan.id }); }
  const current = await store.readJob(job.id); if (current?.state !== 'resolving' || current.runEpoch !== job.runEpoch) return;
  await rpc('ENGINE_START', { run: { jobId: job.id, attempt: job.attempt, runEpoch: job.runEpoch, plan, source: authorized, settingsSnapshot: c.settingsSnapshot } });
  await changed(job.id);
}
async function onEngineEvent(event: EngineEvent & { sourceRef?: string; origin?: string; exactUrl?: string }): Promise<void> {
  if (event.type as string === 'RESOURCE_OBSERVED') {
    const entry = registry.entries.find(e => e.source.sourceRef === event.sourceRef);
    if (entry && event.exactUrl) {
      const related = entry.relatedUrls ?? []; if (related.length < 1000 && !related.includes(event.exactUrl)) related.push(event.exactUrl); entry.relatedUrls = related;
      registry.entries = registry.entries.filter(e => e === entry || e.candidate.documentKey !== entry.candidate.documentKey || e.source.exactUrl !== event.exactUrl);
      await mediaChanged(entry.candidate.tabId);
    }
    return;
  }
  if (event.type as string === 'PERMISSION_REQUIRED') {
    if (!event.sourceRef || !event.origin) return;
    const u = new URL(event.origin); if (u.origin !== event.origin || !['http:', 'https:'].includes(u.protocol)) return;
    for (const entry of registry.entries.filter(e => e.source.sourceRef === event.sourceRef)) {
      if (!entry.requiredOrigins.includes(u.origin)) entry.requiredOrigins.push(u.origin);
      if (!entry.source.discoveredOrigins.includes(u.origin)) entry.source.discoveredOrigins.push(u.origin);
    }
    await persist(); await notify('PERMISSION_REQUIRED', { origins: [originPattern(u.origin)], origin: u.origin }); return;
  }
  const job = await store.readJob(event.jobId);
  if (!job || job.attempt !== event.attempt || job.runEpoch !== event.runEpoch) return;
  if (event.type === 'EXPORT_READY' && ['awaiting_export', 'exporting'].includes(job.state)) await exclusive(() => exportOutput(job.id, event.payload));
  if (event.type === 'STOPPED') { const latest = await store.readJob(job.id); if (latest?.outputs.length && latest.outputs.every(o => o.state === 'saved')) await rpc('ENGINE_CLEAN', { jobId: job.id, attempt: job.attempt }).catch(() => {}); await recordHistory(job.id); void pump(); }
  await changed(job.id);
}
async function exportOutput(jobId: string, payload: unknown): Promise<void> {
  const p = object(payload), output = object(p.outputRef), job = await store.readJob(jobId); if (!job || !['awaiting_export', 'exporting'].includes(job.state)) return;
  const part = integer(output.part, 1), actual = job.outputs.find(o => o.part === part);
  if (!actual || actual.bytes !== p.bytes || actual.mime !== p.mime || actual.state !== 'ready' || typeof p.opfsRelativePath !== 'string' || !p.opfsRelativePath.startsWith(`jobs/${job.id}/attempt-${job.attempt}/`)) fail('INVALID_REQUEST');
  const id = `${job.id}:${job.attempt}:${part}`;
  if (await get(db, 'exports', id)) return;
  const c = await context(job.id), filename = [c.relativeDirectory, actual.name].filter(Boolean).join('/');
  const intent: ExportIntent = { id, jobId: job.id, attempt: job.attempt, runEpoch: job.runEpoch, part, status: 'intent', filename };
  await put(db, 'exports', intent);
  await mutate(db, job.id, j => ({ ...j, state: 'exporting', outputs: j.outputs.map(o => o.part === part ? { ...o, state: 'exporting' } : o) }));
  try {
    const { objectUrl } = await rpc<{ objectUrl: string }>('HOST_OUTPUT', { jobId: job.id, attempt: job.attempt, part, path: p.opfsRelativePath });
    if (!objectUrl.startsWith(`blob:chrome-extension://${chrome.runtime.id}/`)) fail('INVALID_REQUEST');
    const downloadId = await chrome.downloads.download({ url: objectUrl, filename, conflictAction: 'uniquify', saveAs: c.saveAs });
    await put(db, 'exports', { ...intent, status: 'started', browserDownloadId: downloadId });
    await mutate(db, job.id, j => ({ ...j, browserDownloadId: downloadId, outputs: j.outputs.map(o => o.part === part ? { ...o, browserDownloadId: downloadId } : o) }));
    const [download] = await chrome.downloads.search({ id: downloadId }); if (download?.state !== 'in_progress') await acknowledge(downloadId);
  } catch { await put(db, 'exports', { ...intent, status: 'cancelled' }); await mutate(db, job.id, j => ({ ...j, state: 'failed', error: safeError(new EngineError('EXPORT_CANCELLED')), outputs: j.outputs.map(o => o.part === part ? { ...o, state: 'cancelled' } : o) })); await rpc('HOST_REVOKE', { jobId: job.id, attempt: job.attempt, part }); await recordHistory(job.id); void pump(); }
}
async function acknowledge(downloadId: number): Promise<void> {
  const intent = (await all<ExportIntent>(db, 'exports')).find(e => e.browserDownloadId === downloadId);
  if (!intent || intent.status === 'saved' || intent.status === 'cancelled') return;
  const job = await store.readJob(intent.jobId); if (!job || job.attempt !== intent.attempt || job.runEpoch !== intent.runEpoch || ['cancelled', 'completed', 'completed_with_warnings'].includes(job.state)) return;
  const [item] = await chrome.downloads.search({ id: downloadId }); if (!item || item.state === 'in_progress') return;
  const saved = item.state === 'complete';
  await put(db, 'exports', { ...intent, status: saved ? 'saved' : 'cancelled' });
  await mutate(db, job.id, j => {
    const outputs: OutputRef[] = j.outputs.map(o => o.part === intent.part ? { ...o, state: saved ? 'saved' : 'cancelled' } : o);
    const complete = outputs.every(o => o.state === 'saved');
    return { ...j, outputs, state: !saved ? 'failed' : complete ? j.warnings.length ? 'completed_with_warnings' : 'completed' : j.state, ...(!saved ? { error: safeError(new EngineError('EXPORT_CANCELLED')) } : {}) };
  });
  await rpc('HOST_REVOKE', { jobId: job.id, attempt: job.attempt, part: intent.part });
  const updated = await store.readJob(job.id);
  if (updated && ['completed', 'completed_with_warnings'].includes(updated.state)) await rpc('ENGINE_CLEAN', { jobId: job.id, attempt: job.attempt }).catch(() => {});
  await changed(job.id); await recordHistory(job.id); void pump();
}
async function reconcileExports(): Promise<void> {
  for (const e of await all<ExportIntent>(db, 'exports')) {
    if (e.status === 'started' && e.browserDownloadId !== undefined) await acknowledge(e.browserDownloadId);
    if (e.status === 'intent') { await mutate(db, e.jobId, j => ({ ...j, state: 'interrupted', error: safeError(new EngineError('EXPORT_CANCELLED')) })); }
  }
}
async function recordHistory(jobId: string): Promise<void> {
  const job = await store.readJob(jobId), settings = (await readSettings()).settings;
  if (!job || jobActive(job) || job.state === 'paused') return;
  if (settings.historyEnabled) { const c = await get<JobContext>(db, 'exports', `context:${jobId}`); await put(db, 'history', { id: job.id, time: job.updatedAt, title: c?.title ?? 'Медиа', domain: c?.domain ?? '', result: job.state, bytes: job.bytesWritten }); }
  await pruneHistory();
}
async function pruneHistory(): Promise<void> {
  const s = (await readSettings()).settings, history = (await all<{ id: string; time: number }>(db, 'history')).sort((a, b) => b.time - a.time), jobs = await all<JobSnapshot>(db, 'jobs');
  const keep = new Set(s.historyEnabled ? history.filter(h => Date.now() - h.time < s.historyMaxDays * 86400000).slice(0, s.historyMaxEntries).map(h => h.id) : []);
  const receipts = await all<{ requestId: string; jobId?: string; time?: number }>(db, 'commandReceipts');
  const exports = await all<ExportIntent | JobContext>(db, 'exports');
  const tx = db.transaction(['jobs', 'history', 'commandReceipts', 'exports', 'plans'], 'readwrite'), done = finish(tx);
  for (const h of history) if (!keep.has(h.id)) tx.objectStore('history').delete(h.id);
  // Interrupted jobs are recovery work, not disposable history. In particular,
  // startup reconciliation must not race maintenance and erase the user's job
  // before the UI can offer redetection/cleanup (even with history disabled).
  const removed = new Set(jobs.filter(j => ['completed', 'completed_with_warnings', 'cancelled', 'failed'].includes(j.state) && !keep.has(j.id)).map(j => j.id));
  for (const id of removed) tx.objectStore('jobs').delete(id);
  for (const r of receipts) if (r.jobId && removed.has(r.jobId) || r.time !== undefined && Date.now() - r.time > 30 * 86400000) tx.objectStore('commandReceipts').delete(r.requestId);
  for (const e of exports) {
    if ('jobId' in e && removed.has(e.jobId) || e.id.startsWith('context:') && removed.has(e.id.slice(8))) { tx.objectStore('exports').delete(e.id); if ('planId' in e && e.planId) tx.objectStore('plans').delete(e.planId); }
  }
  await done;
  const sources = await jobSources();
  for (const id of Object.keys(sources)) if (removed.has(id) || sources[id].expiresAt !== undefined && sources[id].expiresAt! < Date.now()) delete sources[id];
  await chrome.storage.session.set({ jobSources: sources });
}
async function maintenance(): Promise<void> {
  registry.trim(); await persist();
  for (const o of await rpc<{ jobId: string; attempt: number; updatedAt: number }[]>('ENGINE_ORPHANS')) if (Date.now() - o.updatedAt > 86400000) await rpc('ENGINE_CLEAN', o).catch(() => {});
  await pruneHistory();
}
async function command(value: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (!uiSender(sender, chrome.runtime.id)) fail('INVALID_REQUEST');
  const request = validateEnvelope(value), p = request.payload;
  await ensure();
  if (request.type === 'GET_SETTINGS') return readSettings();
  if (request.type === 'GET_STORAGE_USAGE') { const usage = await rpc<object>('ENGINE_USAGE'); return { ...usage, affectedJobIds: (await store.listRecoverable()).map(j => j.id) }; }
  if (request.type === 'GET_TAB_MEDIA') {
    const tabId = p.tabId as number, tab = await chrome.tabs.get(tabId), origin = tab.url && /^https?:/.test(tab.url) ? new URL(tab.url).origin : undefined;
    registry.trim();
    const entries = registry.entries.filter(e => e.candidate.tabId === tabId);
    for (const e of entries.filter(e => e.error === 'PERMISSION_REQUIRED')) scheduleProbe(() => inspect(e.candidate.id));
    const granted = origin && await chrome.permissions.contains({ origins: [originPattern(origin)] });
    const settings = (await readSettings()).settings;
    return { revision: registry.revision, candidates: entries.map(e => e.candidate), requiredOrigins: [...new Set(entries.flatMap(e => e.requiredOrigins))], discoveryState: !granted ? 'permission_required' : !discoveryAllowed(settings, origin ? new URL(origin).hostname : '') ? 'empty' : entries.length ? 'ready' : 'play_required', origin, enabled: settings.discoveryEnabled, siteEnabled: origin ? settings.siteDiscovery[new URL(origin).hostname] !== false : false };
  }
  if (request.type === 'GET_JOBS') {
    const jobs = (await all<JobSnapshot>(db, 'jobs')).filter(j => p.filter === 'all' || p.filter === 'active' && (jobActive(j) || j.state === 'paused') || p.filter === 'completed' && j.state.startsWith('completed') || p.filter === 'errors' && ['failed', 'interrupted'].includes(j.state)).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    const start = p.cursor ? jobs.findIndex(j => j.id === p.cursor) + 1 : 0, page = jobs.slice(start, start + (p.limit as number ?? 100));
    return { revision: Math.max(0, ...jobs.map(j => j.updatedAt)), jobs: await Promise.all(page.map(view)), ...(jobs.length > start + page.length ? { nextCursor: page.at(-1)?.id } : {}) };
  }
  if (request.type === 'CREATE_JOB') {
    const hash = await fingerprint(p), existing = await get<{ fingerprint: string; jobId: string }>(db, 'commandReceipts', request.requestId);
    if (existing) { if (existing.fingerprint !== hash) fail('INVALID_REQUEST'); const job = await store.readJob(existing.jobId); if (!job) fail('INVALID_STATE'); return { job: await view(job) }; }
    const entry = registry.find(p.candidateId as string), candidate = entry.candidate;
    if (candidate.revision !== p.expectedCandidateRevision || candidate.support !== 'supported') fail('INVALID_STATE');
    const selection = validateSelection(p.selection), output = object(p.output), settings = (await readSettings()).settings;
    if (selection.variantId && !candidate.variants.some(v => v.id === selection.variantId) || selection.audioTrackId && !candidate.audioTracks.some(t => t.id === selection.audioTrackId) || selection.subtitleTrackIds.some(id => !candidate.subtitleTracks.some(t => t.id === id))) fail('INVALID_REQUEST');
    await allowedSource(entry.source);
    // Real engine plan validation precedes durable admission; no fake compatible container.
    const plan = await rpc<DownloadPlan>('ENGINE_PLAN', { source: await allowedSource(entry.source), selection });
    await store.putPlan(plan);
    const job: JobSnapshot = { schemaVersion: 1, id: crypto.randomUUID(), requestId: request.requestId, candidateId: candidate.id, state: 'queued', selection, outputName: output.name as string, createdAt: Date.now(), updatedAt: Date.now(), bytesWritten: 0, attempt: 1, revision: 0, runEpoch: 1, capabilities: { pause: false, resume: false }, warnings: [], outputs: [], ...(p.liveLimits ? { liveLimits: p.liveLimits } : {} ) };
    const saved = await store.createJob(job, hash);
    await put(db, 'exports', { id: `context:${saved.id}`, title: candidate.title, domain: new URL(candidate.sourceOrigin).hostname, sourceRef: candidate.sourceRef, relativeDirectory: output.relativeDirectory, saveAs: output.saveAs, isLive: candidate.isLive, planId: plan.id, settingsSnapshot: settings });
    const sources = await jobSources(); sources[saved.id] = entry.source; await chrome.storage.session.set({ jobSources: sources });
    void pump(); await changed(saved.id); return { job: await view(saved) };
  }
  const hash = await fingerprint({ type: request.type, payload: p }), oldReply = await receipt(db, request.requestId, hash); if (oldReply !== undefined) return oldReply;
  await reserve(db, request.requestId, hash);
  let result: unknown;
  if (request.type === 'UPDATE_SETTINGS' || request.type === 'RESET_SETTINGS') { result = await writeSettings(p.expectedRevision as number, request.type === 'RESET_SETTINGS' ? structuredClone(DEFAULT_SETTINGS) : p.settings); await pruneHistory(); void pump(); }
  else if (request.type === 'CLEAR_TEMP') {
    const ids = p.jobIds as string[];
    for (const id of ids) { const job = await store.readJob(id); if (job && jobActive(job) && job.state !== 'queued') fail('INVALID_STATE'); }
    for (const id of ids) { const job = await store.readJob(id); if (job) { if (job.state === 'paused') await rpc('ENGINE_CANCEL', { jobId: id, runEpoch: job.runEpoch }); await rpc('ENGINE_CLEAN', { jobId: id, attempt: job.attempt }); if (['queued', 'paused', 'interrupted'].includes(job.state)) await mutate(db, id, j => ({ ...j, state: 'cancelled', capabilities: { pause: false, resume: false } })); } }
    result = { removedJobIds: ids };
  } else if (request.type === 'EXPORT_DIAGNOSTICS') {
    if (p.preview) {
      const jobs = await all<JobSnapshot>(db, 'jobs'), previewId = crypto.randomUUID();
      const redactedText = JSON.stringify({ schemaVersion: 1, extensionVersion: chrome.runtime.getManifest().version, jobs: jobs.map(j => ({ id: j.id, state: j.state, attempt: j.attempt, bytes: j.bytesWritten, errorCode: j.error?.code, warnings: j.warnings.map(w => w.code) })) }, null, 2);
      await chrome.storage.session.set({ diagnosticsPreview: { previewId, redactedText, expires: Date.now() + 300000 } }); result = { previewId, redactedText };
    } else { const preview = (await chrome.storage.session.get('diagnosticsPreview')).diagnosticsPreview as { previewId: string; expires: number; redactedText: string } | undefined; if (!preview || preview.previewId !== p.approvedPreviewId || preview.expires < Date.now()) fail('INVALID_REQUEST'); result = { browserDownloadId: await chrome.downloads.download({ url: `data:application/json;charset=utf-8,${encodeURIComponent(preview.redactedText)}`, filename: 'lmd-diagnostics.json', conflictAction: 'uniquify', saveAs: true }) }; }
  } else {
    const job = await store.readJob(p.jobId as string); if (!job || job.revision !== p.expectedRevision) fail('INVALID_STATE');
    if (request.type === 'PAUSE_JOB') { if (!job.capabilities.pause) fail('INVALID_STATE'); await rpc('ENGINE_PAUSE', { jobId: job.id, runEpoch: job.runEpoch }); }
    else if (request.type === 'RESUME_JOB') { if (job.state !== 'paused' || !job.capabilities.resume) fail('INVALID_STATE'); const active = (await all<JobSnapshot>(db, 'jobs')).filter(j => jobActive(j) && j.state !== 'queued').length; if (active >= (await readSettings()).settings.jobsConcurrency) fail('INVALID_STATE'); await rpc('ENGINE_RESUME', { jobId: job.id, runEpoch: job.runEpoch, checkpoint: job.checkpointRef }); }
    else if (request.type === 'STOP_LIVE_AND_SAVE') { await rpc('ENGINE_STOP_LIVE', { jobId: job.id, runEpoch: job.runEpoch }); }
    else if (request.type === 'CANCEL_JOB') {
      if (!jobActive(job) && job.state !== 'paused') fail('INVALID_STATE');
      await rpc('ENGINE_CANCEL', { jobId: job.id, runEpoch: job.runEpoch });
      for (const o of job.outputs) { if (o.browserDownloadId !== undefined) await chrome.downloads.cancel(o.browserDownloadId).catch(() => {}); await rpc('HOST_REVOKE', { jobId: job.id, attempt: job.attempt, part: o.part }); }
      const latest = await store.readJob(job.id); if (latest && latest.state !== 'cancelled') await mutate(db, job.id, j => ({ ...j, state: 'cancelled', capabilities: { pause: false, resume: false } }));
      await rpc('ENGINE_CLEAN', { jobId: job.id, attempt: job.attempt }).catch(() => {});
    } else if (request.type === 'RETRY_JOB') {
      if (!['failed', 'interrupted'].includes(job.state) || job.outputs.some(o => o.state === 'saved')) fail('INVALID_STATE');
      const c = await context(job.id), source = (await jobSources())[job.id]; if (!source) fail('URL_EXPIRED'); await allowedSource(source);
      await rpc('ENGINE_CLEAN', { jobId: job.id, attempt: job.attempt });
      if (c.planId) { const tx = db.transaction('plans', 'readwrite'), done = finish(tx); tx.objectStore('plans').delete(c.planId); await done; }
      delete c.planId; await put(db, 'exports', c);
      await mutate(db, job.id, j => { const next = { ...j, state: 'queued' as const, runEpoch: j.runEpoch + 1, attempt: j.attempt + 1, outputs: [], warnings: [], bytesWritten: 0, capabilities: { pause: false, resume: false } }; delete next.error; delete next.checkpointRef; delete next.browserDownloadId; return next; });
    } else fail('INVALID_REQUEST');
    const latest = await store.readJob(job.id); result = { job: latest && await view(latest) }; await changed(job.id); await recordHistory(job.id); void pump();
  }
  await put(db, 'commandReceipts', { requestId: request.requestId, fingerprint: hash, data: result, time: Date.now(), ...(typeof p.jobId === 'string' ? { jobId: p.jobId } : {}) }); return result;
}
chrome.runtime.onMessage.addListener((value, sender, reply) => {
  if (value?.target === 'engine-host') return false;
  if (value?.target === 'coordinator') {
    try { validateHostSender(sender, chrome.runtime.id, hostUrl); } catch { return false; }
    void ensure().then(() => onEngineEvent(value.payload)).then(() => reply({ ok: true }), () => reply({ ok: false })); return true;
  }
  if (value?.type === 'CONTENT_HELLO' || value?.type === 'DISCOVERY_HINT') {
    void (async () => {
      await ensure();
      if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined || sender.frameId === undefined || !sender.documentId || !sender.url || !/^https?:/.test(sender.url)) fail('INVALID_REQUEST');
      if (!await chrome.permissions.contains({ origins: [originPattern(new URL(sender.url).origin)] })) fail('PERMISSION_REQUIRED');
      const binding = await bindingFor(sender.tab.id, sender.frameId, sender.documentId);
      if (value.type === 'CONTENT_HELLO') return { binding: { documentKey: binding.documentKey, generation: binding.generation } };
      validateHintBinding(sender, binding, value.payload);
      if (JSON.stringify(value).length > 18000) fail('INVALID_REQUEST');
      const rate = hintRates.get(binding.documentKey) ?? { start: Date.now(), count: 0 };
      if (Date.now() - rate.start > 60000) { rate.start = Date.now(); rate.count = 0; }
      if (++rate.count > 100) fail('INVALID_REQUEST'); hintRates.set(binding.documentKey, rate);
      if (hintRates.size > 1000) hintRates.delete(hintRates.keys().next().value!);
      const p = value.payload;
      // Content hints are accepted only from the current installed isolated script.
      if (p.url.startsWith('blob:')) return {};
      await discover(binding, p.url, p.title ?? sender.tab.title ?? 'Медиа', p.mime ?? ''); return {};
    })().then(data => reply({ ok: true, data }), error => reply({ ok: false, error: safeError(error) })); return true;
  }
  void exclusive(() => command(value, sender)).then(data => reply({ version: 1, requestId: value?.requestId, ok: true, data }), error => reply({ version: 1, requestId: value?.requestId, ok: false, error: safeError(error) })); return true;
});
chrome.runtime.onConnect.addListener(port => { if (port.name !== 'lmd-events' || !port.sender || !uiSender(port.sender, chrome.runtime.id)) { port.disconnect(); return; } ports.add(port); port.onDisconnect.addListener(() => ports.delete(port)); });
const syncWebRequests = watchRequests({ before: details => {
  if (details.tabId < 0 || ['main_frame', 'sub_frame'].includes(details.type)) return;
  const binding = registry.bindings.find(b => b.tabId === details.tabId && b.frameId === details.frameId && (!details.documentId || b.documentId === details.documentId));
  if (binding) requestBindings.set(details.requestId, binding);
  if (requestBindings.size > 2000) requestBindings.delete(requestBindings.keys().next().value!);
}, completed: d => { requestBindings.delete(d.requestId); }, error: d => { requestBindings.delete(d.requestId); }, headers: details => {
  if (details.tabId < 0 || ['main_frame', 'sub_frame'].includes(details.type) || details.statusCode < 200 || details.statusCode >= 300) return;
  const mime = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-type')?.value ?? '';
  if (!isMedia(details.url, mime)) return;
  const binding = requestBindings.get(details.requestId);
  if (!binding || !registry.current(binding)) return;
  const disposition = details.responseHeaders?.find(h => h.name.toLowerCase() === 'content-disposition')?.value ?? '';
  const name = /filename="?([^";]{1,180})/i.exec(disposition)?.[1] ?? '';
  void ensure().then(async () => { if (registry.current(binding)) await discover(binding, details.url, name, mime); }).catch(() => {});
} }, () => requestBindings.clear());
void syncWebRequests();
chrome.webNavigation.onCommitted.addListener(details => { if (details.frameId < 0 || !/^https?:/.test(details.url)) return; void ensure().then(async () => { await bindingFor(details.tabId, details.frameId, details.documentId); await mediaChanged(details.tabId); }).catch(() => {}); });
chrome.webNavigation.onHistoryStateUpdated.addListener(details => { void ensure().then(async () => { registry.bind(details.tabId, details.frameId, details.documentId, new URL(details.url).origin, true); await mediaChanged(details.tabId); await chrome.tabs.sendMessage(details.tabId, { type: 'LMD_REBIND' }, { frameId: details.frameId }).catch(() => {}); }).catch(() => {}); });
chrome.tabs.onRemoved.addListener(tabId => { void ensure().then(async () => { registry.entries = registry.entries.filter(e => e.candidate.tabId !== tabId); registry.bindings = registry.bindings.filter(b => b.tabId !== tabId); await persist(); }); });
chrome.permissions.onAdded.addListener(() => { void syncWebRequests(); void ensure().then(async () => { await syncScripts(); for (const tab of await chrome.tabs.query({})) if (tab.id !== undefined && tab.url && /^https?:/.test(tab.url) && await chrome.permissions.contains({ origins: [originPattern(new URL(tab.url).origin)] })) await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content/observer.js'] }).catch(() => {}); }); });
chrome.permissions.onRemoved.addListener(() => { void syncWebRequests(); void ensure().then(async () => { await syncScripts(); for (const j of await store.listRecoverable()) { const sources = await jobSources(); try { await allowedSource(sources[j.id]); } catch { await rpc('ENGINE_CANCEL', { jobId: j.id, runEpoch: j.runEpoch }).catch(() => {}); } } registry.entries = (await Promise.all(registry.entries.map(async e => await chrome.permissions.contains({ origins: [originPattern(e.candidate.sourceOrigin)] }) ? e : undefined))).filter((e): e is NonNullable<typeof e> => !!e); await persist(); }); });
chrome.downloads.onChanged.addListener(delta => { if (delta.state) void ensure().then(() => exclusive(() => acknowledge(delta.id))).catch(() => {}); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'lmd-maintenance') void ensure().then(maintenance).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { void ensure().then(pump).catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { void ensure().then(pump).catch(() => {}); });
void exactKeys;
