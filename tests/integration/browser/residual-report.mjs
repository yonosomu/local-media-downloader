import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const directory = 'docs/evidence/t_8590b0cf';
const json = async name => JSON.parse(await readFile(`${directory}/${name}`, 'utf8'));
// Same RFC4180 parsing rules as the existing fixture report; shared matrix is read-only.
function csv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === ',' || c === '\n')) { row.push(cell.replace(/\r$/, '')); cell = ''; if (c === '\n') { rows.push(row); row = []; } }
    else cell += c;
  }
  assert(!quoted); if (cell || row.length) { row.push(cell); rows.push(row); }
  const header = rows.shift();
  return rows.filter(r => r.length > 1).map(r => { assert.equal(r.length, header.length); return Object.fromEntries(header.map((key, i) => [key, r[i]])); });
}
const current = await json('run121-browser-summary.json'), previous = await json('run116-browser-summary.json');
const { results } = await json('run121-browser-results.json');
const lifecycle = await json('webrequest-startup.json');
assert.equal(lifecycle.results.length, 4); assert(lifecycle.results.every(r => r.status === 'passed'));
const rows = csv(await readFile('docs/requirements-matrix.csv', 'utf8')).filter(r => r.implementation_owner.split(';').includes('t_8590b0cf'));
assert(rows.length > 0); assert.equal(new Set(rows.map(r => r.id)).size, rows.length);
const related = {
  'FR-01': ['no-host-no-probe', 'network-HLS-discovery', 'SPA-generation-eviction', 'lazy-iframe-extensionless-MIME', 'segment-grouping-badge'],
  'FR-02': ['DOM-discovery-signature-safe-DTO', 'segment-grouping-badge'],
  'FR-03': ['UI-track-live-container-matrix', 'popup-real-selected-audio-subtitle-sidecar', 'popup-real-audio-only-m4a', 'popup-metadata-revision-preserves-edits-focus'],
  'FR-04': ['real-engine-Downloads-ack-dedupe-sha256'],
  'FR-08': ['queue-concurrency-queued-clear-active-reject-promotion-cleanup', 'pause-before-first-segment-resume-real-file-hash', 'SW-stop-reconcile-single-host-no-duplicate-export'],
  'FR-09': ['actual-action-popup-selection-close-XSS-layout', 'real-engine-Downloads-ack-dedupe-sha256'],
  'FR-10': ['settings-CAS-receipt-no-read-leak-forged-host', 'future-settings-schema-rejected-without-reset', 'browser-restart-interrupted-settings-preserved-session-cleared'],
  'FR-11': ['diagnostics-no-secrets', 'history-retention-preserves-interrupted-recovery-explicit-clear']
};
const matrix = rows.map(row => {
  const family = row.id.split('.').shift(), testIds = related[family] ?? [];
  for (const id of testIds) for (const browser of ['chrome', 'brave']) assert(results.some(r => r.id === id && r.browser === browser && r.status === 'passed'));
  const native = ['AT-01', 'AT-02', 'AT-03', 'AT-29', 'AT-32'].includes(row.id);
  return {
    id: row.id, requirement: row.requirement, status: native ? 'blocked_native_acceptance' : 'partial_not_product_verified',
    basis: 'Результаты ниже связаны с критерием, но не доказывают все его подпункты. Нет автоматического переноса component passed в product verified.',
    evidence: [`${directory}/run121-browser-results.json`, `${directory}/run121-browser-summary.json`, 'docs/evidence/t_ab1783c7/HANDOFF.md'],
    relatedPassedComponentTests: testIds,
    additionalCheck: native ? 'Операторский проход actual dist run121 по RUN121-REPORT.md/INSTALL.md в двух браузерах.' : `В I проверить точный сценарий ${row.test_ids} на actual dist с входами F; отдельно подтвердить требование: ${row.requirement}`
  };
});
const changed = (before, after) => after.filter(file => !before.some(old => old.path === file.path && old.sha256 === file.sha256)).map(file => file.path);
const report = { taskId: 't_8590b0cf', run: 121, generatedAt: new Date().toISOString(), scope: 'Полная инвентаризация строк с implementation_owner B; не новая продуктовая сертификация', count: matrix.length, countsByStatus: Object.fromEntries([...new Set(matrix.map(r => r.status))].map(status => [status, matrix.filter(r => r.status === status).length])), changedSourceSince116: changed(previous.sourceFiles, current.sourceFiles), changedDistSince116: changed(previous.distFiles, current.distFiles), buildDigest: current.buildDigest, matrix };
await writeFile(`${directory}/run121-requirements.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ count: report.count, countsByStatus: report.countsByStatus, changedSourceSince116: report.changedSourceSince116, changedDistSince116: report.changedDistSince116, buildDigest: report.buildDigest }, null, 2));
