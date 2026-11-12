// Native UX helper: only connects to the two owned run111 CDP ports.
import { chromium } from 'playwright';
const [port, action, value] = process.argv.slice(2);
if (!['19312', '19313'].includes(port)) throw new Error('Owned run111 port required');
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
try {
  const context = browser.contexts()[0];
  const page = context.pages()[0];
  if (action === 'goto') await page.goto(value);
  else if (action !== 'inspect') throw new Error('Unknown action');
  console.log(JSON.stringify({ pages: context.pages().map(p => p.url()), title: await page.title(), body: await page.locator('body').innerText() }, null, 2));
} finally { await browser.close({ reason: 'Disconnect CDP client only' }); }
