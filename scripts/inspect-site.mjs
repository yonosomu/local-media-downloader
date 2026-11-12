import { chromium } from 'playwright';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const evidence = path.resolve('docs/site-evidence');
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp('/Users/philiprichard/.hermes/cache/scratch/lmd-site-');
const context = await chromium.launchPersistentContext(profile, { executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true, timeout: 25000 });
const observations = [];
function safeJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'string' && /^https?:\/\//.test(item)) {
      const url = new URL(item); url.search = ''; url.username = ''; url.password = '';
      return url.href;
    }
    return item;
  }, 2);
}
try {
  const page = await context.newPage();
  const target = process.env.LMD_SITE_URL || 'https://1fanserials.org/';
  const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2000);
  observations.push({ step: 'homepage', status: response?.status(), url: page.url(), title: await page.title(), links: await page.locator('a[href]').evaluateAll(nodes => nodes.map(a => ({ label: a.textContent.trim().slice(0, 160), url: a.href })).filter(a => a.label && a.url.startsWith('https://1fanserials.org/')).slice(0, 90)), frames: page.frames().map(f => f.url()) });
  const prefix = process.env.LMD_SITE_URL ? 'episode' : 'homepage';
  observations.push({ frames: await page.locator('iframe').evaluateAll(nodes => nodes.map(n => ({ src: n.getAttribute('src'), dataSrc: n.getAttribute('data-src') }))), buttons: await page.locator('button,[role="button"],.player').allTextContents() });
  await writeFile(path.join(evidence, `${prefix}.txt`), (await page.locator('body').innerText()).slice(0, 16000));
  await writeFile(path.join(evidence, `${prefix}-observations.json`), safeJson(observations));
  console.log(safeJson(observations));
} finally { await context.close(); }
