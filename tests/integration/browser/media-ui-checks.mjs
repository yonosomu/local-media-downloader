import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export async function mediaUiChecks({ context, cdp, page, fixture, id, tabId, command, waitJob, targetClient, browser, results, evidence }) {
  async function discover(file) {
    await fixture.evaluate(file => fetch(`/${file}`).then(r => r.text()), file);
    for (let n = 0; n < 100; n++) {
      const candidateId = await page.evaluate(async file => (await chrome.storage.session.get('registry')).registry.entries.find(e => new URL(e.source.exactUrl).pathname === `/${file}`)?.candidate.id, file);
      const candidate = (await command(page, 'GET_TAB_MEDIA', { tabId })).candidates.find(c => c.id === candidateId && c.support === 'supported');
      if (candidate) return candidate;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Media discovery timeout: ${file}`);
  }
  async function startThroughPopup(candidate, outputName, audioOnly = false) {
    await fixture.bringToFront(); await page.evaluate(() => chrome.action.openPopup());
    const target = (await cdp.send('Target.getTargets')).targetInfos.find(t => t.url === `chrome-extension://${id}/ui/popup/index.html`); assert(target);
    const client = await targetClient(cdp, target.targetId);
    const expression = `(() => {
      const card = document.querySelector('article[data-candidate-id="${candidate.id}"]');
      if (!card?.querySelector('input[name=name]')) return false;
      const audio = card.querySelector('select[name=audio]');
      if (audio.options.length > 1) { audio.selectedIndex = 1; audio.dispatchEvent(new Event('change')); }
      const only = card.querySelector('input[name=audioOnly]'); only.checked = ${audioOnly}; only.dispatchEvent(new Event('change'));
      const container = card.querySelector('select[name=container]'); container.value = ${JSON.stringify(audioOnly ? 'm4a' : 'mp4')}; container.dispatchEvent(new Event('change'));
      for (const sub of card.querySelectorAll('fieldset input')) sub.checked = !${audioOnly};
      card.querySelector('input[name=name]').value = ${JSON.stringify(outputName)};
      card.querySelector('button').click(); return true;
    })()`;
    try {
      let clicked = false;
      for (let n = 0; n < 100; n++) {
        const r = await client('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
        if (r.result.value) { clicked = true; break; }
        await new Promise(r => setTimeout(r, 50));
      }
      assert(clicked);
      for (let n = 0; n < 100; n++) {
        const jobs = (await command(page, 'GET_JOBS', { filter: 'all', limit: 100 })).jobs;
        const job = jobs.find(j => j.outputName === outputName); if (job) return job;
        await new Promise(r => setTimeout(r, 50));
      }
      const diagnostic = await client('Runtime.evaluate', { expression: 'document.getElementById("status").textContent', returnByValue: true });
      throw new Error(`Popup did not create real job (${outputName}): ${diagnostic.result.value}`);
    } finally { await cdp.send('Target.closeTarget', { targetId: target.targetId }); await new Promise(r => setTimeout(r, 150)); }
  }
  async function retain(job, label) {
    const files = [];
    for (const output of job.outputs) {
      assert.equal(output.state, 'saved');
      const [download] = await page.evaluate(id => chrome.downloads.search({ id }), output.browserDownloadId);
      assert.equal(download.state, 'complete');
      const file = path.join(evidence, `${browser}-${label}-${output.name}`);
      await writeFile(file, await readFile(download.filename)); files.push(file);
    }
    return files;
  }
  const master = await discover('master.m3u8'); assert.equal(master.audioTracks.length, 2); assert.equal(master.subtitleTracks.length, 1);
  const selected = await startThroughPopup(master, 'ui-tracks.mp4');
  const done = await waitJob(page, selected.id, j => j?.state.startsWith('completed') || j?.state === 'failed'); assert.equal(done.state, 'completed');
  assert.equal(done.selection.audioTrackId, master.audioTracks[1].id); assert.deepEqual(done.selection.subtitleTrackIds, [master.subtitleTracks[0].id]);
  const tracksFiles = await retain(done, 'tracks');
  const video = tracksFiles.find(f => f.endsWith('.mp4')), subtitles = tracksFiles.find(f => f.endsWith('.vtt')); assert(video && subtitles);
  assert((await readFile(subtitles, 'utf8')).includes('Browser UI subtitle fixture'));
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video], { encoding: 'utf8' }));
  assert(probe.streams.some(s => s.codec_name === 'aac' && s.tags?.language === 'eng')); assert(probe.streams.some(s => s.codec_name === 'h264'));
  results.push({ browser, id: 'popup-real-selected-audio-subtitle-sidecar', status: 'passed', outputs: tracksFiles, audioLanguage: 'eng', scope: 'Real synthetic HLS split media via action popup, engine, Downloads completion; not AV-marker or native permission acceptance' });
  const audioJob = await startThroughPopup(master, 'ui-audio.m4a', true);
  const audioDone = await waitJob(page, audioJob.id, j => j?.state.startsWith('completed') || j?.state === 'failed'); assert.equal(audioDone.state, 'completed');
  const audioFiles = await retain(audioDone, 'audio-only');
  const audioProbe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', audioFiles[0]], { encoding: 'utf8' }));
  assert.equal(audioProbe.streams.length, 1); assert.equal(audioProbe.streams[0].codec_type, 'audio');
  results.push({ browser, id: 'popup-real-audio-only-m4a', status: 'passed', outputs: audioFiles, streams: audioProbe.streams.map(s => s.codec_name) });
  const live = await discover('live.m3u8'); assert.equal(live.isLive, true);
  for (const cancel of [false, true]) {
    const created = await startThroughPopup(live, cancel ? 'ui-live-cancel.mp4' : 'ui-live-stop.mp4');
    await waitJob(page, created.id, j => j?.state === 'downloading' && j.segmentsDone >= 2);
    const manager = await context.newPage();
    try {
      await manager.goto(`chrome-extension://${id}/ui/manager/index.html`);
      const card = manager.locator(`article[data-job-id="${created.id}"]`); await card.waitFor();
      assert.equal(await card.getByRole('button', { name: 'Пауза', exact: true }).count(), 0);
      await card.getByRole('button', { name: cancel ? 'Отменить и удалить временные данные' : 'Остановить и сохранить', exact: true }).click();
      const finished = await waitJob(page, created.id, j => cancel ? j?.state === 'cancelled' : j?.state.startsWith('completed') || j?.state === 'failed');
      assert.equal(finished.state, cancel ? 'cancelled' : 'completed');
      if (!cancel) {
        const outputs = await retain(finished, 'live');
        const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outputs[0]], { encoding: 'utf8' }));
        assert(probe.streams.some(s => s.codec_name === 'h264')); assert(probe.streams.some(s => s.codec_name === 'aac')); assert(Math.abs(Number(probe.format.duration) - 4) < 0.5);
        results.push({ browser, id: 'popup-manager-real-short-live-stop-finalize', status: 'passed', outputs, duration: probe.format.duration, scope: 'Short fixed-window synthetic live, NOT 15-minute sliding-window acceptance' });
      } else {
        assert.equal(finished.outputs.filter(o => o.state === 'saved').length, 0);
        assert.equal((await command(page, 'GET_STORAGE_USAGE')).temporaryBytes, 0);
        results.push({ browser, id: 'popup-manager-real-short-live-cancel-delete', status: 'passed' });
      }
    } finally { await manager.close(); }
  }
}
