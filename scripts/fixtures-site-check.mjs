import { chromium } from 'playwright';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const scratch = path.resolve('.test-data/fixtures-f');
await mkdir(scratch, { recursive: true });
const profile = await mkdtemp(path.join(scratch, 'public-site-'));
const target = 'https://1fanserials.org/958-hudson-rex-13/9-season/5-episode.html#player_ColdFilm';
const result = { checkedAt: new Date().toISOString(), target, scope: 'Публичная страница без входа; не проверка скачивания расширением', status: 'blocked', credentialsUsed: false };
let context;
try {
  context = await chromium.launchPersistentContext(profile, { executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true, timeout: 25000 });
  const page = await context.newPage();
  const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const body = await page.locator('body').innerText();
  result.httpStatus = response?.status();
  result.loginRequired = body.includes('Требуется вход в систему') && body.includes('Для доступа к видеоконтенту необходимо иметь учётную запись');
  result.actual = result.loginRequired ? 'Публичная страница требует входа; доступ к видеоконтенту не получен.' : 'Прежний текст входа не обнаружен; совместимость не подтверждена, требуется отдельное исследование без обхода доступа.';
  result.request = 'Подтвердите отдельный ручной вход в изолированном тестовом профиле и предоставьте доступный вам эпизод для проверки; пароль и cookies передавать не нужно.';
} catch {
  result.actual = 'Публичная страница не загружена; прежнее свидетельство требования входа сохранено в docs/site-evidence/episode.txt. Текущий доступ к видео не подтверждён.';
  result.networkCheckFailed = true;
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
await mkdir('docs/evidence/t_ab1783c7', { recursive: true });
await writeFile('docs/evidence/t_ab1783c7/site-check.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
// exit 0 означает запись честного отчёта, НЕ passed сайта.
