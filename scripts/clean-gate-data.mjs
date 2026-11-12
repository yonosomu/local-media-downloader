import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve('spikes/001-browser-gates/evidence');
const scratch = '/Users/philiprichard/.hermes/cache/scratch/';
const report = JSON.parse(await readFile(path.join(root, 'browser-results-large.json'), 'utf8'));
for (const record of report) {
  if (record.profile?.startsWith(`${scratch}lmd-gate-`)) {
    await rm(record.profile, { recursive: true, force: true });
    record.profileCleaned = true;
  }
  if (record.output?.startsWith(`${scratch}lmd-export-`) && record.browser === 'brave') {
    await rm(record.output, { force: true });
    record.outputCleaned = true;
  }
}
await writeFile(path.join(root, 'browser-results-large.json'), JSON.stringify(report, null, 2));
console.log('Removed only disposable profiles and Brave binary outputs listed in large-gate evidence; Chrome exports retained.');
