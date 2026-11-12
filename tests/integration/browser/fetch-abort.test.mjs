import { afterAll, expect, test } from 'vitest';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createAuthorizedFetcher } from '../../../src/engine/fetch';

// Real HTTP bodies; no replacement of reader.cancel(), fetch or AbortSignal.
const results = [];
const server = createServer((request, response) => {
  if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<title>Owned fetch regression</title>'); return; }
  response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  if (request.url === '/okay') { response.end('okay'); return; }
  response.flushHeaders();
  if (request.url === '/stall') response.write('first chunk');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const bundle = await build({ entryPoints: ['src/engine/fetch.ts'], bundle: true, write: false, format: 'iife', globalName: 'LmdFetch', platform: 'browser' });

// Shared exact assertions in Node and the two installed browser fetch stacks.
async function scenarios({ createAuthorizedFetcher, origin }) {
  const client = createAuthorizedFetcher({ concurrency: 1, retries: 0, firstByteTimeoutMs: 500, stallTimeoutMs: 100 });
  const source = { sourceRef: 'owned-fetch-regression', exactUrl: `${origin}/stall`, allowedOrigins: [origin], localModeOrigins: [origin] };
  const outcomes = [];
  for (const mode of ['first-byte-timeout', 'stall-timeout', 'abort-pulling', 'abort-idle', 'consumer-cancel']) {
    const controller = new AbortController();
    const request = url => client.request(source, url, { signal: controller.signal });
    const response = await request(`${origin}/${mode === 'first-byte-timeout' ? 'empty' : 'stall'}`);
    const reader = response.body.getReader();
    if (mode !== 'first-byte-timeout') {
      const first = await reader.read();
      if (first.done || !first.value.length) throw new Error('Missing actual first body chunk');
    }
    // Queue a second request before releasing the only lease.
    const queuedController = new AbortController();
    const queued = client.request(source, `${origin}/okay`, { signal: queuedController.signal });
    const deadline = setTimeout(() => queuedController.abort(new Error('Leaked fetch slot')), 3000);
    try {
      let code;
      if (mode === 'consumer-cancel') await reader.cancel();
      else if (mode === 'abort-idle') controller.abort(new Error('owned cancellation'));
      else {
        const pending = reader.read();
        if (mode === 'abort-pulling') controller.abort(new Error('owned cancellation'));
        try { await pending; throw new Error('Read unexpectedly succeeded'); }
        catch (error) { code = error.code ?? error.message; }
        const expected = mode === 'abort-pulling' ? 'owned cancellation' : 'NETWORK_TIMEOUT';
        if (code !== expected) throw new Error(`${mode}: expected ${expected}, received ${code}`);
      }
      const next = await queued;
      if (await next.text() !== 'okay') throw new Error('Queued response corrupted');
      // A second release must not consume the next request's lease.
      await reader.cancel().catch(() => {});
      outcomes.push({ mode, code, queuedBody: 'okay' });
    } finally { clearTimeout(deadline); queuedController.abort(); }
  }
  await new Promise(resolve => setTimeout(resolve, 100));
  return outcomes;
}

for (const [name, executablePath] of [
  ['node', undefined],
  ['chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  ['brave', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
]) {
  test(`real HTTP timeout/cancel releases leases without unhandled rejection: ${name}`, async () => {
    const errors = [], onUnhandled = error => errors.push(error?.code ?? error?.message ?? String(error));
    let browser;
    process.on('unhandledRejection', onUnhandled);
    try {
      let outcomes, version;
      if (executablePath) {
        browser = await chromium.launch({ executablePath, headless: true });
        const page = await browser.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(origin);
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        // Test-only serialization: use exactly the same assertions in each stack.
        outcomes = await page.evaluate(`(${scenarios.toString()})({ createAuthorizedFetcher: LmdFetch.createAuthorizedFetcher, origin: ${JSON.stringify(origin)} })`);
        version = browser.version();
      } else {
        outcomes = await scenarios({ createAuthorizedFetcher, origin });
        version = process.version;
      }
      expect(outcomes).toHaveLength(5);
      expect(errors).toEqual([]);
      results.push({ name, version, status: 'passed', outcomes, errors });
    } catch (error) {
      results.push({ name, status: 'failed', message: error.message, errors });
      throw error;
    } finally {
      await browser?.close();
      process.off('unhandledRejection', onUnhandled);
    }
  }, 30000);
}

afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await writeFile('docs/evidence/t_8590b0cf/run116-fetch-abort.json', JSON.stringify(results, null, 2));
});
