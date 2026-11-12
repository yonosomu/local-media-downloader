import type { CheckpointV1, DownloadPlan, EngineStore, JobSnapshot, RunLease, EngineSnapshot } from '../shared/contracts';
import { fail } from '../shared/errors';
import { jobDirectory, OpfsFiles } from './files';
const STORES = ['jobs', 'plans', 'checkpoints', 'commandReceipts', 'exports', 'leases', 'history'];
function request<T>(req: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
function finished(tx: IDBTransaction): Promise<void> { return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('IDB_ABORT')); }); }
export function checkpointRef(jobId: string, attempt: number): string { jobDirectory(jobId, attempt); return `${jobId}:${attempt}`; }
function assertNoUrls(value: unknown): void {
  if (typeof value === 'string' && /(?:https?:|blob:|data:|Bearer\s)/i.test(value)) fail('INVALID_REQUEST');
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { if (['exacturl', 'url', 'authorization', 'cookie'].includes(key.toLowerCase())) fail('INVALID_REQUEST'); assertNoUrls(item); }
}
export class IndexedDbEngineStore implements EngineStore {
  private constructor(private readonly db: IDBDatabase, private readonly files: OpfsFiles) {}
  static async open(files: OpfsFiles, name = 'lmd-v1'): Promise<IndexedDbEngineStore> {
    if (!globalThis.indexedDB) fail('BROWSER_UNSUPPORTED');
    const opening = indexedDB.open(name, 1);
    opening.onupgradeneeded = () => {
      const db = opening.result;
      for (const name of STORES) {
        const store = db.createObjectStore(name, { keyPath: name === 'checkpoints' ? 'ref' : name === 'leases' ? 'jobId' : name === 'commandReceipts' ? 'requestId' : 'id' });
        if (name === 'jobs') store.createIndex('requestId', 'requestId', { unique: true });
        if (name === 'history') store.createIndex('time', 'time');
      }
    };
    const db = await request(opening); db.onversionchange = () => db.close();
    return new IndexedDbEngineStore(db, files);
  }
  close(): void { this.db.close(); }
  /** Coordinator only, after establishing the single current host and reading
   * its live snapshot. Never call using a stale snapshot or while spawning it.
   * Downloads/export intents are reconciled separately by the coordinator. */
  async reconcileHost(snapshot: EngineSnapshot): Promise<string[]> {
    const tx = this.db.transaction(['leases', 'jobs'], 'readwrite'), done = finished(tx);
    const leases = tx.objectStore('leases'), jobs = tx.objectStore('jobs');
    const existing = await request<RunLease[]>(leases.getAll()), interrupted: string[] = [];
    for (const lease of existing) {
      if (lease.hostId === snapshot.hostId && snapshot.runs.some(r => r.jobId === lease.jobId && r.attempt === lease.attempt && r.runEpoch === lease.runEpoch)) continue;
      const job = await request<JobSnapshot | undefined>(jobs.get(lease.jobId));
      leases.delete(lease.jobId);
      if (job && job.attempt === lease.attempt && job.runEpoch === lease.runEpoch && ['resolving', 'downloading', 'assembling'].includes(job.state)) {
        jobs.put({ ...job, state: 'interrupted', revision: job.revision + 1, updatedAt: Date.now(), capabilities: { pause: false, resume: false } });
        interrupted.push(job.id);
      }
    }
    await done; return interrupted;
  }
  private async get<T>(store: string, key: string): Promise<T | undefined> { return request(this.db.transaction(store).objectStore(store).get(key)); }
  private async put(store: string, value: unknown): Promise<void> { assertNoUrls(value); const tx = this.db.transaction(store, 'readwrite'), done = finished(tx); tx.objectStore(store).put(value); await done; }
  readJob(id: string): Promise<JobSnapshot | undefined> { return this.get('jobs', id); }
  async compareAndSwapJob(id: string, expectedRevision: number, next: JobSnapshot): Promise<boolean> {
    assertNoUrls(next);
    if (next.id !== id || next.revision !== expectedRevision + 1) fail('INVALID_REQUEST');
    const tx = this.db.transaction('jobs', 'readwrite'), done = finished(tx), store = tx.objectStore('jobs');
    const old = await request<JobSnapshot | undefined>(store.get(id));
    if (!old || old.revision !== expectedRevision || next.attempt < old.attempt || next.runEpoch < old.runEpoch) { await done; return false; }
    if (['completed', 'completed_with_warnings', 'cancelled'].includes(old.state)) { await done; return false; }
    store.put(next); await done; return true;
  }
  /** Coordinator admission: job and safe receipt in the same transaction. */
  async createJob(job: JobSnapshot, payloadFingerprint: string): Promise<JobSnapshot> {
    assertNoUrls(job);
    if (!/^[a-f0-9]{64}$/.test(payloadFingerprint) || job.state !== 'queued' || job.revision !== 0) fail('INVALID_REQUEST');
    const tx = this.db.transaction(['jobs', 'commandReceipts'], 'readwrite'), done = finished(tx);
    const receipt = await request<{ fingerprint: string; jobId: string } | undefined>(tx.objectStore('commandReceipts').get(job.requestId));
    if (receipt) {
      const old = await request<JobSnapshot>(tx.objectStore('jobs').get(receipt.jobId)); await done;
      if (receipt.fingerprint !== payloadFingerprint) fail('INVALID_REQUEST'); return old;
    }
    tx.objectStore('jobs').add(job); tx.objectStore('commandReceipts').add({ requestId: job.requestId, fingerprint: payloadFingerprint, jobId: job.id }); await done; return job;
  }
  putPlan(plan: DownloadPlan): Promise<void> { return this.put('plans', plan); }
  readPlan(id: string): Promise<DownloadPlan | undefined> { return this.get('plans', id); }
  async commitCheckpoint(checkpoint: CheckpointV1): Promise<void> {
    assertNoUrls(checkpoint);
    const tx = this.db.transaction(['checkpoints', 'leases', 'jobs'], 'readwrite'), done = finished(tx);
    const lease = await request<RunLease | undefined>(tx.objectStore('leases').get(checkpoint.jobId));
    const job = await request<JobSnapshot | undefined>(tx.objectStore('jobs').get(checkpoint.jobId));
    if (!lease || !job || lease.attempt !== checkpoint.attempt || lease.runEpoch !== checkpoint.runEpoch || job.attempt !== checkpoint.attempt || job.runEpoch !== checkpoint.runEpoch || ['cancelled', 'failed', 'completed', 'completed_with_warnings'].includes(job.state)) { await done; fail('INVALID_STATE'); }
    tx.objectStore('checkpoints').put({ ...checkpoint, ref: checkpointRef(checkpoint.jobId, checkpoint.attempt) }); await done;
  }
  readCheckpoint(ref: string): Promise<CheckpointV1 | undefined> { return this.get('checkpoints', ref); }
  async listRecoverable(): Promise<JobSnapshot[]> {
    const jobs = await request<JobSnapshot[]>(this.db.transaction('jobs').objectStore('jobs').getAll());
    return jobs.filter(j => !['completed', 'completed_with_warnings', 'cancelled', 'failed'].includes(j.state));
  }
  async deleteTemporary(jobId: string, attempt: number): Promise<void> {
    const lease = await this.get<RunLease>('leases', jobId); if (lease?.attempt === attempt) fail('INVALID_STATE');
    await this.files.remove(jobDirectory(jobId, attempt));
    const tx = this.db.transaction('checkpoints', 'readwrite'), done = finished(tx); tx.objectStore('checkpoints').delete(checkpointRef(jobId, attempt)); await done;
  }
  async listOrphans(): Promise<{ jobId: string; attempt: number; updatedAt: number }[]> {
    const checkpoints = await request<CheckpointV1[]>(this.db.transaction('checkpoints').objectStore('checkpoints').getAll());
    const attempts = new Map((await this.files.listAttempts()).map(a => [checkpointRef(a.jobId, a.attempt), a]));
    for (const c of checkpoints) {
      const ref = checkpointRef(c.jobId, c.attempt), disk = attempts.get(ref);
      attempts.set(ref, { jobId: c.jobId, attempt: c.attempt, updatedAt: Math.max(c.updatedAt, disk?.updatedAt ?? 0) });
    }
    const result = [];
    for (const a of attempts.values()) {
      const job = await this.readJob(a.jobId), lease = await this.get<RunLease>('leases', a.jobId);
      if (lease?.attempt === a.attempt || job?.state === 'paused' && job.attempt === a.attempt) continue;
      if (!job || job.attempt !== a.attempt || ['completed', 'completed_with_warnings', 'cancelled', 'failed'].includes(job.state)) result.push(a);
    }
    return result;
  }
  async acquireLease(lease: RunLease): Promise<boolean> {
    const tx = this.db.transaction(['leases', 'jobs'], 'readwrite'), done = finished(tx);
    const old = await request<RunLease | undefined>(tx.objectStore('leases').get(lease.jobId)), job = await request<JobSnapshot | undefined>(tx.objectStore('jobs').get(lease.jobId));
    if (old || !job || job.attempt !== lease.attempt || job.runEpoch !== lease.runEpoch || !['queued', 'resolving', 'paused', 'interrupted'].includes(job.state)) { await done; return false; }
    tx.objectStore('leases').add(lease); await done; return true;
  }
  async releaseLease(lease: RunLease): Promise<void> {
    const tx = this.db.transaction('leases', 'readwrite'), done = finished(tx), store = tx.objectStore('leases');
    const old = await request<RunLease | undefined>(store.get(lease.jobId));
    if (old?.attempt === lease.attempt && old.runEpoch === lease.runEpoch && old.hostId === lease.hostId) store.delete(lease.jobId);
    await done;
  }
}
