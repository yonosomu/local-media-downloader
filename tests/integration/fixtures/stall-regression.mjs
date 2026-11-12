import path from 'node:path';
// Не bundle-ить developer CLI entrypoints: иначе их main guard совпадёт
// с путём итогового bundle и запустит генератор/постоянный сервер.
const { startFixtureServer } = await import(path.resolve('scripts/fixtures-server.mjs'));
import { createAuthorizedFetcher } from '../../../src/engine/fetch.ts';
import { writeFile } from 'node:fs/promises';
const fixture = await startFixtureServer();
const result = { id: 'F-stall-product-regression', expected: 'NETWORK_TIMEOUT без unhandled rejection', status: 'failed', unhandled: [] };
const onUnhandled = error => result.unhandled.push({ code: error?.code ?? 'unknown' });
process.on('unhandledRejection', onUnhandled);
try {
  const source = { sourceRef: 'fixture', exactUrl: `${fixture.origins[0]}/fault/stall`, allowedOrigins: fixture.origins, localModeOrigins: fixture.origins };
  const client = createAuthorizedFetcher({ retries: 0, firstByteTimeoutMs: 100, stallTimeoutMs: 100 });
  try { await (await client.request(source, source.exactUrl, { signal: new AbortController().signal })).text(); result.consumerCode = 'NO_ERROR'; }
  catch (error) { result.consumerCode = error.code; }
  await new Promise(resolve => setTimeout(resolve, 50));
  if (result.consumerCode === 'NETWORK_TIMEOUT' && !result.unhandled.length) result.status = 'passed';
} finally {
  await fixture.close();
  process.off('unhandledRejection', onUnhandled);
}
await writeFile('docs/evidence/t_ab1783c7/stall-regression.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
process.exitCode = result.status === 'passed' ? 0 : 1;
