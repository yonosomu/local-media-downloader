import type { SettingsV1, JobSnapshot } from '../../shared/contracts';
import { validateSettings } from '../../shared/validation';
import { preserveFocus } from '../focus';
import { t, node, button, field, select, send, setup, showError, showStatus, downloadJson } from '../common';
const main = setup();
let revision = 0, settings: SettingsV1;
async function load(): Promise<void> {
  const record = await send<{ revision: number; settings: SettingsV1 }>('GET_SETTINGS'); revision = record.revision; settings = record.settings;
  const restoreFocus = preserveFocus(main);
  main.replaceChildren();
  const form = node('form', undefined, main);
  const quality = select('quality', form, ['best', 'max_height', 'manual'].map(value => ({ value, label: t(value) })), settings.quality.mode), height = field('maxHeight', form, 'number', String(settings.quality.maxHeight ?? ''));
  const audio = field('audioLanguages', form, 'text', settings.audioLanguages.join(', ')), subs = field('subtitleLanguages', form, 'text', settings.subtitleLanguages.join(', '));
  const subtitles = field('subtitlesEnabled', form, 'checkbox', String(settings.subtitlesEnabled));
  const container = select('container', form, ['mp4', 'webm', 'mkv', 'm4a', 'mp3', 'original'].map(value => ({ value, label: value })), settings.container);
  const template = field('filenameTemplate', form, 'text', settings.filenameTemplate), directory = field('directory', form, 'text', settings.relativeDirectory);
  const directories = field('siteDirectories', form, 'text', JSON.stringify(settings.siteDirectories)), sites = field('siteDiscoveryMap', form, 'text', JSON.stringify(settings.siteDiscovery));
  const inputs = new Map<string, HTMLInputElement>();
  for (const key of ['jobsConcurrency', 'segmentsConcurrency', 'retries', 'firstByteTimeoutMs', 'stallTimeoutMs', 'historyMaxEntries', 'historyMaxDays'] as const) inputs.set(key, field(key, form, 'number', String(settings[key])));
  const liveDuration = field('liveDuration', form, 'number', String(settings.liveMaxDurationSeconds ?? '')), liveBytes = field('liveBytes', form, 'number', String(settings.liveMaxBytes ?? ''));
  const discovery = field('discovery', form, 'checkbox', String(settings.discoveryEnabled)), history = field('historyEnabled', form, 'checkbox', String(settings.historyEnabled));
  const save = button('save', form, async () => {
    const next = { ...settings, quality: { mode: quality.value, ...(height.value ? { maxHeight: Number(height.value) } : {}) }, audioLanguages: audio.value.split(',').map(s => s.trim()).filter(Boolean), subtitleLanguages: subs.value.split(',').map(s => s.trim()).filter(Boolean), subtitlesEnabled: subtitles.checked, container: container.value, filenameTemplate: template.value, relativeDirectory: directory.value, siteDirectories: JSON.parse(directories.value), siteDiscovery: JSON.parse(sites.value), discoveryEnabled: discovery.checked, historyEnabled: history.checked, ...Object.fromEntries([...inputs].map(([key, input]) => [key, Number(input.value)])) };
    delete next.liveMaxDurationSeconds; delete next.liveMaxBytes;
    if (liveDuration.value) next.liveMaxDurationSeconds = Number(liveDuration.value); if (liveBytes.value) next.liveMaxBytes = Number(liveBytes.value);
    await send('UPDATE_SETTINGS', { expectedRevision: revision, settings: validateSettings(next) }); showStatus(t('settingsSaved')); await load();
  }); save.type = 'button';
  node('p', t('historyInfo'), main);
  button('allAccess', main, async () => { if (!confirm(t('allAccessConfirm'))) return; if (!await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] })) throw new Error(t('denied')); await send('UPDATE_SETTINGS', { expectedRevision: revision, settings: { ...settings, permissionMode: 'all_http_https' } }); await load(); });
  button('selectedAccess', main, async () => { await chrome.permissions.remove({ origins: ['http://*/*', 'https://*/*'] }); await send('UPDATE_SETTINGS', { expectedRevision: revision, settings: { ...settings, permissionMode: 'selected_sites' } }); await load(); });
  node('h2', t('grantedSites'), main);
  const permissions = await chrome.permissions.getAll();
  for (const origin of permissions.origins ?? []) { const p = node('p', origin, main); button('revoke', p, async () => { await chrome.permissions.remove({ origins: [origin] }); await load(); }); }
  button('exportSettings', main, () => downloadJson('lmd-settings.json', settings));
  const importFile = field('importSettings', main, 'file'); importFile.accept = 'application/json,.json'; importFile.onchange = () => { void (async () => { const file = importFile.files?.[0]; if (!file) return; if (file.size > 65536) throw new Error(t('genericError')); const imported = validateSettings(JSON.parse(await file.text())); if (!confirm(t('importConfirm'))) return; await send('UPDATE_SETTINGS', { expectedRevision: revision, settings: imported }); await load(); })().catch(showError); };
  button('reset', main, async () => { if (confirm(t('resetConfirm'))) { await send('RESET_SETTINGS', { expectedRevision: revision, confirmed: true }); await load(); } });
  node('h2', t('storage'), main);
  const usage = await send<{ temporaryBytes: number; quotaBytes?: number; affectedJobIds: string[] }>('GET_STORAGE_USAGE');
  node('p', `${usage.temporaryBytes} / ${usage.quotaBytes ?? t('unknown')} ${t('bytes')}`, main);
  button('clear', main, async () => {
    const { jobs } = await send<{ jobs: JobSnapshot[] }>('GET_JOBS', { filter: 'all', limit: 100 });
    const ids = jobs.filter(j => ['failed', 'cancelled', 'completed', 'completed_with_warnings', 'interrupted', 'paused'].includes(j.state)).map(j => j.id);
    if (confirm(`${t('clearConfirm')}\n${ids.join('\n')}`)) { await send('CLEAR_TEMP', { jobIds: ids, confirmed: true }); await load(); }
  });
  const preview = node('section', undefined, main);
  button('diagnostics', main, async () => { const data = await send<{ previewId: string; redactedText: string }>('EXPORT_DIAGNOSTICS', { preview: true }); preview.replaceChildren(); const text = node('textarea', undefined, preview); text.readOnly = true; text.value = data.redactedText; text.setAttribute('aria-label', t('diagnostics')); button('exportDiagnostics', preview, () => send('EXPORT_DIAGNOSTICS', { preview: false, approvedPreviewId: data.previewId })); });
  restoreFocus();
}
void load().catch(showError);
