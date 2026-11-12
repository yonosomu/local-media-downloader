import { test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

test('installed Chrome and Brave: no-host startup and component host lifecycle', async () => {
  // Build is an explicit prerequisite, as for the existing engine harness.
  // The script preserves actual-dist vs required-host component boundaries.
  const report = 'docs/evidence/t_8590b0cf/webrequest-startup.json';
  execFileSync(process.execPath, ['tests/integration/browser/webrequest-startup.mjs'], {
    env: { ...process.env, LMD_WEBREQUEST_REPORT: report }, timeout: 120000, stdio: 'pipe'
  });
  const { results } = JSON.parse(await readFile(report, 'utf8'));
  expect(results).toHaveLength(4);
  for (const browser of ['chrome', 'brave']) {
    for (const mode of ['actual-no-host', 'component-required-host']) {
      expect(results.find(result => result.browser === browser && result.mode === mode)?.status).toBe('passed');
    }
  }
}, 150000);
