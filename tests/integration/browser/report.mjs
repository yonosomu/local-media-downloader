import { readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
const evidence = 'docs/evidence/t_8590b0cf';
async function hashes(directory) {
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) entries.push(...await hashes(name));
    else if (entry.isFile()) entries.push({ path: name, sha256: createHash('sha256').update(await readFile(name)).digest('hex') });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
const { results } = JSON.parse(await readFile(`${evidence}/browser-results.json`, 'utf8'));
assert(!results.some(r => r.status === 'failed'));
const counts = {};
for (const browser of ['chrome', 'brave']) {
  const cases = results.filter(r => r.browser === browser);
  assert.equal(new Set(cases.map(r => r.id)).size, cases.length);
  assert(cases.some(r => r.id === 'history-retention-preserves-interrupted-recovery-explicit-clear' && r.status === 'passed'));
  assert(cases.some(r => r.id === 'popup-metadata-revision-preserves-edits-focus' && r.status === 'passed'));
  for (const id of ['100-cards-100-action-popup-cycles', 'negative-sender-schema-source-permission-no-fetch', 'manager-all-states-errors-capabilities-output-filters', 'pause-before-first-segment-resume-real-file-hash', 'popup-real-selected-audio-subtitle-sidecar', 'popup-real-audio-only-m4a', 'popup-manager-real-short-live-stop-finalize', 'popup-manager-real-short-live-cancel-delete', 'export-object-URLs-revoked-after-completion-cancels', 'future-settings-schema-rejected-without-reset', 'queue-concurrency-queued-clear-active-reject-promotion-cleanup']) assert(cases.some(r => r.id === id && r.status === 'passed'), `${browser}: missing ${id}`);
  const perf = cases.find(r => r.id === '100-cards-100-action-popup-cycles');
  assert.equal(perf.timingsMs.length, 100); assert(perf.timingsMs.every(t => t <= 1000));
  counts[browser] = Object.fromEntries(['passed', 'failed', 'skipped', 'blocked'].map(s => [s, cases.filter(r => r.status === s).length]));
  assert.equal(Object.values(counts[browser]).reduce((a, b) => a + b, 0), cases.length);
}
assert.deepEqual(results.filter(r => r.browser === 'chrome').map(r => r.id).sort(), results.filter(r => r.browser === 'brave').map(r => r.id).sort());
const distFiles = await hashes('dist'), sourceFiles = await hashes('src');
const summary = {
  schemaVersion: 1, taskId: 't_8590b0cf', generatedAt: new Date().toISOString(),
  scope: 'Browser implementation checkpoint; NOT product acceptance. Native optional-host consent unverified; most execution scenarios use declared test-only required loopback permission copy, identical JS.',
  counts,
  environment: {
    node: process.version, macOS: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
    chrome: execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', '/Applications/Google Chrome.app/Contents/Info.plist'], { encoding: 'utf8' }).trim(),
    brave: execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', '/Applications/Brave Browser.app/Contents/Info.plist'], { encoding: 'utf8' }).trim(),
    chromium: results.find(r => r.browser === 'brave' && r.version)?.version,
    mode: 'Installed binaries, isolated headless profiles. Brave settings/Shields unchanged; no claim of headed site policy acceptance.'
  },
  buildDigest: createHash('sha256').update(JSON.stringify(distFiles)).digest('hex'), distFiles, sourceFiles,
  harnessFiles: await hashes('tests/integration/browser'),
  performance: results.filter(r => r.id === '100-cards-100-action-popup-cycles').map(r => ({ browser: r.browser, cycles: r.timingsMs.length, maxMs: r.maxMs, medianMs: [...r.timingsMs].sort((a, b) => a - b)[50], targetsStable: JSON.stringify(r.beforeTargets) === JSON.stringify(r.afterTargets), temporaryBytes: r.temporaryBytes })),
  outputs: await Promise.all([...new Set(results.flatMap(r => [...(r.output ? [r.output] : []), ...(r.outputs ?? [])]))].sort().map(async file => ({ path: file, sha256: createHash('sha256').update(await readFile(file)).digest('hex') }))),
  nativePermissionProbe: JSON.parse(await readFile(`${evidence}/native-permission-probe.json`, 'utf8')),
  headedNativePermissionProbe: await readFile(`${evidence}/native-permission-probe-headed.json`, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return { status: 'not_run' }; throw error; }),
  remaining: ['Native scoped host grant/denial and Save As dialogs on actual dist in isolated headed Chrome/Brave', 'Actual dist runtime.reload unavailable after CDP registration (ERR_BLOCKED_BY_CLIENT); manual Developer-mode Reload/stable ID/settings still required', 'Full fixtures, product AT matrix, 15-minute live, 2GiB product memory attribution, AV markers; downstream scope', 'UI capability/error snapshots and popup stress use explicitly injected test-only data, not media execution or native consent acceptance', 'Real authorized site and reference audit not verified']
};
await writeFile(`${evidence}/browser-summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ counts, buildDigest: summary.buildDigest, outputs: summary.outputs, remaining: summary.remaining }, null, 2));
