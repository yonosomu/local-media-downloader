import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const evidence = path.resolve('docs/evidence/t_d2d10038');
const hash = async file => { const h = createHash('sha256'); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest('hex'); };
const component = JSON.parse(await readFile(path.join(evidence, 'component-results.json'), 'utf8'));
const large = JSON.parse(await readFile(path.join(evidence, 'large-engine-results.json'), 'utf8'));
assert(component.every(c => c.status === 'passed'));
assert.equal(large.length, 8); assert(large.every(c => c.status === 'passed'));
const browsers = ['chrome', 'brave'];
assert.deepEqual([...new Set(component.map(c => c.browser))].sort(), ['brave', 'chrome']);
assert.deepEqual(component.filter(c => c.browser === 'chrome').map(c => c.id).sort(), component.filter(c => c.browser === 'brave').map(c => c.id).sort());
for (const browser of browsers) {
  const cases = component.filter(c => c.browser === browser);
  assert(cases.find(c => c.id === 'store-CAS-dedupe-epoch').actual.diskOrphansFound);
  assert(cases.find(c => c.id === 'dash-live-duration-limit'));
  for (const size of [256, 2048]) for (const mode of ['direct', 'segmented']) assert(large.some(c => c.browser === browser && c.sizeMiB === size && c.mode === mode));
}
const files = [];
for (const c of component) for (const file of c.files ?? []) {
  const actual = await hash(file.output);
  if (file.sha256) assert.equal(actual, file.sha256, file.output);
  files.push({ browser: c.browser, case: c.id, path: path.relative(process.cwd(), file.output), sha256: actual });
}
const sourceHashes = {};
const walk = async dir => { for (const entry of await readdir(dir, { withFileTypes: true })) { const p = path.join(dir, entry.name); if (entry.isDirectory()) await walk(p); else sourceHashes[p] = await hash(p); } };
await walk('src');
const summary = {
  scope: 'Engine component, not final extension or full AT acceptance',
  generatedAt: new Date().toISOString(),
  environment: {
    macOS: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
    node: process.version,
    chrome: execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', '/Applications/Google Chrome.app/Contents/Info.plist'], { encoding: 'utf8' }).trim(),
    brave: execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', '/Applications/Brave Browser.app/Contents/Info.plist'], { encoding: 'utf8' }).trim(),
    chromium: [...new Set(large.map(c => c.version))],
    browserMode: 'isolated headless installed Chrome/Brave; default protections, no disable-Shields or unlimitedStorage',
  },
  sourceHashes,
  component: { passed: component.length, byBrowser: Object.fromEntries(browsers.map(b => [b, component.filter(c => c.browser === b).length])), verifiedFiles: files },
  large: large.map(({ browser, mode, sizeMiB, bytes, sha256, duration, heapDelta, wholeBrowserRssDelta, retained }) => ({ browser, mode, sizeMiB, bytes, sha256, duration, heapDelta, wholeBrowserRssDelta, retained })),
  limitations: ['No product SW/offscreen/Downloads lifecycle tested here', 'No 15-minute wall-time live acceptance', 'No visual/audio marker or real-player acceptance', 'JS heap and whole-browser RSS are NOT complete extension-context memory attribution', 'Large outputs verified then removed to respect disk budget; small files retained', 'Opaque browser redirects fail closed; no redirect access bypass', 'Reference parity and authenticated real site not verified'],
};
await writeFile(path.join(evidence, 'engine-summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ componentPassed: summary.component.passed, byBrowser: summary.component.byBrowser, verifiedFiles: files.length, largePassed: large.length, environment: summary.environment, large: summary.large }, null, 2));
