import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
const directory = 'docs/evidence/t_8590b0cf';
const run = process.env.LMD_KEYBOARD_RUN ?? 'run123';
assert.match(run, /^run[0-9]+(?:-[a-z0-9-]+)?$/);
const json = async name => JSON.parse(await readFile(`${directory}/${name}`, 'utf8'));
const [prior, baseline, current, browser, keyboard, native] = await Promise.all([
  json('run121-requirements.json'), json('run121-browser-summary.json'), json(`${run}-browser-summary.json`),
  json(`${run}-browser-results.json`), json(`${run}-keyboard.json`), json('native-chrome-reload-20261111.json')
]);
const counts = entries => Object.fromEntries(['passed','failed','skipped','blocked'].map(status => [status,entries.filter(r => r.status === status).length]));
assert.equal(keyboard.results.length, new Set(keyboard.results.map(r => `${r.browser}:${r.id}`)).size);
assert.equal(counts(keyboard.results).failed, 0);
assert.equal(counts(browser.results).failed, 0);
for (const name of ['chrome','brave']) {
  for (const id of ['options-keyboard-space-save-focus','popup-header-focus-survives-space-update','popup-action-focus-survives-metadata','manager-action-focus-survives-refresh','manager-DOM-select-filter-and-keyboard-refresh-space','page-errors-and-no-hosts']) {
    assert(keyboard.results.some(r => r.browser === name && r.id === id && r.status === 'passed'), `${name}:${id}`);
  }
}
const changed = (before, after) => after.filter(f => !before.some(b => b.path === f.path && b.sha256 === f.sha256)).map(f => f.path);
assert.equal(native.before.id, native.after.id);
assert.deepEqual(native.before.configuration, native.after.configuration);
const matrix = prior.matrix.map(row => {
  for (const id of row.relatedPassedComponentTests) for (const name of ['chrome','brave']) assert(browser.results.some(r => r.browser === name && r.id === id && r.status === 'passed'));
  const evidence = [`${directory}/${run}-browser-results.json`, `${directory}/${run}-browser-summary.json`, 'docs/evidence/t_ab1783c7/HANDOFF.md'];
  if (row.id === 'SPEC-07' || row.id.startsWith('FR-03') || row.id.startsWith('FR-10')) evidence.push(`${directory}/${run}-keyboard.json`);
  return {...row,evidence,additionalCheck: row.status === 'blocked_native_acceptance' ? `Operator protocol ${directory}/RUN123-REPORT.md and INSTALL.md on actual current dist; old Chrome idle Reload is historical run121 only.` : `${row.additionalCheck} Keyboard additions are bounded; native select, VoiceOver/full a11y and full product scenario remain unverified.`};
});
assert.equal(matrix.length, prior.count);
assert.equal(matrix.length, new Set(matrix.map(r => r.id)).size);
const report = {
  taskId:'t_8590b0cf',run,generatedAt:new Date().toISOString(),scope:'Residual B evidence inventory; no global FR/AT promotion and no product/native certification',
  count:matrix.length,countsByStatus:Object.fromEntries([...new Set(matrix.map(r=>r.status))].map(status=>[status,matrix.filter(r=>r.status===status).length])),
  keyboardCounts:counts(keyboard.results),keyboardByBrowser:Object.fromEntries(['chrome','brave'].map(name=>[name,counts(keyboard.results.filter(r=>r.browser===name))])),
  browserCounts:current.counts,buildDigest:current.buildDigest,
  changedSourceSince121:changed(baseline.sourceFiles,current.sourceFiles),changedDistSince121:changed(baseline.distFiles,current.distFiles),
  nativeEvidenceApplicability:{file:'native-chrome-reload-20261111.json',historicalIdleReloadConfirmed:true,beforeAfterId:native.after.id,configurationUnchanged:true,matchingPreviouslyCheckedFiles:native.checkedSourceDistFiles.filter(f=>[...current.sourceFiles,...current.distFiles].some(c=>c.path===f.path && c.sha256===f.sha256)).length,previouslyCheckedFiles:native.checkedSourceDistFiles.length,currentBuildNativeAccepted:false,reason:'UI source and three bundles changed; manifest/background/engine unchanged, but exact new build still requires native Reload. Chrome version also changed.'},
  nativeStatus:{chrome:'blocked_remaining_operator_scenarios',brave:'blocked_native_install_and_remaining_scenarios'},matrix
};
await writeFile(`${directory}/${run}-requirements.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,matrix:undefined},null,2));
