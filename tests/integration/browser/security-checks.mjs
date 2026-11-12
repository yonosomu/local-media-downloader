import assert from 'node:assert/strict';

export async function securityChecks({ page, command, slowPayload, tabId, requests, results, browser }) {
  const before = requests.length;
  const rejected = await page.evaluate(async ({ tabId, payload }) => {
    const envelope = (type, payload) => ({ version: 1, requestId: crypto.randomUUID(), type, payload });
    const replies = [];
    const invalid = [
      { ...envelope('GET_TAB_MEDIA', { tabId }), version: 2 },
      envelope('CREATE_JOB', { ...payload, url: 'https://fixture.invalid/arbitrary.mp4' }),
      envelope('CREATE_JOB', { ...payload, selection: { ...payload.selection, audioTrackId: 'forged-track' } }),
      envelope('CREATE_JOB', { ...payload, output: { ...payload.output, relativeDirectory: '../escape' } }),
      envelope('CREATE_JOB', { ...payload, expectedCandidateRevision: payload.expectedCandidateRevision + 1000 }),
      envelope('DISCOVERY_HINT', { generation: 1, documentKey: 'forged', kind: 'video', url: 'https://fixture.invalid/arbitrary.mp4' })
    ];
    for (const message of invalid) replies.push(await chrome.runtime.sendMessage(message));
    // Same extension ID is insufficient: a real isolated content context on an
    // allowed page is not trusted extension UI, even with a valid CREATE payload.
    const [content] = await chrome.scripting.executeScript({ target: { tabId }, func: async payload => {
      return chrome.runtime.sendMessage({ version: 1, requestId: crypto.randomUUID(), type: 'CREATE_JOB', payload });
    }, args: [payload] });
    replies.push(content.result);
    // UI may not impersonate the host and drive privileged engine event handling.
    let hostReply;
    try { hostReply = await chrome.runtime.sendMessage({ version: 1, requestId: crypto.randomUUID(), target: 'coordinator', type: 'ENGINE_EVENT', payload: { type: 'EXPORT_READY', jobId: 'forged', attempt: 1, runEpoch: 1, revision: 1, payload: {} } }); } catch { hostReply = undefined; }
    return { replies, hostReply };
  }, { tabId, payload: slowPayload });
  assert(rejected.replies.every(r => r?.ok === false));
  assert(rejected.replies.every(r => ['INVALID_REQUEST', 'INVALID_STATE'].includes(r.error.code)));
  assert.equal(rejected.hostReply, undefined);
  const local = await page.evaluate(async () => (await chrome.storage.local.get('localModeOrigins')).localModeOrigins);
  try {
    await page.evaluate(() => chrome.storage.local.set({ localModeOrigins: [] }));
    await assert.rejects(() => command(page, 'CREATE_JOB', slowPayload));
  } finally { await page.evaluate(localModeOrigins => chrome.storage.local.set({ localModeOrigins }), local); }
  const settings = await command(page, 'GET_SETTINGS');
  await assert.rejects(() => command(page, 'UPDATE_SETTINGS', { expectedRevision: settings.revision, settings: { ...settings.settings, permissionMode: 'all_http_https' } }));
  assert.equal((await command(page, 'GET_SETTINGS')).settings.permissionMode, 'selected_sites');
  assert.equal(requests.length, before, 'Rejected commands caused network traffic');
  results.push({ browser, id: 'negative-sender-schema-source-permission-no-fetch', status: 'passed', rejectedMessages: rejected.replies.length, localAuthorityRemoved: true, globalAccessWithoutGrantRejected: true });
}

export async function actualReloadCheck({ page, context, id, command, results, browser }) {
  const s = await command(page, 'GET_SETTINGS');
  await command(page, 'UPDATE_SETTINGS', { expectedRevision: s.revision, settings: { ...s.settings, relativeDirectory: 'reload-preserved' } });
  // Real extension reload. No CDP unload/reinstall and no test manifest change.
  await page.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 0); });
  await new Promise(r => setTimeout(r, 1000));
  const reopened = await context.newPage();
  try {
    await reopened.goto(`chrome-extension://${id}/ui/options/index.html`);
    const after = await command(reopened, 'GET_SETTINGS');
    assert.equal(after.settings.relativeDirectory, 'reload-preserved');
    assert.equal(await reopened.evaluate(() => chrome.runtime.id), id);
    assert.deepEqual(await reopened.evaluate(async () => (await chrome.permissions.getAll()).origins ?? []), []);
    results.push({ browser, id: 'actual-dist-runtime-reload-stable-ID-settings', status: 'passed', extensionId: id, scope: 'chrome.runtime.reload, actual dist, no active job; manual Developer-mode Reload and old-schema migration remain separate' });
  } catch (error) {
    if (!error.message.includes('ERR_BLOCKED_BY_CLIENT')) throw error;
    results.push({ browser, id: 'actual-dist-runtime-reload-stable-ID-settings', status: 'blocked', extensionId: id, error: error.message, scope: 'Actual dist runtime.reload makes CDP-loaded extension URL unavailable. No reload success claimed; manual Developer mode Reload required. No CDP re-install substituted for this check.' });
  } finally { await reopened.close(); }
}

export async function observeObjectUrls({ cdp, targetClient, id }) {
  const target = (await cdp.send('Target.getTargets')).targetInfos.find(t => t.url === `chrome-extension://${id}/offscreen/host.html`);
  assert(target);
  const client = await targetClient(cdp, target.targetId);
  const evaluate = async expression => {
    const result = await client('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  // Transparent native-call instrumentation in this test host, before exports.
  await evaluate(`(() => {
    const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
    const active = new Set(); let created = 0, revoked = 0;
    URL.createObjectURL = function(...args) { const url = Reflect.apply(create, this, args); active.add(url); created++; return url; };
    URL.revokeObjectURL = function(url) { Reflect.apply(revoke, this, [url]); if (active.delete(url)) revoked++; };
    globalThis.objectUrlTestStats = () => ({created, revoked, active: active.size});
  })()`);
  return async () => evaluate('globalThis.objectUrlTestStats()');
}
