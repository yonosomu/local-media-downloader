import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, cp } from 'node:fs/promises';
import path from 'node:path';
const root = path.dirname(new URL(import.meta.url).pathname);
const servers = [];
async function serve(handler) {
  const server = createServer(handler); servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
const cdn = await serve((req, res) => {
  if (req.url === '/login') { res.setHeader('Set-Cookie', 'lmd_fixture=session; HttpOnly; SameSite=Lax; Path=/'); res.end('fixture session created'); return; }
  if (req.headers.cookie !== 'lmd_fixture=session') { res.writeHead(401); res.end('fixture login required'); return; }
  res.setHeader('Content-Type', 'video/mp4'); res.end('authorized synthetic payload');
});
const origin = await serve((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<iframe src="${cdn}/login"></iframe><video src="${cdn}/media"></video>`); });
const results = [];
try {
  for (const [name, executablePath] of Object.entries({ chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' })) {
    const profile = await mkdtemp('/Users/philiprichard/.hermes/cache/scratch/lmd-auth-');
    const context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, timeout: 25000, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
    try {
      const cdp = await context.browser().newBrowserCDPSession();
      const extensionPath = await mkdtemp('/Users/philiprichard/.hermes/cache/scratch/lmd-auth-ext-');
      await cp(path.join(root, 'extension'), extensionPath, { recursive: true });
      const { id } = await cdp.send('Extensions.loadUnpacked', { path: extensionPath });
      let control = await context.newPage(); await control.goto(`chrome-extension://${id}/control.html`);
      const first = await control.evaluate(url => chrome.runtime.sendMessage({ type: 'GATE_AUTH', url }), `${cdn}/media`);
      assert.equal(first?.code, 'PERMISSION_REQUIRED');
      // This gate isolates browser session policy, not native permission UI.
      // Provision loopback host access on the disposable fixture build only.
      await cdp.send('Extensions.uninstall', { id });
      const manifestPath = path.join(extensionPath, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      manifest.host_permissions = ['http://127.0.0.1/*'];
      await writeFile(manifestPath, JSON.stringify(manifest));
      const reloaded = await cdp.send('Extensions.loadUnpacked', { path: extensionPath });
      assert.equal(reloaded.id, id);
      control = await context.newPage();
      await control.goto(`chrome-extension://${id}/control.html`);
      const noSession = await control.evaluate(url => chrome.runtime.sendMessage({ type: 'GATE_AUTH', url }), `${cdn}/media`);
      assert.equal(noSession.status, 401);
      const page = await context.newPage(); await page.goto(origin); await page.waitForLoadState('networkidle');
      const response = await control.evaluate(url => chrome.runtime.sendMessage({ type: 'GATE_AUTH', url }), `${cdn}/media`);
      assert.equal(response.status, 200);
      assert.equal(response.text, 'authorized synthetic payload');
      results.push({ browser: name, chromium: context.browser().version(), status: 'passed', origin, cdn, profile, scope: 'HttpOnly SameSite=Lax same-site cross-origin HTTP fixture, installation-provisioned loopback permission, no CORS override; native permission dialog NOT verified' });
      console.log(JSON.stringify(results.at(-1)));
    } catch (e) { results.push({ browser: name, status: 'failed', error: String(e) }); console.error(String(e)); }
    finally { await context.close(); }
  }
} finally { for (const server of servers) await new Promise(resolve => server.close(resolve)); }
await writeFile(path.join(root, 'evidence/auth-results.json'), JSON.stringify(results, null, 2));
assert(results.length === 2 && results.every(r => r.status === 'passed'));
