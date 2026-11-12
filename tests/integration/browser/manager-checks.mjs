import assert from 'node:assert/strict';

// Injected durable snapshots exercise real manager rendering/filters only.
// They never pass through engine execution or count as saved media evidence.
export async function managerChecks({ context, page, id, results, browser }) {
  const states = ['queued', 'resolving', 'downloading', 'paused', 'assembling', 'awaiting_export', 'exporting', 'completed', 'completed_with_warnings', 'failed', 'cancelled', 'interrupted'];
  const errors = ['PERMISSION_REQUIRED', 'AUTH_REQUIRED', 'URL_EXPIRED', 'NETWORK_TIMEOUT', 'NETWORK_OFFLINE', 'HTTP_ERROR', 'RATE_LIMITED', 'INVALID_MANIFEST', 'MANIFEST_LIMIT', 'UNSUPPORTED_FORMAT', 'ENCRYPTED_UNSUPPORTED', 'DRM_UNSUPPORTED', 'SEGMENT_MISSING', 'RESOURCE_CHANGED', 'QUOTA_EXCEEDED', 'DISK_WRITE_FAILED', 'MUX_FAILED', 'EXPORT_CANCELLED', 'BROWSER_UNSUPPORTED', 'SOURCE_TAB_REQUIRED'];
  const cases = [
    ...states.map(state => ({ key: state, state })),
    { key: 'pause-supported', state: 'downloading', pause: true },
    { key: 'resume-supported', state: 'paused', resume: true },
    { key: 'live', state: 'downloading', live: true },
    { key: 'partial-saved', state: 'failed', output: 'saved' },
    { key: 'cancelled-output', state: 'failed', output: 'cancelled' },
    { key: 'ready-output', state: 'awaiting_export', output: 'ready' },
    ...errors.map(error => ({ key: error, state: 'failed', error }))
  ];
  const inserted = await page.evaluate(async cases => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('lmd-v1', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const tx = db.transaction(['jobs', 'exports'], 'readwrite');
    const done = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error); });
    const records = cases.map(c => {
      const id = crypto.randomUUID();
      tx.objectStore('jobs').put({ schemaVersion: 1, id, requestId: crypto.randomUUID(), candidateId: 'test-only', state: c.state,
        selection: { container: 'original', audioOnly: false, subtitleTrackIds: [] }, outputName: `${c.key}.mp4`,
        createdAt: Date.now(), updatedAt: Date.now(), bytesWritten: 100, attempt: 1, revision: 1, runEpoch: 1,
        capabilities: { pause: !!c.pause, resume: !!c.resume }, warnings: c.state === 'completed_with_warnings' ? [{ code: 'SEGMENT_MISSING', message: 'Sidecar warning', retryable: false }] : [],
        outputs: c.output ? [{ part: 1, name: 'output.mp4', mime: 'video/mp4', bytes: 100, state: c.output }] : [],
        ...(c.error ? { error: { code: c.error, message: 'Safe UI diagnostic', retryable: false } } : {}) });
      tx.objectStore('exports').put({ id: `context:${id}`, title: `UI-${c.key}`, domain: 'fixture.invalid', sourceRef: 'test-only', relativeDirectory: '', saveAs: false, isLive: !!c.live });
      return { ...c, id };
    });
    await done; db.close(); return records;
  }, cases);
  const manager = await context.newPage();
  try {
    await manager.goto(`chrome-extension://${id}/ui/manager/index.html`);
    for (const c of inserted) {
      const card = manager.locator(`article[data-job-id="${c.id}"]`); await card.waitFor();
      const names = await card.getByRole('button').allTextContents();
      const expected = [];
      if (c.pause) expected.push('Пауза');
      if (c.resume) expected.push('Продолжить');
      if (c.live) expected.push('Остановить и сохранить');
      if (['queued', 'resolving', 'downloading', 'paused', 'assembling', 'awaiting_export', 'exporting'].includes(c.state)) expected.push('Отменить и удалить временные данные');
      if (['failed', 'interrupted'].includes(c.state) && c.output !== 'saved') expected.push('Повторить');
      assert.deepEqual(names, expected, `Wrong actions for ${c.key}`);
      if (c.error) assert((await card.innerText()).includes(c.error));
      if (c.output === 'cancelled') assert((await card.innerText()).includes('output.mp4 · 100 байт · Отменено'), 'Cancelled output shown as exporting');
      if (c.output === 'ready') assert((await card.innerText()).includes('output.mp4 · 100 байт · Файл готов, ожидает сохранения'), 'Ready output shown as exporting');
      assert.equal(await card.locator('img, script').count(), 0);
    }
    for (const filter of ['active', 'completed', 'errors', 'all']) {
      await manager.getByLabel('Фильтр').selectOption(filter);
      const expected = inserted.filter(c => filter === 'all' || filter === 'active' && ['queued', 'resolving', 'downloading', 'paused', 'assembling', 'awaiting_export', 'exporting'].includes(c.state) || filter === 'completed' && c.state.startsWith('completed') || filter === 'errors' && ['failed', 'interrupted'].includes(c.state)).map(c => c.id).sort();
      await manager.waitForFunction(({ ids }) => ids.every(id => document.querySelector(`article[data-job-id="${id}"]`)) && Array.from(document.querySelectorAll('article')).filter(c => ids.includes(c.dataset.jobId)).length === ids.length, { ids: expected });
      const visible = await manager.locator('article').evaluateAll(cards => cards.map(c => c.dataset.jobId));
      assert.deepEqual(visible.filter(id => inserted.some(c => c.id === id)).sort(), expected);
    }
    results.push({ browser, id: 'manager-all-states-errors-capabilities-output-filters', status: 'passed', cases: inserted.length, errors: errors.length, scope: 'Injected IDB snapshots, real UI and coordinator; no engine execution claimed' });
  } finally {
    await manager.close();
    await page.evaluate(async ids => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('lmd-v1', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const tx = db.transaction(['jobs', 'exports'], 'readwrite'); const done = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error); });
      for (const id of ids) { tx.objectStore('jobs').delete(id); tx.objectStore('exports').delete(`context:${id}`); }
      await done; db.close();
    }, inserted.map(c => c.id));
  }
}
