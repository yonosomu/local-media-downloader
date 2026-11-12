import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';

const evidence = 'docs/evidence/t_ab1783c7';
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const hash = async file => { const digest = createHash('sha256'); for await (const bytes of createReadStream(file)) digest.update(bytes); return digest.digest('hex'); };
async function inventory(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await inventory(file));
    else if (entry.isFile()) files.push({ path: file, sha256: await hash(file) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
// CSV RFC4180, включая multiline quoted SPEC sections. Общая matrix read-only.
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
const generated = await json('.test-data/fixtures-f/generated.json');
const currentFiles = await inventory('.test-data/fixtures-f/media');
assert.equal(currentFiles.length, generated.files.length);
for (const file of generated.files) assert.equal(await hash(path.join('.test-data/fixtures-f/media', file.name)), file.sha256, file.name);
const historicalGeneration = await json(`${evidence}/pre-reconciliation/generation.json`);
const priorFiles = new Map(historicalGeneration.files.map(f => [f.name, f.sha256]));
const inputChanges = generated.files.filter(f => priorFiles.get(f.name) !== f.sha256).map(f => f.name);
const browserSummary = await json('docs/evidence/t_8590b0cf/browser-summary.json');
const engineSummary = await json('docs/evidence/t_d2d10038/engine-summary.json');
const currentComponent = await json('docs/evidence/t_d2d10038/component-results.json');
async function compare(label, files) {
  const changed = [];
  for (const file of files) {
    assert(file.sha256 || typeof file.text === 'string', `Нет эталона ${file.path}`);
    const matches = file.sha256 ? await hash(file.path) === file.sha256 : await readFile(file.path, 'utf8') === file.text;
    if (!matches) changed.push(file.path);
  }
  return { label, compared: files.length, changed, allMatch: changed.length === 0 };
}
const historicalChecks = [
  await compare('B run109 src', browserSummary.sourceFiles),
  await compare('B run109 dist', browserSummary.distFiles),
  await compare('E run104 src', Object.entries(engineSummary.sourceHashes).map(([file, sha256]) => ({ path: file, sha256 }))),
  await compare('E сохранённые малые outputs', engineSummary.component.verifiedFiles),
  await compare('B сохранённые outputs', browserSummary.outputs),
  await compare('E последние component-results outputs (после B)', currentComponent.flatMap(c => (c.files ?? []).map(f => ({ path: f.output, sha256: f.sha256, text: f.text })))),
];
const media = await json(`${evidence}/media-results.json`);
const server = await json(`${evidence}/server-results.json`);
const browsers = await json(`${evidence}/browser-inputs.json`);
const markerCheck = await json(`${evidence}/media-verification.json`);
assert(server.results.every(r => r.status === 'passed'));
assert.equal(media.status, 'passed');
assert.equal(markerCheck.verifiedHashes, generated.files.length);
assert.equal(browsers.results.length, 2);
assert.deepEqual(browsers.results.map(r => r.browser).sort(), ['brave', 'chrome']);
assert(browsers.results.every(r => r.status === 'passed'));

// AT → уже существующее / дополненные входы / остаток продуктовой приёмки.
// Списки являются inventory, НЕ утверждением что AT пройден.
const data = [
  ['/', 'direct', 'B CDP install/popup; native run111 blocked', 'Два origin и страница для чистой actual-dist установки', 'Оператор: Developer mode Load unpacked, CSP/popup actual dist Chrome'],
  ['/', 'direct', 'B тот же dist в Brave через CDP', 'Тот же стенд без browser-specific медиа', 'Оператор: actual-dist установка Brave, Shields/версия'],
  ['/', 'direct', 'B no-access/no-fetch и native permission reports', 'Журнал каждого origin без query/cookies', 'Оператор: настоящий host deny/grant и CDN/local mode'],
  ['/extensionless', 'direct', 'E direct7 SHA; B прямой Downloads hash', '7 direct-форматов, extensionless MIME и полные HTTP SHA', 'I: обнаружение→скачивание обоих вариантов actual dist; SHA результата'],
  ['/media/source.webm', 'direct', 'E direct7 SHA + audio remux', 'WebM/MKV/MP3/M4A/Ogg/WAV INPUT metadata/full decode', 'I: все direct output hashes, исходный suffix/codec'],
  ['/media/master.m3u8', 'hls', 'E HLS TS + B короткий HLS popup', '3 реальных разрешения 90/180/270, markers, 2 аудиоязыка/CDN', 'I: один материал/3 variants, выбор не лучшего, output/seek'],
  ['/media/range.m3u8', 'hls', 'E hls-fmp4/ranges component outputs', 'fMP4/MAP/BYTERANGE + HTTP ranges с точными байтами', 'I: actual-dist output seek/duration/init requests'],
  ['/media/master.m3u8', 'hls', 'E selected-audio; B popup en/audio-only', 'ru880Hz/en440Hz, flash/tone эталон split inputs', 'I: output markers start/middle/end ≤100ms + плеер/язык/fallback'],
  ['/media/discontinuity.m3u8', 'hls', 'E discontinuity/config-change parts', 'discontinuity и смена 90→180p; реальные resolver планы', 'I: все части/предупреждение/seek/воспроизведение'],
  ['/media/dash.mpd', 'dash', 'E DASH AV/offset component files', 'Template+Timeline и Template duration, отдельные AV', 'I: actual-dist remux markers/seek/длительность'],
  ['/media/list.mpd', 'dash', 'E dash-list/base-sidx', 'List ranges + BaseURL/SegmentBase настоящий sidx (/media/base.mpd)', 'I: оба профиля actual-dist output/index/ranges'],
  ['/media/periods.mpd', 'dash', 'E periods 2 части', '2 последовательных Period по6s; resolver не теряет второй', 'I: total12s/обе части, config-change из E corpus'],
  ['/live/hls.m3u8', 'hls', 'E/B короткий live Stop', '906s непрерывные PTS/уникальные fragments/sliding/ENDLIST', 'I длительный: ≥900s wall time + Stop, нет дублей, файл/seek'],
  ['/live/dash.mpd', 'dash', 'E короткий DASH live/limit', '906s split AV timeline window/dynamic→static', 'I длительный: ≥900s wall time + Stop, sync/seek/целостность'],
  ['/live-gap.m3u8', 'hls', 'E live-gap warning', 'Управляемый clock, EXT-X-GAP и реальный404 segment; /live/gap.m3u8 jump', 'I: окно потеряно→видимый warning и воспроизводимый остаток'],
  ['/media/master.m3u8', 'hls', 'E VTT/TTML sidecars/warning; B popup VTT', 'segmented VTT expected.vtt + external.vtt/text.ttml/subtitles.mpd', 'I: output sidecars/times/language; отказ subtitles не портит видео'],
  ['/media/encrypted.m3u8', 'hls', 'E AES/DRM отказ', 'AES128/SESSION-KEY/DRM HTTP manifests, запрет key request', 'I: понятный отказ UI, нет ложного MP4/license/key fetch'],
  ['/', 'direct', 'B SPA/stale revision/lazy frame/navigation', 'Реальные browser input iframe+SPA в Chrome/Brave', 'I: tab/frame/generation, поздние события, несколько материалов/вкладок'],
  ['/signed', 'direct', 'E safe redirects; B redaction', 'Подпись/expiry, encoded query, redirect/loop и запрет нового authority', 'I: actual-browser opaque redirects fail closed/redetect; UI error'],
  ['/auth/page', 'direct', 'spike auth; B отсутствие native grant', 'Chrome/Brave HttpOnly SameSite=Lax 401→200 + exact hash, no CORS bypass', 'I/оператор: actual dist permissions/policies; это same-site, не cross-site guarantee'],
  ['/fault/stall', 'direct', 'E fetch unit retries + B error states', 'HTTP401/403/404/429/500; Retry-After; timeout/stall/disconnect/truncated', 'B: исправить unhandled NETWORK_TIMEOUT; I: retries/backoff/concurrency/UI offline'],
  ['/fault/ignore-range', 'direct', 'E range identity unit/component', '200 вместо206, неверный диапазон/ETag-change/416/suffix range', 'I: нет append corruption; hash результата/new attempt'],
  ['/media/source.mp4', 'direct', 'B popup close + продолжение job', 'Переиспользуется B harness, новый продуктовый код не нужен', 'I: popup И manager закрыты; browser complete и snapshot'],
  ['/media/source.mp4', 'direct', 'B SW stop same host/single export/hash', 'Переиспользуется ServiceWorker.stopAllWorkers в B harness', 'I: закрытые DevTools/lease/downloadId, fetch/export обе стадии'],
  ['/media/source.mp4', 'direct', 'B browser restart interrupted/session clearing', 'Переиспользуется close/relaunch только project profile', 'I: checkpoint/disk/session/settings, не вечный downloading'],
  ['/media/master.m3u8', 'hls', 'E checkpoint/cancel + B pause-before-first/idempotent/20cancels', 'Повторно не написано; reuse B/E lifecycle harness', 'I: все supported paths/late epoch/cleanup/requestId; live no pause'],
  ['/media/master.m3u8', 'hls', 'E unit quota writer-create fault + B очередь concurrency1/promotion', 'Reuse tests/unit/engine/regressions.test.ts (mock handle quota) и реальные HTTP faults', 'I: jobs1–4,segments1–8/global16; QUOTA/DISK ошибки изолированы, не HTTP fake; настоящая disk/quota приёмка не выполнена'],
  ['/media/live-source.mp4', 'direct', 'E large8 cases256MiB/2GiB direct/split-HLS, bounded heap; не full RAM', 'Markers эталон 906s; новые гигабайтные файлы не дублированы', 'I длительный: product direct+split AV256MiB/2GiB, полная RAM attribution/markers/плеер'],
  ['/media/source.mp4', 'direct', 'B Save As/Reload native не выполнены', 'Малый источник и SHA для операторского протокола', 'Оператор: cancel/save/collision, не completed до реального commit'],
  ['/media/xxe.mpd', 'dash', 'E security unit + B XSS/forged sender no-fetch', 'XXE/private URL/manifest8MiB/100001segments/depth/redirect limits/traversal', 'I: actual-dist XSS/имена/прокси/XXE; DNS rebinding не объявлять закрытым'],
  ['/signed', 'direct', 'B diagnostic/settings redaction', 'Безопасный HTTP журнал и synthetic token inputs', 'I: preview/export/settings/история без токенов/Auth/cookies'],
  ['/', 'direct', 'B settings CAS/future-schema/restart; Reload blocked', 'Reuse B migration/session fixtures; новый dist не создаётся', 'Оператор Reload stable ID + I schema migration/active interrupted'],
  ['/media/source.mp4', 'direct', 'E orphans + B20cancels/explicitclear/retention', 'Reuse настоящие OPFS/IDB lifecycle tests', 'I: success/cancel/crash/orphan TTL24h/paused preserve; user output остаётся'],
  ['/media/master.m3u8', 'hls', 'E capability validators + B UI injected combinations', 'Реальные H264/AAC,VP9/Opus,AAC,MP3 входы', 'I: UI и forged selections; AAC→MP3 reject, допустимые remux не suffix rename'],
  ['/', 'direct', 'docs/reference-audit.md; parity not_checked', 'Все local inputs доступны сравнительному аудиту, оригинал не установлен', 'Оператор: отдельно разрешить официальный эталон; затем сравнительный I/сайты'],
];
assert.equal(data.length, 35);
const matrix = csv(await readFile('docs/requirements-matrix.csv', 'utf8'));
const ats = matrix.filter(r => r.kind === 'AT'); assert.equal(ats.length, 35);
const coverage = data.map(([entryPath, protocol, existing, added, remaining], i) => ({
  id: `AT-${String(i + 1).padStart(2, '0')}`, requirement: ats[i].requirement, entryPath, protocol,
  existing, added, remaining, productStatus: 'not_checked',
  evidence: [4,5,6,7,8,9,10,11,12,13,14,15,16,17,19,21,22,30,34].includes(i + 1) ? ['server-results.json', 'media-results.json', 'run115-compatibility.log'] : [18,20].includes(i + 1) ? ['browser-inputs.json'] : ['historical-checks.json'],
}));
assert.deepEqual(coverage.map(r => r.id), ats.map(r => r.id));
const cases = coverage.map(row => ({
  id: `F-${row.id}`, atIds: [row.id], origins: ['page', 'cdn'], entryPath: row.entryPath,
  generator: { command: 'node scripts/fixtures-generate.mjs', version: '1' },
  expected: { protocol: row.protocol, tracks: row.protocol === 'direct' ? ['исходные дорожки без изменения'] : ['выбранное video/audio; sidecar по выбору'],
    ...(row.entryPath.startsWith('/media/') && generated.files.find(f => '/media/' + f.name === row.entryPath) ? { sha256: generated.files.find(f => '/media/' + f.name === row.entryPath).sha256 } : {}),
    ...([13,14].includes(Number(row.id.slice(3))) ? { durationSeconds: generated.liveSeconds } : {}),
  },
  faults: ({ 'AT-15': ['sliding-window', 'EXT-X-GAP', 'HTTP404'], 'AT-17': ['AES-128', 'SESSION-KEY', 'DRM'], 'AT-19': ['expired', 'query-reencoding', 'redirect-authority', 'redirect-loop'], 'AT-20': ['HTTP401-without-session'], 'AT-21': ['401', '403', '404', '429', '500', 'timeout', 'stall', 'disconnect', 'truncated'], 'AT-22': ['ignore-range', 'wrong-range', 'etag-change', '416'], 'AT-27': ['unit-only-quota-injection'], 'AT-30': ['XXE', 'private-URL', 'manifest-size', 'segment-count', 'depth', 'traversal'] })[row.id] ?? [],
  scope: row.added, acceptanceRemaining: row.remaining,
}));
const frAndGates = matrix.filter(r => ['FR', 'FR-clause', 'GATE'].includes(r.kind)).map(row => ({
  id: row.id, requirement: row.requirement, atIds: row.test_ids.split(';'),
  inputs: [...new Set(row.test_ids.split(';').map(id => coverage.find(c => c.id === id)?.entryPath).filter(Boolean))],
  existing: [...new Set(row.test_ids.split(';').map(id => coverage.find(c => c.id === id)?.existing).filter(Boolean))],
  remaining: [...new Set(row.test_ids.split(';').map(id => coverage.find(c => c.id === id)?.remaining).filter(Boolean))],
  status: 'not_checked', note: 'Карта входов по исходной matrix; каждый подпункт FR требует отдельного product assertion. Наличие теста не доказывает полное покрытие clause.',
}));
await mkdir(evidence, { recursive: true });
await writeFile('fixtures/catalog.json', JSON.stringify({ schemaVersion: 1, originRoles: 'page/cdn заменяются значениями startFixtureServer().origins[0/1]; это не внешние hosts', inputManifest: '.test-data/fixtures-f/generated.json', mediaMetadata: 'docs/evidence/t_ab1783c7/media-results.json', cases }, null, 2));
await writeFile(`${evidence}/coverage.json`, JSON.stringify({ schemaVersion: 1, scope: 'Инвентаризация и готовность входов F; не passed продуктовых AT/FR/GATE', coverage, frAndGates }, null, 2));
await writeFile(`${evidence}/historical-checks.json`, JSON.stringify({ checkedAt: new Date().toISOString(), generatedFiles: generated.files.length, inputChangesSinceRun114: inputChanges, historicalChecks, note: 'Даже совпавшие hashes не переносят component acceptance на продукт. E index мог измениться после E в B; затронутые large/lifecycle результаты исторические.' }, null, 2));
const table = ['# Карта 35 AT и пробелов F', '', 'Все productStatus=not_checked. Это НЕ повторный прогон исторических E/B. Общая requirements-matrix.csv не изменяется.', '', '| ID | Уже существовало | Дополнено F | Что ещё требуется |', '|---|---|---|---|', ...coverage.map(r => `| ${r.id} | ${r.existing} | ${r.added} | ${r.remaining} |`)];
await writeFile(`${evidence}/coverage.md`, table.join('\n') + '\n');
const inventoryFiles = [...await inventory('tests'), ...await inventory('scripts'), ...await inventory('fixtures')];
await writeFile(`${evidence}/fixture-inventory.json`, JSON.stringify({ checkedAt: new Date().toISOString(), historicalChecks, files: inventoryFiles, legacyCorpusFiles: await inventory('.test-data/engine-component/media'), sourceFiles: await inventory('src'), distFiles: await inventory('dist') }, null, 2));
console.log(JSON.stringify({ catalogCases: cases.length, atRows: coverage.length, frAndGateRows: frAndGates.length, verifiedInputHashes: generated.files.length, changedInputs: inputChanges.length, historicalChecks }, null, 2));
