import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export async function settingsUiChecks({ page, command, results, browser }) {
  const initial = await command(page, 'GET_SETTINGS');
  const reload = async () => { await page.reload(); await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).waitFor(); };
  try {
    await reload();
    await page.locator('input[name=filenameTemplate]').fill('{not_a_token}');
    await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
    await page.locator('#status[role=alert]').waitFor();
    assert.equal((await command(page, 'GET_SETTINGS')).revision, initial.revision);
    await page.locator('input[name=filenameTemplate]').fill('{title} [{audioLang}]');
    await page.locator('input[name=directory]').fill('ui-settings');
    await page.locator('input[name=audioLanguages]').fill('en, ru');
    await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
    await page.getByText('Настройки сохранены.', { exact: true }).waitFor();
    const edited = await command(page, 'GET_SETTINGS');
    assert.equal(edited.settings.relativeDirectory, 'ui-settings'); assert.deepEqual(edited.settings.audioLanguages, ['en', 'ru']);
    const exportedPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Экспорт настроек JSON', exact: true }).click();
    const exported = await exportedPromise;
    const exportedText = await readFile(await exported.path(), 'utf8');
    assert.deepEqual(JSON.parse(exportedText), edited.settings);
    assert(!/LMD_TEST_SECRET|sourceRef|exactUrl|Cookie|Authorization|jobId/.test(exportedText));
    // Allowlisted import rejects secrets/unknown keys without even asking consent.
    await page.locator('input[name=importSettings]').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...edited.settings, jobs: [], exactUrl: 'https://fixture.invalid/?token=TEST' })) });
    await page.locator('#status[role=alert]').waitFor();
    assert.equal((await command(page, 'GET_SETTINGS')).revision, edited.revision);
    const importedSettings = { ...edited.settings, relativeDirectory: 'ui-imported', audioLanguages: ['ru', 'en'] };
    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('input[name=importSettings]').setInputFiles({ name: 'cancelled.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(importedSettings)) });
    // Wait for the real Page dialog dismissal before checking the stable revision.
    await page.evaluate(() => new Promise(r => setTimeout(r, 100)));
    assert.equal((await command(page, 'GET_SETTINGS')).revision, edited.revision);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('input[name=importSettings]').setInputFiles({ name: 'accepted.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(importedSettings)) });
    await page.waitForFunction(() => document.querySelector('input[name=directory]')?.value === 'ui-imported');
    assert.deepEqual((await command(page, 'GET_SETTINGS')).settings, importedSettings);
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: 'Сброс настроек', exact: true }).click();
    assert.deepEqual((await command(page, 'GET_SETTINGS')).settings, importedSettings);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Сброс настроек', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[name=directory]')?.value === '');
    assert.equal((await command(page, 'GET_SETTINGS')).settings.jobsConcurrency, 2);
    assert.equal((await command(page, 'GET_SETTINGS')).settings.relativeDirectory, '');
    results.push({ browser, id: 'options-real-edit-export-import-reset-confirmation', status: 'passed', scope: 'Actual UI and coordinator; JS confirm dialogs only, NOT native host permission/Save As consent' });
  } finally {
    const current = await command(page, 'GET_SETTINGS');
    await command(page, 'UPDATE_SETTINGS', { expectedRevision: current.revision, settings: initial.settings });
    await reload();
  }
}

export async function storageUsageCheck({ page, command, results, browser }) {
  const initial = await command(page, 'GET_STORAGE_USAGE');
  const namespace = `usage-test-${crypto.randomUUID()}`;
  try {
    await page.evaluate(async namespace => {
      const root = await navigator.storage.getDirectory();
      const jobs = await root.getDirectoryHandle('jobs', { create: true });
      const job = await jobs.getDirectoryHandle(namespace, { create: true });
      const attempt = await job.getDirectoryHandle('attempt-1', { create: true });
      const nested = await attempt.getDirectoryHandle('segments', { create: true });
      for (const [dir, name, size] of [[attempt, 'one', 5], [nested, 'two', 7], [nested, 'three', 11], [root, namespace, 19]]) {
        const writable = await (await dir.getFileHandle(name, { create: true })).createWritable(); await writable.write(new Uint8Array(size)); await writable.close();
      }
    }, namespace);
    const usage = await command(page, 'GET_STORAGE_USAGE');
    assert.equal(usage.temporaryBytes, initial.temporaryBytes + 23);
    results.push({ browser, id: 'temporary-byte-count-excludes-IDB-and-non-job-OPFS', status: 'passed', before: initial.temporaryBytes, actual: usage.temporaryBytes, expectedAdded: 23, ignoredNonJobBytes: 19 });
  } finally {
    await page.evaluate(async namespace => {
      const root = await navigator.storage.getDirectory();
      await (await root.getDirectoryHandle('jobs')).removeEntry(namespace, { recursive: true });
      await root.removeEntry(namespace);
    }, namespace);
  }
  assert.equal((await command(page, 'GET_STORAGE_USAGE')).temporaryBytes, initial.temporaryBytes);
}
