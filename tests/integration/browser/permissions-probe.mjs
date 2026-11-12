import { chromium } from 'playwright';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
const results = [];
const headed = process.env.LMD_HEADED === '1';
for (const [browser, executablePath] of Object.entries({ chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' })) {
  const profile = await mkdtemp(path.resolve('.test-data/browser/permission-probe-'));
  const context = await chromium.launchPersistentContext(profile, { executablePath, headless: !headed, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
  try {
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: path.resolve('dist') });
    const page = await context.newPage(); await page.goto(`chrome-extension://${id}/ui/options/index.html`);
    await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).waitFor();
    await page.evaluate(() => {
      const button = document.createElement('button'); button.id = 'permission-probe'; button.textContent = 'Probe scoped native grant';
      button.onclick = () => { document.body.dataset.permissionResult = 'pending'; void chrome.permissions.request({ origins: ['https://example.com/*'] }).then(granted => { document.body.dataset.permissionResult = JSON.stringify(granted); }, error => { document.body.dataset.permissionResult = `error: ${error.message}`; }); };
      document.body.append(button);
    });
    await page.locator('#permission-probe').click();
    let timeout;
    try { await page.waitForFunction(() => document.body.dataset.permissionResult !== 'pending', null, { timeout: 10000 }); }
    catch (error) { timeout = error.message; }
    const requestResult = await page.evaluate(() => document.body.dataset.permissionResult);
    const permissions = await page.evaluate(() => chrome.permissions.getAll());
    results.push({ browser, mode: headed ? 'isolated headed' : 'isolated headless', status: requestResult === 'true' ? 'passed' : 'blocked', requestResult, timeout, permissions, scope: 'Actual dist; real click; no global browser flags, policy or personal profile changes' });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
}
await writeFile(`docs/evidence/t_8590b0cf/native-permission-probe${headed ? '-headed' : ''}.json`, JSON.stringify({ results }, null, 2));
console.log(JSON.stringify(results, null, 2));
