import type { JobSnapshot, SettingsV1 } from '../shared/contracts';
import { fail } from '../shared/errors';
export function request<T>(r: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
export function finish(tx: IDBTransaction): Promise<void> { return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error); }); }
/** Opens the engine-created schema. Never owns a competing upgrade/migration. */
export async function openDatabase(): Promise<IDBDatabase> { const r = indexedDB.open('lmd-v1', 1); r.onupgradeneeded = () => r.transaction?.abort(); return request(r); }
export async function all<T>(db: IDBDatabase, name: string): Promise<T[]> { return request(db.transaction(name).objectStore(name).getAll()); }
export async function get<T>(db: IDBDatabase, name: string, id: string): Promise<T | undefined> { return request(db.transaction(name).objectStore(name).get(id)); }
export async function put(db: IDBDatabase, name: string, data: object): Promise<void> { const tx = db.transaction(name, 'readwrite'), done = finish(tx); tx.objectStore(name).put(data); await done; }
export async function fingerprint(value: unknown): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))).map(b => b.toString(16).padStart(2, '0')).join(''); }
export async function receipt(db: IDBDatabase, requestId: string, hash: string): Promise<unknown | undefined> {
  const r = await get<{ fingerprint: string; data?: unknown; pending?: boolean }>(db, 'commandReceipts', requestId);
  if (!r) return; if (r.fingerprint !== hash || r.pending) fail('INVALID_REQUEST'); return r.data;
}
export async function reserve(db: IDBDatabase, requestId: string, hash: string): Promise<void> { await put(db, 'commandReceipts', { requestId, fingerprint: hash, pending: true, time: Date.now() }); }
export interface JobContext { id: string; title: string; domain: string; sourceRef: string; relativeDirectory: string; saveAs: boolean; isLive: boolean; planId?: string; settingsSnapshot: SettingsV1 }
export interface ExportIntent { id: string; jobId: string; attempt: number; runEpoch: number; part: number; status: 'intent' | 'started' | 'saved' | 'cancelled'; browserDownloadId?: number; filename: string }
export async function mutate(db: IDBDatabase, id: string, change: (job: JobSnapshot) => JobSnapshot): Promise<JobSnapshot> {
  const tx = db.transaction('jobs', 'readwrite'), done = finish(tx), store = tx.objectStore('jobs');
  const job = await request<JobSnapshot | undefined>(store.get(id));
  if (!job) { await done; fail('INVALID_STATE'); }
  let next: JobSnapshot;
  try { next = change(job); } catch (error) { await done; throw error; }
  next = { ...next, revision: job.revision + 1, updatedAt: Date.now() }; store.put(next); await done; return next;
}
