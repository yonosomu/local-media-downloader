import type { AuthorizedFetcher, AuthorizedSource, ResourceIdentity } from '../shared/contracts';
import { EngineError, fail } from '../shared/errors';
import { mediaUrl } from '../core/security';
export class Semaphore {
  private active = 0;
  private waiting: { resolve: (release: () => void) => void; reject: (reason: unknown) => void; signal: AbortSignal; abort: () => void }[] = [];
  constructor(private maximum: number) { if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16) fail('INVALID_REQUEST'); }
  reduce(): void { this.maximum = Math.max(1, Math.floor(this.maximum / 2)); }
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active < this.maximum) { this.active++; return this.releaseOnce(); }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, abort: () => { this.waiting = this.waiting.filter(x => x !== entry); reject(signal.reason); } };
      this.waiting.push(entry); signal.addEventListener('abort', entry.abort, { once: true });
    });
  }
  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return; released = true;
      this.active--;
      const entry = this.active < this.maximum ? this.waiting.shift() : undefined;
      if (entry) { this.active++; entry.signal.removeEventListener('abort', entry.abort); entry.resolve(this.releaseOnce()); }
    };
  }
}
export async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
export function authorizeUrl(source: AuthorizedSource, value: string, base?: string): string {
  let url: URL;
  try { url = new URL(value, base); } catch { return fail('INVALID_MANIFEST'); }
  const exact = mediaUrl(url.href, undefined, source.localModeOrigins.includes(url.origin));
  if (!source.allowedOrigins.includes(url.origin)) fail('PERMISSION_REQUIRED');
  return exact;
}
export function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const n = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(n) ? Math.max(0, n) : undefined;
}
export interface FetchOptions { concurrency?: number; retries?: number; firstByteTimeoutMs?: number; stallTimeoutMs?: number; redirects?: number; fetch?: typeof fetch; random?: () => number }
/** One instance per host: its slots remain held until response body close/cancel. */
export function createAuthorizedFetcher(options: FetchOptions = {}): AuthorizedFetcher {
  const slots = new Semaphore(options.concurrency ?? 16), transport = options.fetch ?? globalThis.fetch;
  return { async request(source, value, { signal, range, identity, policy }) {
    const firstByte = policy?.firstByteTimeoutMs ?? options.firstByteTimeoutMs ?? 30000, stall = policy?.stallTimeoutMs ?? options.stallTimeoutMs ?? 60000, retries = policy?.retries ?? options.retries ?? 3;
    if (!Number.isSafeInteger(retries) || retries < 0 || retries > 10 || !Number.isSafeInteger(firstByte) || firstByte < 1 || firstByte > 300000 || !Number.isSafeInteger(stall) || stall < 1 || stall > 600000) fail('INVALID_REQUEST');
    let url = authorizeUrl(source, value);
    if (range && (!Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length) || range.offset < 0 || range.length < 1 || !Number.isSafeInteger(range.offset + range.length))) fail('INVALID_REQUEST');
    let redirects = 0;
    for (let attempt = 0; ; attempt++) {
      const release = await slots.acquire(signal), controller = new AbortController();
      const abort = () => controller.abort(signal.reason); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => { timedOut = true; controller.abort(); }, firstByte);
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); release(); };
      let response: Response;
      try {
        const headers = new Headers();
        if (range) { headers.set('Range', `bytes=${range.offset}-${range.offset + range.length - 1}`); if (identity?.etag && !identity.etag.startsWith('W/')) headers.set('If-Range', identity.etag); else if (identity?.lastModified) headers.set('If-Range', identity.lastModified); }
        response = await transport(url, { headers, credentials: 'include', redirect: 'manual', signal: controller.signal, cache: 'no-store' });
        clearTimeout(timer);
      } catch {
        finish(); signal.throwIfAborted();
        if (attempt >= retries) throw new EngineError(timedOut ? 'NETWORK_TIMEOUT' : 'NETWORK_OFFLINE', true);
        await abortableDelay(Math.min(30000, 1000 * 2 ** attempt) * (0.5 + (options.random ?? Math.random)()), signal); continue;
      }
      if (response.type === 'opaqueredirect' || response.type === 'opaque') { await response.body?.cancel(); finish(); fail('PERMISSION_REQUIRED'); }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location'); await response.body?.cancel(); finish();
        if (!location || ++redirects > (options.redirects ?? 10)) fail('MANIFEST_LIMIT');
        url = authorizeUrl(source, location, url); attempt--; continue;
      }
      if (response.url && response.url !== url) { await response.body?.cancel(); finish(); fail('PERMISSION_REQUIRED'); }
      if (response.status === 429 || response.status >= 500) {
        if (response.status === 429) slots.reduce();
        const wait = retryAfter(response.headers.get('retry-after')) ?? Math.min(30000, 1000 * 2 ** attempt) * (0.5 + (options.random ?? Math.random)());
        await response.body?.cancel(); finish();
        if (attempt >= retries) throw new EngineError(response.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR', true);
        // Do not overflow native timers or turn a server's hours/days-long
        // Retry-After into an early retry. Hand control back for manual retry.
        if (wait > 300000) throw new EngineError(response.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR', true);
        // Honor long Retry-After rather than retry early; abort remains available.
        await abortableDelay(Math.max(wait, response.status === 429 ? 1000 : 0), signal); continue;
      }
      try {
        if (response.status === 401) fail('AUTH_REQUIRED');
        if (response.status === 403) fail('URL_EXPIRED');
        if (response.status === 404 || response.status === 410) fail('SEGMENT_MISSING');
        if (!response.ok) fail('HTTP_ERROR');
        if (range) {
          if (response.status !== 206) fail('RESOURCE_CHANGED');
          const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(response.headers.get('content-range') ?? '');
          if (!match || Number(match[1]) !== range.offset || Number(match[2]) !== range.offset + range.length - 1 || (match[3] !== '*' && Number(match[3]) <= Number(match[2]))) fail('RESOURCE_CHANGED');
        } else if (response.status === 206) fail('RESOURCE_CHANGED');
        verifyIdentity(identity, response.headers);
        if (/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') ?? '')) fail('AUTH_REQUIRED');
      } catch (error) { await response.body?.cancel(); finish(); throw error; }
      if (!response.body) { finish(); fail('HTTP_ERROR'); }
      const reader = response.body.getReader(); let bytes = 0, done = false, firstRead = true;
      const contentLength = response.headers.get('content-length');
      const expected = range?.length ?? (contentLength && /^\d+$/.test(contentLength) ? Number(contentLength) : undefined);
      const close = () => { if (!done) { done = true; finish(); } };
      // Abort must release the lease even when the consumer has stopped pulling.
      // An aborted transport can already have errored the reader: cancel then
      // rejects too. The consumer receives the original failure via pull();
      // settle both cancellation outcomes without an unhandled rejection.
      const onAbort = () => { void reader.cancel().then(close, close); }; controller.signal.addEventListener('abort', onAbort, { once: true });
      const stream = new ReadableStream<Uint8Array>({
        async pull(sink) {
          try {
            if (controller.signal.aborted) throw timedOut ? new EngineError('NETWORK_TIMEOUT', true) : controller.signal.reason;
            timer = setTimeout(() => { timedOut = true; controller.abort(new EngineError('NETWORK_TIMEOUT', true)); }, firstRead ? firstByte : stall);
            const chunk = await reader.read(); clearTimeout(timer); firstRead = false;
            if (controller.signal.aborted) throw timedOut ? new EngineError('NETWORK_TIMEOUT', true) : controller.signal.reason;
            if (chunk.done) { if (expected !== undefined && bytes !== expected) fail('RESOURCE_CHANGED'); sink.close(); controller.signal.removeEventListener('abort', onAbort); close(); }
            else { bytes += chunk.value.byteLength; if (expected !== undefined && bytes > expected) fail('RESOURCE_CHANGED'); sink.enqueue(chunk.value); }
          } catch (error) { sink.error(error instanceof EngineError || signal.aborted ? error : new EngineError('NETWORK_OFFLINE', true)); await reader.cancel().catch(() => {}); controller.signal.removeEventListener('abort', onAbort); close(); }
        },
        async cancel(reason) { controller.signal.removeEventListener('abort', onAbort); controller.abort(reason); await reader.cancel(reason).catch(() => {}); close(); },
      }, { highWaterMark: 0 });
      return new Response(stream, { status: response.status, headers: response.headers });
    }
  } };
}
export function responseIdentity(headers: Headers): ResourceIdentity {
  const length = headers.get('content-length');
  return { ...(headers.get('etag') ? { etag: headers.get('etag')! } : {}), ...(headers.get('last-modified') ? { lastModified: headers.get('last-modified')! } : {}), ...(length && /^\d+$/.test(length) && Number.isSafeInteger(Number(length)) ? { length: Number(length) } : {}) };
}
export function verifyIdentity(identity: ResourceIdentity | undefined, headers: Headers): void {
  if (identity?.etag && identity.etag !== headers.get('etag')) fail('RESOURCE_CHANGED');
  if (!identity?.etag && identity?.lastModified && identity.lastModified !== headers.get('last-modified')) fail('RESOURCE_CHANGED');
}
export async function boundedText(response: Response, limit = 8 * 1024 * 1024): Promise<string> {
  if (!response.body) fail('INVALID_MANIFEST');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, result = '';
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > limit) fail('MANIFEST_LIMIT'); result += decoder.decode(chunk.value, { stream: true }); }
    return result + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
