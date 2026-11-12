import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, stat, rm, cp } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { independentChecks, queueChecks } from './independent-checks.mjs';
import { managerChecks } from './manager-checks.mjs';
import { securityChecks, actualReloadCheck, observeObjectUrls } from './security-checks.mjs';
import { mediaUiChecks } from './media-ui-checks.mjs';
const root = process.cwd(), scratch = path.join(root, '.test-data/browser'), evidence = path.join(root, 'docs/evidence/t_8590b0cf');
await mkdir(scratch, { recursive: true }); await mkdir(evidence, { recursive: true });
const media = path.join(scratch, 'media'); await mkdir(media, { recursive: true });
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-c:a', 'aac', '-shortest', path.join(media, 'source.mp4')]);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(media, 'source.mp4'), '-c', 'copy', '-hls_time', '2', '-hls_segment_filename', path.join(media, 'seg-%d.ts'), path.join(media, 'vod.m3u8')]);
for (const [kind, omit] of [['video', '-an'], ['audio', '-vn']]) execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(media, 'source.mp4'), omit, '-c', 'copy', '-hls_time', '2', '-hls_segment_filename', path.join(media, `${kind}-%d.ts`), path.join(media, `${kind}.m3u8`)]);
await writeFile(path.join(media, 'master.m3u8'), '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Русский",LANGUAGE="ru",URI="audio.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",URI="audio.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",LANGUAGE="en",URI="sub.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=160x90,CODECS="avc1.42c00b,mp4a.40.2",AUDIO="a",SUBTITLES="s"\nvideo.m3u8\n');
await writeFile(path.join(media, 'sub.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\ntext.vtt\n#EXT-X-ENDLIST\n');
await writeFile(path.join(media, 'text.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nBrowser UI subtitle fixture\n');
await writeFile(path.join(media, 'live.m3u8'), (await readFile(path.join(media, 'vod.m3u8'), 'utf8')).replace('#EXT-X-ENDLIST', ''));
const requests = [];
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname; requests.push({ pathname, at: Date.now() });
  if (pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
  if (pathname === '/' || pathname === '/spa') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Browser fixture &lt;img src=x onerror=alert(1)&gt;</title><video controls preload="none" src="/source.mp4?token=LMD_TEST_SECRET"></video><button id="hls">HLS</button><script>document.getElementById("hls").onclick=()=>fetch("/vod.m3u8");</script>'); return; }
  if (pathname === '/frame') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Frame material</title><video preload="none" src="/opaque"></video>'); return; }
  if (pathname === '/slow.mp4') {
    const data = await readFile(path.join(media, 'source.mp4'));
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': data.length, ETag: '"slow-v1"' });
    let offset = 0; const timer = setInterval(() => { if (offset >= data.length) { clearInterval(timer); res.end(); } else { res.write(data.subarray(offset, offset + 8192)); offset += 8192; } }, 80);
    res.on('close', () => clearInterval(timer)); return;
  }
  const file = path.join(media, pathname === '/opaque' ? 'source.mp4' : pathname.slice(1));
  if (!file.startsWith(media + '/')) { res.writeHead(403).end(); return; }
  try {
    const info = await stat(file), range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    const type = pathname.endsWith('.mp4') || pathname === '/opaque' ? 'video/mp4' : pathname.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : pathname.endsWith('.vtt') ? 'text/vtt' : 'video/mp2t';
    const headers = { 'Content-Type': type, ETag: '"lmd-test"', 'Accept-Ranges': 'bytes' };
    if (range) { const start = Number(range[1]), end = Math.min(Number(range[2]), info.size - 1); res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 }); createReadStream(file, { start, end }).pipe(res); }
    else { res.writeHead(200, { ...headers, 'Content-Length': info.size }); createReadStream(file).pipe(res); }
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`, results = [];
async function command(page, type, payload = {}, requestId) { return page.evaluate(async ({ type, payload, requestId }) => { const reply = await chrome.runtime.sendMessage({ version: 1, requestId: requestId ?? crypto.randomUUID(), type, payload }); if (!reply?.ok) throw new Error(JSON.stringify(reply)); return reply.data; }, { type, payload, requestId }); }
async function waitJob(page, jobId, predicate) { for (let n = 0; n < 160; n++) { const job = (await command(page, 'GET_JOBS', { filter: 'all', limit: 100 })).jobs.find(j => j.id === jobId); if (predicate(job)) return job; await new Promise(r => setTimeout(r, 100)); } throw new Error(`Job state timeout: ${jobId}`); }
async function database(page, store) { return page.evaluate(async name => { const db = await new Promise((resolve, reject) => { const r = indexedDB.open('lmd-v1', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); try { return await new Promise((resolve, reject) => { const r = db.transaction(name).objectStore(name).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); } finally { db.close(); } }, store); }
async function targetClient(cdp, targetId) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId }); let sequence = 0;
  return async (method, params = {}) => {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cdp.off('Target.receivedMessageFromTarget', listener); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      const listener = event => { if (event.sessionId !== sessionId) return; const reply = JSON.parse(event.message); if (reply.id !== id) return; clearTimeout(timer); cdp.off('Target.receivedMessageFromTarget', listener); if (reply.error) reject(new Error(JSON.stringify(reply.error))); else resolve(reply.result); };
      cdp.on('Target.receivedMessageFromTarget', listener);
      void cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(reject);
    });
  };
}
try {
  for (const [browser, executablePath] of Object.entries({ chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' })) {
    const profile = await mkdtemp(path.join(scratch, `${browser}-`)), errors = [], startedAt = new Date().toISOString();
    const launch = () => chromium.launchPersistentContext(profile, { executablePath, headless: true, timeout: 25000, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'], acceptDownloads: true, downloadsPath: path.join(profile, 'downloads') });
    const watch = context => context.on('page', page => { page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); });
    let context = await launch();
    watch(context);
    let id;
    try {
      const cdp = await context.browser().newBrowserCDPSession();
      ({ id } = await cdp.send('Extensions.loadUnpacked', { path: path.join(root, 'dist') }));
      console.log(browser, 'installed', id);
      let page = await context.newPage();
      await page.goto(`chrome-extension://${id}/ui/options/index.html`);
      try { await page.waitForFunction(() => document.body.textContent.includes('Сохранить настройки'), null, { timeout: 15000 }); }
      catch (error) { console.error('UI body:', await page.locator('body').innerText(), 'contexts:', await page.evaluate(() => chrome.runtime.getContexts({}))); throw error; }
      results.push({ browser, id: 'install-settings', status: 'passed', extensionId: id, version: context.browser().version(), startedAt });
      const settings = await command(page, 'GET_SETTINGS'); assert.equal(settings.settings.jobsConcurrency, 2);
      let fixture = await context.newPage(); await fixture.goto(origin); await fixture.bringToFront();
      let tabs = await page.evaluate(() => chrome.tabs.query({ active: true, currentWindow: true })), tabId = tabs[0].id;
      const before = requests.length;
      const denied = await command(page, 'GET_TAB_MEDIA', { tabId }); assert.equal(denied.discoveryState, 'permission_required'); assert.equal(denied.candidates.length, 0); assert.equal(requests.slice(before).some(r => r.pathname.includes('mp4')), false);
      results.push({ browser, id: 'no-host-no-probe', status: 'passed' });
      await actualReloadCheck({ page, context, id, command, results, browser });
      // Component-only permission fixture: identical production bundles with a
      // required synthetic host grant. Original dist installation was checked above.
      // This is NOT evidence of the native optional-host consent flow.
      await context.close();
      const componentDist = path.join(profile, 'component-dist'); await cp(path.join(root, 'dist'), componentDist, { recursive: true });
      const manifest = JSON.parse(await readFile(path.join(componentDist, 'manifest.json'), 'utf8')); manifest.host_permissions = ['http://127.0.0.1/*']; await writeFile(path.join(componentDist, 'manifest.json'), JSON.stringify(manifest));
      context = await launch();
      watch(context);
      const componentCdp = await context.browser().newBrowserCDPSession(); ({ id } = await componentCdp.send('Extensions.loadUnpacked', { path: componentDist }));
      page = await context.newPage(); await page.goto(`chrome-extension://${id}/ui/options/index.html`);
      await command(page, 'GET_SETTINGS'); // wait for host and dynamic script registration
      assert.equal(await page.evaluate(() => chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] })), true);
      await page.evaluate(origin => chrome.storage.local.set({ localModeOrigins: [origin] }), origin);
      results.push({ browser, id: 'native-grant-dialog', status: 'skipped', reason: 'Native permission bubble unresolved in headless. Remaining component cases use a TEST COPY with required loopback host permission, identical production JS. Not product AT03/20 acceptance.' });
      fixture = await context.newPage(); await fixture.goto(origin); await fixture.bringToFront();
      tabs = await page.evaluate(() => chrome.tabs.query({ active: true, currentWindow: true })); tabId = tabs[0].id;
      let candidates;
      for (let n = 0; n < 80; n++) { candidates = (await command(page, 'GET_TAB_MEDIA', { tabId })).candidates; if (candidates.some(c => c.support === 'supported')) break; await new Promise(r => setTimeout(r, 250)); }
      console.log(browser, 'candidates', JSON.stringify(candidates));
      if (!candidates.length) console.log('discovery-debug', await page.evaluate(async () => ({ tabs: await chrome.tabs.query({}), grants: await chrome.permissions.getAll(), scripts: await chrome.scripting.getRegisteredContentScripts(), session: await chrome.storage.session.get('registry') })));
      assert(candidates.some(c => c.support === 'supported'));
      const c = candidates.find(c => c.support === 'supported'); assert(!JSON.stringify(c).includes('LMD_TEST_SECRET'));
      results.push({ browser, id: 'DOM-discovery-signature-safe-DTO', status: 'passed', candidate: c });
      const objectUrlStats = await observeObjectUrls({ cdp: componentCdp, targetClient, id });
      const requestId = crypto.randomUUID(), payload = { candidateId: c.id, expectedCandidateRevision: c.revision, selection: { variantId: c.variants[0]?.id, subtitleTrackIds: [], audioOnly: false, container: 'original' }, output: { name: 'direct.mp4', relativeDirectory: '', saveAs: false } };
      const created = await command(page, 'CREATE_JOB', payload, requestId), duplicate = await command(page, 'CREATE_JOB', payload, requestId); assert.equal(created.job.id, duplicate.job.id);
      let job;
      for (let n = 0; n < 120; n++) { job = (await command(page, 'GET_JOBS', { filter: 'all', limit: 100 })).jobs.find(j => j.id === created.job.id); if (job?.state.startsWith('completed') || job?.state === 'failed') break; await new Promise(r => setTimeout(r, 250)); }
      console.log(browser, 'job', JSON.stringify(job)); assert.equal(job.state, 'completed'); assert.equal(job.outputs[0].state, 'saved');
      const download = await page.evaluate(id => chrome.downloads.search({ id }), job.browserDownloadId); assert.equal(download[0].state, 'complete');
      // Playwright downloads are isolated and may use a temporary GUID path.
      const outputPath = download[0].filename, sha = b => createHash('sha256').update(b).digest('hex');
      assert.equal(sha(await readFile(outputPath)), sha(await readFile(path.join(media, 'source.mp4'))));
      const retained = path.join(evidence, `${browser}-direct.mp4`); await writeFile(retained, await readFile(outputPath));
      results.push({ browser, id: 'real-engine-Downloads-ack-dedupe-sha256', status: 'passed', job, output: retained, sha256: sha(await readFile(retained)) });
      await fixture.bringToFront();
      await page.evaluate(() => chrome.action.openPopup());
      const target = (await componentCdp.send('Target.getTargets')).targetInfos.find(t => t.url === `chrome-extension://${id}/ui/popup/index.html`); assert(target);
      const popup = await targetClient(componentCdp, target.targetId);
      const evaluatePopup = async expression => { const r = await popup('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
      for (let n = 0; n < 50; n++) { if (await evaluatePopup('!!document.querySelector("article input")')) break; await new Promise(r => setTimeout(r, 100)); }
      assert.equal(await evaluatePopup('document.querySelectorAll("article img").length'), 0);
      assert.equal(await evaluatePopup('document.documentElement.scrollWidth <= innerWidth'), true);
      // Regression injection is confined to the isolated test session: publish a
      // newer metadata revision while the user is editing. Runtime remains real.
      await evaluatePopup('document.querySelector("input[name=name]").focus(); document.querySelector("input[name=name]").value="retained-name.mp4"; document.querySelector("input[name=directory]").value="my-folder"');
      await page.evaluate(async candidateId => {
        const { registry } = await chrome.storage.session.get('registry');
        const entry = registry.entries.find(e => e.candidate.id === candidateId);
        entry.candidate.revision++; entry.candidate.title = 'Updated metadata'; registry.revision++;
        await chrome.storage.session.set({ registry });
      }, c.id);
      const draftCdp = await context.newCDPSession(page);
      await draftCdp.send('ServiceWorker.enable'); await draftCdp.send('ServiceWorker.stopAllWorkers'); await draftCdp.detach();
      await command(page, 'GET_TAB_MEDIA', { tabId });
      for (let n = 0; n < 80; n++) { if (await evaluatePopup('document.querySelector("article h2")?.textContent === "Updated metadata"')) break; await new Promise(r => setTimeout(r, 100)); }
      assert.equal(await evaluatePopup('document.querySelector("article h2").textContent'), 'Updated metadata');
      assert.equal(await evaluatePopup('document.querySelector("input[name=name]").value'), 'retained-name.mp4');
      assert.equal(await evaluatePopup('document.querySelector("input[name=directory]").value'), 'my-folder');
      assert.equal(await evaluatePopup('document.activeElement?.name'), 'name');
      results.push({ browser, id: 'popup-metadata-revision-preserves-edits-focus', status: 'passed', testInjection: 'New registry metadata revision in session storage, followed by real SW restart' });
      const popupCapture = await popup('Page.captureScreenshot'); await writeFile(path.join(evidence, `${browser}-component-popup.png`), Buffer.from(popupCapture.data, 'base64'));
      await evaluatePopup('Array.from(document.querySelectorAll("label")).find(l=>l.textContent==="Имя файла").querySelector("input").value="popup-selected.mp4"; Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="Скачать").click()');
      await componentCdp.send('Target.closeTarget', { targetId: target.targetId });
      for (let n = 0; n < 80; n++) { const jobs = (await command(page, 'GET_JOBS', { filter: 'completed', limit: 100 })).jobs; if (jobs.some(j => j.outputName === 'popup-selected.mp4')) break; await new Promise(r => setTimeout(r, 250)); }
      assert((await command(page, 'GET_JOBS', { filter: 'completed', limit: 100 })).jobs.some(j => j.outputName === 'popup-selected.mp4'));
      results.push({ browser, id: 'actual-action-popup-selection-close-XSS-layout', status: 'passed' });
      await fixture.locator('#hls').click();
      for (let n = 0; n < 80; n++) { candidates = (await command(page, 'GET_TAB_MEDIA', { tabId })).candidates; if (candidates.some(c => c.protocol === 'hls' && c.support === 'supported')) break; await new Promise(r => setTimeout(r, 250)); }
      assert(candidates.some(c => c.protocol === 'hls' && c.support === 'supported'));
      results.push({ browser, id: 'network-HLS-discovery', status: 'passed' });
      const hls = candidates.find(c => c.protocol === 'hls' && c.support === 'supported');
      const hlsJob = await command(page, 'CREATE_JOB', { candidateId: hls.id, expectedCandidateRevision: hls.revision, selection: { variantId: hls.variants[0].id, subtitleTrackIds: [], audioOnly: false, container: 'mp4' }, output: { name: 'hls-remux.mp4', relativeDirectory: '', saveAs: false } });
      const remux = await waitJob(page, hlsJob.job.id, j => j?.state.startsWith('completed') || j?.state === 'failed'); assert.equal(remux.state, 'completed');
      const [remuxDownload] = await page.evaluate(id => chrome.downloads.search({ id }), remux.browserDownloadId);
      const remuxFile = path.join(evidence, `${browser}-hls.mp4`); await writeFile(remuxFile, await readFile(remuxDownload.filename));
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', remuxFile], { encoding: 'utf8' }));
      assert(probe.streams.some(s => s.codec_name === 'h264')); assert(probe.streams.some(s => s.codec_name === 'aac')); assert(Math.abs(Number(probe.format.duration) - 4) < 0.5);
      results.push({ browser, id: 'HLS-real-engine-remux-ffprobe', status: 'passed', output: remuxFile, streams: probe.streams.map(s => s.codec_name), duration: probe.format.duration });
      assert.equal((await command(page, 'GET_TAB_MEDIA', { tabId })).candidates.length, 2);
      assert((await page.evaluate(tabId => chrome.action.getBadgeText({ tabId }), tabId)) === '2');
      results.push({ browser, id: 'segment-grouping-badge', status: 'passed' });
      await mediaUiChecks({ context, cdp: componentCdp, page, fixture, id, tabId, command, waitJob, targetClient, browser, results, evidence });
      const receiptCount = (await database(page, 'commandReceipts')).length;
      for (let n = 0; n < 10; n++) await command(page, 'GET_STORAGE_USAGE');
      assert.equal((await database(page, 'commandReceipts')).length, receiptCount);
      const s = await command(page, 'GET_SETTINGS'), settingRequestId = crypto.randomUUID(), settingPayload = { expectedRevision: s.revision, settings: { ...s.settings, jobsConcurrency: 1 } };
      const updated = await command(page, 'UPDATE_SETTINGS', settingPayload, settingRequestId);
      assert.deepEqual(await command(page, 'UPDATE_SETTINGS', settingPayload, settingRequestId), updated);
      await assert.rejects(() => command(page, 'UPDATE_SETTINGS', { ...settingPayload, expectedRevision: s.revision }));
      await assert.rejects(() => command(page, 'CREATE_JOB', { ...payload, expectedCandidateRevision: c.revision + 100 }));
      const forbidden = await page.evaluate(async () => { try { return await chrome.runtime.sendMessage({ version: 1, requestId: crypto.randomUUID(), target: 'engine-host', type: 'ENGINE_SNAPSHOT', payload: {} }); } catch { return undefined; } }); assert.equal(forbidden, undefined);
      results.push({ browser, id: 'settings-CAS-receipt-no-read-leak-forged-host', status: 'passed' });
      const manager = await context.newPage(); await manager.goto(`chrome-extension://${id}/ui/manager/index.html`); await manager.getByRole('heading', { name: 'Updated metadata' }).first().waitFor();
      await manager.getByLabel('Фильтр').selectOption('completed'); await manager.locator('article').first().waitFor(); await manager.close();
      results.push({ browser, id: 'manager-real-snapshot-filter', status: 'passed' });
      await fixture.evaluate(() => { const v = document.createElement('video'); v.preload = 'none'; v.src = '/slow.mp4'; document.body.append(v); });
      let slow;
      for (let n = 0; n < 80; n++) { slow = (await command(page, 'GET_TAB_MEDIA', { tabId })).candidates.find(x => x.id !== c.id && x.protocol === 'direct' && x.support === 'supported'); if (slow) break; await new Promise(r => setTimeout(r, 100)); }
      assert(slow);
      const slowPayload = { ...payload, candidateId: slow.id, expectedCandidateRevision: slow.revision, output: { name: 'slow.mp4', relativeDirectory: '', saveAs: false } };
      for (let n = 0; n < 20; n++) {
        const { job: created } = await command(page, 'CREATE_JOB', slowPayload);
        const running = await waitJob(page, created.id, j => j?.state === 'downloading');
        await command(page, 'CANCEL_JOB', { jobId: running.id, expectedRevision: running.revision });
        assert.equal((await waitJob(page, created.id, j => j?.state === 'cancelled')).state, 'cancelled');
      }
      const checkpoints = await database(page, 'checkpoints'); assert.equal(checkpoints.length, 0);
      results.push({ browser, id: 'twenty-real-cancels-checkpoint-cleanup', status: 'passed' });
      await queueChecks({ page, command, waitJob, slowPayload, results, browser, database, evidence });
      await securityChecks({ page, command, slowPayload, tabId, requests, results, browser });
      await independentChecks({ context, cdp: componentCdp, page, fixture, id, tabId, command, targetClient, results, browser });
      const downloadsBeforeRestart = (await page.evaluate(() => chrome.downloads.search({}))).length;
      const { job: swJob } = await command(page, 'CREATE_JOB', slowPayload);
      await waitJob(page, swJob.id, j => j?.state === 'downloading');
      const beforeHost = await page.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
      const swCdp = await context.newCDPSession(page);
      await swCdp.send('ServiceWorker.enable'); await swCdp.send('ServiceWorker.stopAllWorkers'); await swCdp.detach();
      const afterRestart = await waitJob(page, swJob.id, j => j?.state.startsWith('completed') || j?.state === 'failed'); assert.equal(afterRestart.state, 'completed');
      const afterHost = await page.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })); assert.equal(afterHost[0].contextId, beforeHost[0].contextId);
      assert.equal((await page.evaluate(() => chrome.downloads.search({}))).length, downloadsBeforeRestart + 1);
      const [swDownload] = await page.evaluate(id => chrome.downloads.search({ id }), afterRestart.browserDownloadId);
      assert.equal(sha(await readFile(swDownload.filename)), sha(await readFile(path.join(media, 'source.mp4'))));
      results.push({ browser, id: 'SW-stop-reconcile-single-host-no-duplicate-export', status: 'passed' });
      const urlStats = await objectUrlStats();
      assert(urlStats.created >= 4); assert.equal(urlStats.active, 0); assert.equal(urlStats.created, urlStats.revoked);
      results.push({ browser, id: 'export-object-URLs-revoked-after-completion-cancels', status: 'passed', ...urlStats });
      const oldIds = (await command(page, 'GET_TAB_MEDIA', { tabId })).candidates.map(c => c.id);
      await fixture.evaluate(() => history.pushState({}, '', '/spa'));
      await new Promise(r => setTimeout(r, 500));
      const spa = await command(page, 'GET_TAB_MEDIA', { tabId }); assert(spa.candidates.every(c => !oldIds.includes(c.id)));
      results.push({ browser, id: 'SPA-generation-eviction', status: 'passed' });
      await fixture.evaluate(() => { const f = document.createElement('iframe'); f.src = '/frame'; document.body.append(f); });
      let framed;
      for (let n = 0; n < 80; n++) { framed = (await command(page, 'GET_TAB_MEDIA', { tabId })).candidates.find(c => c.frameId !== 0 && c.support === 'supported'); if (framed) break; await new Promise(r => setTimeout(r, 100)); }
      assert(framed); assert.equal(framed.originalSuffix, 'mp4');
      results.push({ browser, id: 'lazy-iframe-extensionless-MIME', status: 'passed' });

      // Re-use the newly detected slow material, identified by sourceRef privately in session.
      const slowId = await page.evaluate(async tabId => { const { registry } = await chrome.storage.session.get('registry'); return registry.entries.find(e => e.candidate.tabId === tabId && e.source.exactUrl.endsWith('/slow.mp4')).candidate.id; }, tabId);
      const restartCandidate = (await command(page, 'GET_TAB_MEDIA', { tabId })).candidates.find(c => c.id === slowId); assert(restartCandidate);

      const { job: browserJob } = await command(page, 'CREATE_JOB', { ...slowPayload, candidateId: restartCandidate.id, expectedCandidateRevision: restartCandidate.revision });
      await waitJob(page, browserJob.id, j => j?.state === 'downloading');
      await context.close(); context = await launch();
      watch(context);
      // CDP loads are session-scoped in these installed browsers. Re-register the
      // same unpacked path after restart; retain profile IDB/settings, not sessions.
      const restartedCdp = await context.browser().newBrowserCDPSession();
      const reloaded = await restartedCdp.send('Extensions.loadUnpacked', { path: componentDist }); assert.equal(reloaded.id, id);
      page = await context.newPage(); await page.goto(`chrome-extension://${id}/ui/options/index.html`);
      await command(page, 'GET_SETTINGS');
      const interrupted = await waitJob(page, browserJob.id, j => j?.state === 'interrupted'); assert.equal(interrupted.state, 'interrupted');
      assert.equal((await command(page, 'GET_SETTINGS')).settings.jobsConcurrency, 1);
      assert.equal(await page.evaluate(async () => Object.keys((await chrome.storage.session.get('jobSources')).jobSources ?? {}).length), 0);
      results.push({ browser, id: 'browser-restart-interrupted-settings-preserved-session-cleared', status: 'passed' });
      const historySettings = await command(page, 'GET_SETTINGS');
      await command(page, 'UPDATE_SETTINGS', { expectedRevision: historySettings.revision, settings: { ...historySettings.settings, historyMaxEntries: 2 } });
      assert.equal((await database(page, 'history')).length, 2);
      assert((await command(page, 'GET_JOBS', { filter: 'errors', limit: 100 })).jobs.some(j => j.id === browserJob.id));
      const disableHistory = await command(page, 'GET_SETTINGS');
      await command(page, 'UPDATE_SETTINGS', { expectedRevision: disableHistory.revision, settings: { ...disableHistory.settings, historyEnabled: false } });
      assert.equal((await database(page, 'history')).length, 0);
      const recoveryJobs = (await command(page, 'GET_JOBS', { filter: 'all', limit: 100 })).jobs; assert.equal(recoveryJobs.length, 1); assert.equal(recoveryJobs[0].id, browserJob.id);
      await command(page, 'CLEAR_TEMP', { jobIds: [browserJob.id], confirmed: true });
      results.push({ browser, id: 'history-retention-preserves-interrupted-recovery-explicit-clear', status: 'passed' });
      const diag = await command(page, 'EXPORT_DIAGNOSTICS', { preview: true }); assert(!diag.redactedText.includes('LMD_TEST_SECRET')); results.push({ browser, id: 'diagnostics-no-secrets', status: 'passed' });
      await managerChecks({ context, page, id, results, browser });
      await page.screenshot({ path: path.join(evidence, `${browser}-options.png`), fullPage: true });
      assert.deepEqual(errors, []);
      results.push({ browser, id: 'runtime-CSP-page-errors', status: 'passed', errors });
    } catch (error) { results.push({ browser, id: 'run-failure', status: 'failed', error: error.message, extensionId: id, errors }); console.error(browser, error); process.exitCode = 1; }
    finally { await context.close(); await rm(profile, { recursive: true, force: true }); await writeFile(path.join(evidence, 'browser-results.json'), JSON.stringify({ results }, null, 2)); }
  }
} finally { await new Promise(resolve => server.close(resolve)); }
console.log(JSON.stringify(results.map(r => ({ browser: r.browser, id: r.id, status: r.status })), null, 2));
