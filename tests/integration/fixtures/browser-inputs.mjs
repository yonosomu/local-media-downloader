import { chromium } from 'playwright';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startFixtureServer } from '../../../fixtures/server.mjs';
const scratch = path.resolve('.test-data/fixtures-f');
await mkdir(scratch, { recursive: true });
const fixture = await startFixtureServer({ scenarioId: 'F-browser-policies' });
const results = [];
const expectedHash = createHash('sha256').update(await readFile('.test-data/engine-component/media/source.mp4')).digest('hex');
const expectedFreshHash = createHash('sha256').update(await readFile('.test-data/fixtures-f/media/source.mp4')).digest('hex');
try {
  for (const [browser, executablePath] of Object.entries({ chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' })) {
    const profile = await mkdtemp(path.join(scratch, `${browser}-`)), extension = path.join(profile,'fixture-extension');
    await mkdir(extension);
    await writeFile(path.join(extension,'manifest.json'), JSON.stringify({ manifest_version:3, name:'LMD synthetic policy input check', version:'0.0.1', host_permissions:['http://127.0.0.1/*'] }));
    await writeFile(path.join(extension,'index.html'), '<!doctype html><title>Проверка synthetic входов</title>');
    let context;
    try {
      context = await chromium.launchPersistentContext(profile, { executablePath, headless:true, timeout:25000, ignoreDefaultArgs:['--disable-extensions'], args:['--enable-unsafe-extension-debugging'] });
      const cdp = await context.browser().newBrowserCDPSession();
      const {id} = await cdp.send('Extensions.loadUnpacked', {path:extension});
      const control = await context.newPage(); await control.goto(`chrome-extension://${id}/index.html`);
      const authStatus = () => control.evaluate(async origin => (await fetch(`${origin}/auth/media`,{credentials:'include'})).status, fixture.origins[1]);
      assert.equal(await authStatus(),401);
      const page = await context.newPage(); await page.goto(`${fixture.origins[0]}/auth/page`); await page.waitForLoadState('networkidle');
      assert.equal(await authStatus(),200);
      const copied = await control.evaluate(async origin => {
        const response = await fetch(`${origin}/auth/media`,{credentials:'include'});
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256',await response.arrayBuffer()))].map(b=>b.toString(16).padStart(2,'0')).join('');
        const redirect = await fetch(`${origin}/redirect`,{redirect:'manual',credentials:'include'});
        return { hash, redirectType:redirect.type, corsOverride:response.headers.has('access-control-allow-origin') };
      },fixture.origins[1]);
      assert.equal(copied.hash,expectedHash); assert.equal(copied.corsOverride,false); assert.equal(copied.redirectType,'opaqueredirect');
      const canonicalStatus = () => control.evaluate(async origin => (await fetch(`${origin}/auth/source.mp4`, { credentials: 'include' })).status, fixture.origins[1]);
      assert.equal(await canonicalStatus(), 401);
      await page.goto(`${fixture.origins[0]}/auth/login`);
      assert.equal(await canonicalStatus(), 200);
      const canonicalHash = await control.evaluate(async origin => {
        const response = await fetch(`${origin}/auth/source.mp4`, { credentials: 'include' });
        return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('');
      }, fixture.origins[1]);
      assert.equal(canonicalHash, expectedFreshHash);
      await page.goto(fixture.origins[0]); await page.waitForLoadState('networkidle');
      await page.locator('#lazy').click();
      await page.waitForFunction(origin => [...document.querySelectorAll('iframe')].some(f => f.src === `${origin}/frame`), fixture.origins[1]);
      await page.waitForLoadState('networkidle');
      assert(page.frames().some(f=>f.url()===`${fixture.origins[1]}/frame`));
      await page.locator('#spa').click(); assert.equal(await page.locator('video').count(),1); assert(page.url().endsWith('/?page=2'));
      const result = {browser,status:'passed',version:execFileSync(executablePath,['--version'],{encoding:'utf8'}).trim(),chromium:context.browser().version(),...copied,canonicalHash,scope:'Только входы/реальная HttpOnly SameSite=Lax same-site cross-origin политика; test extension с required host. Не actual dist/native grant/site acceptance.'};
      results.push(result); console.log(JSON.stringify(result));
    } finally { await context?.close(); await rm(profile,{recursive:true,force:true}); }
  }
} finally { await fixture.close(); }
assert.equal(results.length,2);
await writeFile('docs/evidence/t_ab1783c7/browser-inputs.json',JSON.stringify({checkedAt:new Date().toISOString(),results,requests:fixture.snapshot()},null,2));
