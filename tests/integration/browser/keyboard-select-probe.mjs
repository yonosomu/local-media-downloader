import { chromium } from 'playwright';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
// Read-only diagnosis of headless HTML select keyboard behavior, not browser chrome.
const scratch = path.join(process.cwd(), '.test-data/keyboard-select-probe');
await mkdir(scratch, { recursive: true });
for (const [browser, executablePath] of Object.entries({ chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' })) {
  const profile = await mkdtemp(path.join(scratch, `${browser}-`));
  const instance = await chromium.launchPersistentContext(profile, {executablePath, headless:true});
  try {
    const page = await instance.newPage();
    for (const keys of [['Space','ArrowDown','Enter'],['ArrowDown','Enter'],['a','Enter'],['End','Enter']]) {
      await page.setContent('<label>Filter<select><option value="all">Все</option><option value="active">Активные</option><option value="completed">Завершено</option><option value="errors">Ошибки</option></select></label>');
      await page.evaluate(()=>{ window.observed=[]; for(const type of ['keydown','keyup','input','change']) document.querySelector('select').addEventListener(type,e=>window.observed.push({type,key:e.key,value:e.target.value})); });
      await page.locator('select').focus();
      for (const key of keys) await page.keyboard.press(key);
      await page.waitForTimeout(300);
      console.log(JSON.stringify({browser,profile,version:instance.browser().version(),keys,...await page.evaluate(()=>({value:document.querySelector('select').value,events:window.observed}))}));
    }
  } finally {await instance.close();}
}
