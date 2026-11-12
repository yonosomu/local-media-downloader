import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Test-only data/instrumentation. Production JS, UI, coordinator and engine are
// unchanged; injected metadata/snapshots are NOT media execution acceptance.
export async function independentChecks({ context, cdp, page, fixture, id, tabId, command, targetClient, results, browser }) {
  const passed = (name, details = {}) => results.push({ browser, id: name, status: 'passed', ...details });
  const popupUrl = `chrome-extension://${id}/ui/popup/index.html`;
  async function openPopup() {
    await fixture.bringToFront();
    const start = performance.now();
    await page.evaluate(() => chrome.action.openPopup());
    const target = (await cdp.send('Target.getTargets')).targetInfos.find(t => t.url === popupUrl);
    assert(target, 'Action popup target missing');
    const client = await targetClient(cdp, target.targetId);
    const evaluate = async expression => {
      const response = await client('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
      return response.result.value;
    };
    return { target, evaluate, start, close: async () => {
      await cdp.send('Target.closeTarget', { targetId: target.targetId });
      // Native action bubble teardown follows target destruction asynchronously.
      // Keep this settling time outside the next popup's measured open latency.
      await new Promise(r => setTimeout(r, 150));
    } };
  }
  async function restart() {
    const client = await context.newCDPSession(page);
    await client.send('ServiceWorker.enable'); await client.send('ServiceWorker.stopAllWorkers'); await client.detach();
    await command(page, 'GET_SETTINGS');
  }
  async function until(evaluate, expression) {
    for (let n = 0; n < 100; n++) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 20)); }
    throw new Error(`UI condition timeout: ${expression}`);
  }
  const savedRegistry = await page.evaluate(async () => (await chrome.storage.session.get('registry')).registry);
  const template = savedRegistry.entries.find(e => e.candidate.tabId === tabId && e.candidate.support === 'supported');
  assert(template);
  const savedSettings = await command(page, 'GET_SETTINGS');
  try {
    // Controlled snapshot for capability UI, not a fake download backend.
    const trackEntry = structuredClone(template);
    Object.assign(trackEntry.candidate, {
      title: 'UI track matrix', protocol: 'hls', isLive: true, revision: 100,
      variants: [
        { id: 'h264', height: 1080, bitrate: 1000000, fps: 30, codecs: ['avc1.42c01f'], hasAudio: false },
        { id: 'vp9', height: 720, bitrate: 500000, codecs: ['vp09.00.10.08'], hasAudio: false }
      ],
      audioTracks: [
        { id: 'ru', kind: 'audio', label: 'Русский', language: 'ru', codec: 'aac', channels: 2 },
        { id: 'en', kind: 'audio', label: 'English', language: 'en', codec: 'opus', channels: 2 }
      ],
      subtitleTracks: [{ id: 'sub-ru', kind: 'subtitle', language: 'ru', label: 'Text' }, { id: 'sub-en', kind: 'subtitle', language: 'en', label: 'Text' }],
      capabilities: { pause: false, resume: false, requiresSourceTab: false, containers: ['mp4', 'mkv', 'webm', 'm4a'] }
    });
    delete trackEntry.candidate.originalSuffix;
    await page.evaluate(async entry => {
      const { registry } = await chrome.storage.session.get('registry'); registry.entries = [entry]; registry.revision++;
      await chrome.storage.session.set({ registry });
    }, trackEntry);
    await restart();
    let popup = await openPopup();
    await until(popup.evaluate, 'document.querySelectorAll("article select[name=quality] option").length === 2');
    const change = (name, value, checked = false) => popup.evaluate(`(() => { const input = document.querySelector('[name="${name}"]'); input.${checked ? 'checked' : 'value'} = ${JSON.stringify(value)}; input.dispatchEvent(new Event('change', {bubbles:true})); })()`);
    const containers = () => popup.evaluate('Array.from(document.querySelector("select[name=container]").options, o=>o.value)');
    await change('quality', 'h264'); await change('audio', 'ru');
    assert.deepEqual(await containers(), ['mp4', 'mkv']);
    await change('audio', 'en'); assert.deepEqual(await containers(), []);
    assert.equal(await popup.evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="Начать запись потока").disabled'), true);
    await change('quality', 'vp9'); assert.deepEqual(await containers(), ['webm']);
    await change('audioOnly', true, true); assert.deepEqual(await containers(), ['webm']);
    await change('audio', 'ru'); assert.deepEqual(await containers(), ['mp4', 'mkv', 'm4a']);
    assert.equal(await popup.evaluate('Array.from(document.querySelectorAll("input")).filter(i=>i.name.startsWith("subtitle:")).length'), 2);
    assert.equal(await popup.evaluate('!!document.querySelector("[name=liveDuration]") && !!document.querySelector("[name=liveBytes]")'), true);
    await popup.close();
    passed('UI-track-live-container-matrix', { scope: 'Injected metadata only; no media execution claimed' });

    // 100 material cards and 100 real action-popup open/close cycles. Stop SW
    // once to restore the declared synthetic registry, not once per measurement.
    await page.evaluate(async ({ template, tabId }) => {
      const { registry } = await chrome.storage.session.get('registry');
      registry.entries = Array.from({ length: 100 }, (_, n) => {
        const e = structuredClone(template); e.candidate.id = crypto.randomUUID(); e.candidate.title = `Performance ${n}`; e.candidate.tabId = tabId; return e;
      }); registry.revision++;
      await chrome.storage.session.set({ registry });
    }, { template, tabId });
    await restart();
    const targetInventory = async () => (await cdp.send('Target.getTargets')).targetInfos.filter(t => ['worker', 'service_worker', 'background_page'].includes(t.type) || t.url.endsWith('/offscreen/host.html')).map(t => ({ type: t.type, url: t.url })).sort((a, b) => a.url.localeCompare(b.url));
    const beforeTargets = await targetInventory(), beforeUsage = await command(page, 'GET_STORAGE_USAGE'), timings = [];
    for (let n = 0; n < 100; n++) {
      popup = await openPopup();
      await until(popup.evaluate, 'document.querySelectorAll("article").length === 100 && document.querySelectorAll("article button:not(:disabled)").length === 100');
      timings.push(performance.now() - popup.start);
      assert.equal(await popup.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      await popup.close();
    }
    const afterTargets = await targetInventory(), afterUsage = await command(page, 'GET_STORAGE_USAGE');
    assert.deepEqual(afterTargets, beforeTargets);
    assert.equal(afterUsage.temporaryBytes, beforeUsage.temporaryBytes);
    assert.equal((await cdp.send('Target.getTargets')).targetInfos.filter(t => t.url === popupUrl).length, 0);
    const maxMs = Math.max(...timings);
    assert(maxMs <= 1000, `Popup with 100 cards exceeded 1s: ${maxMs}`);
    passed('100-cards-100-action-popup-cycles', { scope: 'Injected 100 direct candidate DTOs; real UI and snapshots', timingsMs: timings, maxMs, beforeTargets, afterTargets, temporaryBytes: afterUsage.temporaryBytes });
  } finally {
    await page.evaluate(registry => chrome.storage.session.set({ registry }), savedRegistry);
    await restart();
  }

  // Future settings schema must fail closed, without silently destroying data.
  const configuration = await page.evaluate(async () => (await chrome.storage.local.get('configuration')).configuration);
  try {
    const future = { schemaVersion: 99, revision: 123, settings: savedSettings.settings };
    await page.evaluate(configuration => chrome.storage.local.set({ configuration }), future);
    const reply = await page.evaluate(() => chrome.runtime.sendMessage({ version: 1, requestId: crypto.randomUUID(), type: 'GET_SETTINGS', payload: {} }));
    assert.equal(reply.ok, false); assert.equal(reply.error.code, 'INVALID_REQUEST');
    assert.deepEqual(await page.evaluate(async () => (await chrome.storage.local.get('configuration')).configuration), future);
    passed('future-settings-schema-rejected-without-reset');
  } finally {
    await page.evaluate(configuration => configuration === undefined ? chrome.storage.local.remove('configuration') : chrome.storage.local.set({ configuration }), configuration);
  }
}

export async function queueChecks({ page, command, waitJob, slowPayload, results, browser, database, evidence }) {
  const pauseJob = (await command(page, 'CREATE_JOB', slowPayload)).job;
  const downloading = await waitJob(page, pauseJob.id, j => j?.state === 'downloading' && j.capabilities.pause);
  await command(page, 'PAUSE_JOB', { jobId: downloading.id, expectedRevision: downloading.revision });
  const paused = await waitJob(page, pauseJob.id, j => j?.state === 'paused');
  const checkpoint = (await database(page, 'checkpoints')).find(c => c.jobId === paused.id);
  assert(checkpoint, 'Pause before first segment must leave a resumable checkpoint');
  assert.deepEqual(checkpoint.completedSegments, [], 'Regression must exercise pause before ANY segment is committed');
  assert.deepEqual(checkpoint.outputs, [], 'Early pause must not advertise unwritten output');
  assert.equal(checkpoint.attempt, paused.attempt);
  assert.equal(checkpoint.runEpoch, paused.runEpoch);
  await command(page, 'RESUME_JOB', { jobId: paused.id, expectedRevision: paused.revision });
  const resumed = await waitJob(page, pauseJob.id, j => j?.state.startsWith('completed') || j?.state === 'failed');
  assert.equal(resumed.state, 'completed');
  assert.equal(resumed.attempt, paused.attempt);
  assert.equal(resumed.runEpoch, paused.runEpoch);
  assert(resumed.outputs.every(o => o.state === 'saved'));
  const [download] = await page.evaluate(id => chrome.downloads.search({ id }), resumed.browserDownloadId);
  const sha = b => createHash('sha256').update(b).digest('hex');
  assert.equal(sha(await readFile(download.filename)), sha(await readFile(path.join(evidence, `${browser}-direct.mp4`))));
  results.push({ browser, id: 'pause-before-first-segment-resume-real-file-hash', status: 'passed', checkpointSegmentsAtPause: checkpoint.completedSegments.length, sameAttemptAndEpoch: true, sha256: sha(await readFile(download.filename)) });
  const s = await command(page, 'GET_SETTINGS');
  await command(page, 'UPDATE_SETTINGS', { expectedRevision: s.revision, settings: { ...s.settings, jobsConcurrency: 1 } });
  const first = (await command(page, 'CREATE_JOB', slowPayload)).job;
  await waitJob(page, first.id, j => j?.state === 'downloading');
  const second = (await command(page, 'CREATE_JOB', slowPayload)).job;
  const third = (await command(page, 'CREATE_JOB', slowPayload)).job;
  let jobs = (await command(page, 'GET_JOBS', { filter: 'active', limit: 100 })).jobs;
  assert.equal(jobs.filter(j => j.state !== 'queued').length, 1);
  assert.equal(jobs.find(j => j.id === second.id).state, 'queued');
  assert.equal(jobs.find(j => j.id === third.id).state, 'queued');
  const queued = jobs.find(j => j.id === second.id);
  await command(page, 'CLEAR_TEMP', { jobIds: [queued.id], confirmed: true });
  assert.equal((await waitJob(page, queued.id, j => j?.state === 'cancelled')).state, 'cancelled');
  // Clear active must reject, not stop its writers behind the user's back.
  await assert.rejects(() => command(page, 'CLEAR_TEMP', { jobIds: [first.id], confirmed: true }));
  const active = (await command(page, 'GET_JOBS', { filter: 'all', limit: 100 })).jobs.find(j => j.id === first.id);
  await command(page, 'CANCEL_JOB', { jobId: active.id, expectedRevision: active.revision });
  const promoted = await waitJob(page, third.id, j => j?.state === 'downloading');
  await command(page, 'CANCEL_JOB', { jobId: promoted.id, expectedRevision: promoted.revision });
  jobs = (await command(page, 'GET_JOBS', { filter: 'active', limit: 100 })).jobs;
  assert.equal(jobs.length, 0);
  assert.equal((await database(page, 'checkpoints')).length, 0);
  const usage = await command(page, 'GET_STORAGE_USAGE'); assert.equal(usage.temporaryBytes, 0);
  results.push({ browser, id: 'queue-concurrency-queued-clear-active-reject-promotion-cleanup', status: 'passed', temporaryBytes: usage.temporaryBytes });
}
