import { test, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

test('real engine/OPFS/IDB/remux files in installed Chrome and Brave', async () => {
  const evidence = 'docs/evidence/t_d2d10038'; await mkdir(evidence, { recursive: true });
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['tests/integration/engine/browser-component.mjs'], { cwd: process.cwd(), env: process.env });
    let log = ''; child.stdout.on('data', data => { log += String(data); }); child.stderr.on('data', data => { log += String(data); });
    child.on('error', reject); child.on('close', code => resolve({ code, log }));
  });
  await writeFile(`${evidence}/integration-vitest.log`, result.log);
  expect(result.code, result.log).toBe(0);
  const cases = JSON.parse(await readFile(`${evidence}/component-results.json`, 'utf8'));
  expect(cases.length).toBeGreaterThan(0);
  expect(cases.every(c => c.status === 'passed')).toBe(true);
  expect([...new Set(cases.map(c => c.browser))].sort()).toEqual(['brave', 'chrome']);
}, 300000);
