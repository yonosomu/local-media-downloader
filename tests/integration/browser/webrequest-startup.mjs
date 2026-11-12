import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// All installations/API grants below are explicitly COMPONENT tests in new
// headless profiles. Never native Load unpacked/optional-host consent evidence.
const root = process.cwd(), scratch = path.join(root, '.test-data/webrequest-startup');
await mkdir(scratch, { recursive: true });
const results = [];
for (const [browser, executablePath] of Object.entries({ chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' })) {
  for (const mode of ['actual-no-host', 'component-required-host']) {
    const profile = await mkdtemp(path.join(scratch, `${browser}-`));
    let extensionPath = path.join(root, 'dist');
    if (mode === 'component-required-host') {
      extensionPath = path.join(profile, 'component-dist');
      await cp(path.join(root, 'dist'), extensionPath, { recursive: true });
      const manifest = JSON.parse(await readFile(path.join(extensionPath, 'manifest.json'), 'utf8'));
      manifest.host_permissions = ['http://127.0.0.1/*'];
      await writeFile(path.join(extensionPath, 'manifest.json'), JSON.stringify(manifest));
    }
    const context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
    const result = { browser, mode, profile, version: context.browser().version(), scope: 'Component only: CDP install, actual no-host dist or explicitly required-host test copy. Native gates remain open.', observations: [], lifecycle: [] };
    try {
      const cdp = await context.browser().newBrowserCDPSession();
      const metadata = await context.newPage(); await metadata.goto('chrome://extensions/');
      // Error collection must be enabled BEFORE installation, otherwise an empty
      // runtimeErrors list is a false negative (initial run121 probe proved this).
      await metadata.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
      const { id } = await cdp.send('Extensions.loadUnpacked', { path: extensionPath });
      result.extensionId = id;
      const page = await context.newPage(); await page.goto(`chrome-extension://${id}/ui/options/index.html`);
      await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).waitFor();
      const settings = () => page.evaluate(() => chrome.runtime.sendMessage({ version: 1, requestId: crypto.randomUUID(), type: 'GET_SETTINGS', payload: {} }));
      const inspect = async phase => {
        await metadata.reload();
        await metadata.locator('extensions-item').filter({ hasText: 'Local Media Downloader' }).waitFor();
        const entry = await metadata.locator('extensions-item').evaluateAll((items, id) => {
          const data = items.find(item => item.data?.id === id)?.data;
          return data && { id: data.id, path: data.path, state: data.state, runtimeErrors: data.runtimeErrors, manifestErrors: data.manifestErrors };
        }, id);
        result.observations.push({ phase, entry });
      };
      const listenerState = async (phase, granted) => {
        const worker = context.serviceWorkers().find(w => w.url() === `chrome-extension://${id}/background/service-worker.js`);
        assert(worker, 'Product SW must be running');
        const state = await worker.evaluate(async () => ({ permissions: await chrome.permissions.getAll(), listeners: [chrome.webRequest.onBeforeRequest, chrome.webRequest.onCompleted, chrome.webRequest.onErrorOccurred, chrome.webRequest.onHeadersReceived].map(event => event.hasListeners()) }));
        result.lifecycle.push({ phase, ...state });
        assert.deepEqual(state.permissions.origins ?? [], granted ? ['http://127.0.0.1/*'] : []);
        assert(state.listeners.every(value => value === granted), `${phase}: listeners must follow actual grants`);
      };
      const restart = async () => {
        const workerCdp = await context.newCDPSession(page);
        await workerCdp.send('ServiceWorker.enable'); await workerCdp.send('ServiceWorker.stopAllWorkers'); await workerCdp.detach();
        await settings();
      };
      const granted = mode === 'component-required-host';
      await inspect('clean-startup');
      await listenerState('clean-startup', granted);
      await restart(); await listenerState('service-worker-restart', granted);
      await inspect('service-worker-restart');
      if (granted) {
        // Browser site-access controls for this required-host COMPONENT only.
        // No optional permission prompt is bypassed or claimed as accepted.
        await metadata.evaluate(id => chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, hostAccess: 'ON_CLICK' }), id);
        await page.waitForFunction(async () => !(await chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] })));
        await settings(); await listenerState('withheld', false);
        await metadata.evaluate(id => chrome.developerPrivate.addHostPermission(id, 'http://127.0.0.1/*'), id);
        await page.waitForFunction(async () => await chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] }));
        await settings(); await listenerState('api-grant', true);
        await restart(); await listenerState('granted-sw-restart', true);
        await metadata.evaluate(id => chrome.developerPrivate.removeHostPermission(id, 'http://127.0.0.1/*'), id);
        await page.waitForFunction(async () => !(await chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] })));
        await settings(); await listenerState('api-revoke', false);
        await restart(); await listenerState('revoked-sw-restart', false);
        await inspect('component-grant-restart-revoke');
      }
      assert(result.observations.every(o => o.entry && o.entry.manifestErrors.length === 0));
      assert.deepEqual(result.observations.flatMap(o => o.entry.runtimeErrors), [], 'No startup/restart/permission-lifecycle runtime errors');
      result.status = 'passed';
    } catch (error) { result.status = 'failed'; result.error = error.message; }
    finally { results.push(result); await context.close(); }
  }
}
const output = process.env.LMD_WEBREQUEST_REPORT ?? 'docs/evidence/t_8590b0cf/run121-webrequest-startup.json';
await writeFile(output, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
console.log(JSON.stringify(results, null, 2));
if (results.some(r => r.status !== 'passed')) process.exitCode = 1;
