import { DEFAULT_SETTINGS } from '../shared/contracts';
import type { SettingsV1 } from '../shared/contracts';
import { validateSettings, object, exactKeys } from '../shared/validation';
import { fail } from '../shared/errors';
export interface SettingsRecord { schemaVersion: 1; revision: number; settings: SettingsV1 }
export async function readSettings(): Promise<SettingsRecord> {
  const { configuration } = await chrome.storage.local.get('configuration');
  if (configuration === undefined) return { schemaVersion: 1, revision: 0, settings: structuredClone(DEFAULT_SETTINGS) };
  const c = object(configuration); exactKeys(c, ['schemaVersion', 'revision', 'settings']);
  if (c.schemaVersion !== 1 || !Number.isSafeInteger(c.revision)) fail('INVALID_REQUEST');
  return { schemaVersion: 1, revision: c.revision as number, settings: validateSettings(c.settings) };
}
export async function writeSettings(expectedRevision: number, settings: unknown): Promise<SettingsRecord> {
  const old = await readSettings(); if (old.revision !== expectedRevision) fail('INVALID_STATE');
  const configuration: SettingsRecord = { schemaVersion: 1, revision: old.revision + 1, settings: validateSettings(settings) };
  if (configuration.settings.permissionMode === 'all_http_https' && !await chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] })) fail('PERMISSION_REQUIRED');
  await chrome.storage.local.set({ configuration }); return configuration;
}
