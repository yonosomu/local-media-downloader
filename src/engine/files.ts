import { EngineError, fail } from '../shared/errors';
export function pathPieces(path: string): string[] {
  const pieces = path.split('/');
  if (pieces.length > 16 || pieces.some(x => !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,179}$/.test(x) || x.includes('..'))) fail('INVALID_REQUEST');
  return pieces;
}
export function jobDirectory(jobId: string, attempt: number): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1) fail('INVALID_REQUEST');
  pathPieces(jobId); if (jobId.includes('/')) fail('INVALID_REQUEST');
  return `jobs/${jobId}/attempt-${attempt}`;
}
export class OpfsFiles {
  constructor(private readonly root: FileSystemDirectoryHandle) {}
  static async open(): Promise<OpfsFiles> {
    if (!globalThis.navigator?.storage?.getDirectory) fail('BROWSER_UNSUPPORTED');
    return new OpfsFiles(await navigator.storage.getDirectory());
  }
  private async parent(path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
    const pieces = pathPieces(path); let dir = this.root;
    for (const part of pieces.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create });
    return { dir, name: pieces.at(-1)! };
  }
  async handle(path: string, create = false): Promise<FileSystemFileHandle> { const { dir, name } = await this.parent(path, create); return dir.getFileHandle(name, { create }); }
  async read(path: string): Promise<File> { return (await this.handle(path)).getFile(); }
  async remove(path: string): Promise<void> {
    const { dir, name } = await this.parent(path, false).catch(error => { if (error instanceof DOMException && error.name === 'NotFoundError') return { dir: this.root, name: '' }; throw error; });
    if (name) await dir.removeEntry(name, { recursive: true }).catch(error => { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; });
  }
  /** Streaming write; close is the durable boundary. Failed writes never produce checkpoints. */
  async write(path: string, body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<number> {
    const reader = body.getReader(); let bytes = 0, stream: FileSystemWritableFileStream | undefined;
    const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      try { stream = await (await this.handle(path, true)).createWritable(); }
      catch (error) { throw new EngineError(error instanceof DOMException && error.name === 'QuotaExceededError' ? 'QUOTA_EXCEEDED' : 'DISK_WRITE_FAILED'); }
      while (true) {
        const chunk = await reader.read(); signal.throwIfAborted(); if (chunk.done) break;
        try { await stream.write(chunk.value as Uint8Array<ArrayBuffer>); }
        catch (error) { throw new EngineError(error instanceof DOMException && error.name === 'QuotaExceededError' ? 'QUOTA_EXCEEDED' : 'DISK_WRITE_FAILED'); }
        bytes += chunk.value.byteLength;
      }
      try { await stream.close(); }
      catch (error) { throw new EngineError(error instanceof DOMException && error.name === 'QuotaExceededError' ? 'QUOTA_EXCEEDED' : 'DISK_WRITE_FAILED'); }
      return bytes;
    } catch (error) { await stream?.abort().catch(() => {}); await this.remove(path).catch(() => {}); throw error; }
    finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async verify(path: string, length: number): Promise<boolean> { try { return (await this.read(path)).size === length; } catch { return false; } }
  /** Include crash leftovers written before the first checkpoint transaction.
   * Only enumerate our jobs namespace; never touch exported user files. */
  async listAttempts(): Promise<{ jobId: string; attempt: number; updatedAt: number }[]> {
    const jobs = await this.root.getDirectoryHandle('jobs').catch(error => { if (error instanceof DOMException && error.name === 'NotFoundError') return undefined; throw error; });
    if (!jobs) return [];
    const modified = async (dir: FileSystemDirectoryHandle): Promise<number> => {
      let latest = 0;
      for await (const entry of dir.values()) latest = Math.max(latest, entry.kind === 'file' ? (await (entry as FileSystemFileHandle).getFile()).lastModified : await modified(entry as FileSystemDirectoryHandle));
      return latest;
    };
    const result = [];
    for await (const [jobId, job] of jobs.entries()) {
      if (job.kind !== 'directory') continue;
      for await (const [name, dir] of (job as FileSystemDirectoryHandle).entries()) {
        const match = /^attempt-([1-9]\d*)$/.exec(name);
        if (dir.kind !== 'directory' || !match || !Number.isSafeInteger(Number(match[1]))) continue;
        jobDirectory(jobId, Number(match[1]));
        result.push({ jobId, attempt: Number(match[1]), updatedAt: await modified(dir as FileSystemDirectoryHandle) });
      }
    }
    return result;
  }
  /** Advisory only: privacy-preserving browsers may report a fixed quota.
   * Actual close/write failures, not this estimate, enforce storage capacity. */
  async checkSpace(required?: number): Promise<boolean> {
    const estimate = await navigator.storage.estimate();
    return estimate.quota === undefined || estimate.usage === undefined || estimate.quota - estimate.usage >= (required ?? 16 * 1024 * 1024);
  }
}
