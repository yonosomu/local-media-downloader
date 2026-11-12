import type { MediaCandidate, SettingsV1, Selection } from '../../shared/contracts';
import { selectPreferred } from '../../core/selection';
import { canonicalCodec, containersFor } from '../../shared/capabilities';
import { outputName, safeComponent } from '../../core/filename';
import { captureDraft, restoreDraft, type FormDraft } from '../draft';
import { preserveFocus } from '../focus';
import { t, node, button, field, select, send, setup, showError, showStatus, events, grant } from '../common';
const main = setup(), cards = node('section', undefined, main), jobs = node('section', undefined, main), states = new Map<string, { revision: number; element: HTMLElement }>();
let tabId: number | undefined, settings: SettingsV1;
async function load(): Promise<void> {
  if (tabId === undefined) { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = tab?.id; }
  if (tabId === undefined) return;
  const data = await send<{ revision: number; candidates: MediaCandidate[]; discoveryState: string; origin?: string; requiredOrigins: string[]; enabled: boolean; siteEnabled: boolean }>('GET_TAB_MEDIA', { tabId });
  const record = await send<{ revision: number; settings: SettingsV1 }>('GET_SETTINGS'); settings = record.settings;
  let head = document.getElementById('site');
  if (!head) { head = node('section', undefined); head.id = 'site'; main.prepend(head); }
  const restoreHeaderFocus = preserveFocus(head);
  head.replaceChildren();
  node('p', data.origin ?? t('unknown'), head);
  const enabled = field('discovery', head, 'checkbox', String(data.enabled)); enabled.onchange = () => { void send('UPDATE_SETTINGS', { expectedRevision: record.revision, settings: { ...settings, discoveryEnabled: enabled.checked } }).then(load).catch(showError); };
  const site = field('siteDiscovery', head, 'checkbox', String(data.siteEnabled)); site.onchange = () => { if (data.origin) void send('UPDATE_SETTINGS', { expectedRevision: record.revision, settings: { ...settings, siteDiscovery: { ...settings.siteDiscovery, [new URL(data.origin).hostname]: site.checked } } }).then(load).catch(showError); };
  if (data.discoveryState === 'permission_required' && data.origin) button('grant', head, async () => { await grant(data.origin!); await load(); });
  for (const origin of data.requiredOrigins) { const p = node('p', origin, head); button('grant', p, async () => { await grant(origin); await load(); }); }
  restoreHeaderFocus();
  if (!data.candidates.length) { cards.replaceChildren(); states.clear(); node('p', t(data.discoveryState), cards); }
  else {
    for (const [id, card] of states) if (!data.candidates.some(c => c.id === id)) { card.element.remove(); states.delete(id); }
    if (!states.size) cards.replaceChildren();
    for (const candidate of data.candidates) {
      const old = states.get(candidate.id);
      if (old && old.revision === candidate.revision) continue;
      const restoreCardFocus = preserveFocus(cards);
      const element = render(candidate, old ? captureDraft(old.element) : undefined);
      if (old) old.element.replaceWith(element); else cards.append(element);
      restoreCardFocus();
      states.set(candidate.id, { revision: candidate.revision, element });
    }
  }
  const active = await send<{ jobs: { outputName: string; state: string }[] }>('GET_JOBS', { filter: 'active', limit: 10 });
  jobs.replaceChildren(); for (const j of active.jobs) node('p', `${j.outputName}: ${t(j.state)}`, jobs);
}
function render(c: MediaCandidate & { originalSuffix?: string }, draft?: FormDraft): HTMLElement {
  const card = node('article'); card.dataset.candidateId = c.id;
  node('h2', c.title, card); node('p', `${c.sourceOrigin} · ${c.protocol.toUpperCase()} · ${c.duration === undefined ? t('unknown') : `${c.duration.toFixed(1)} s`} · ${c.size ? `${c.size.estimated ? t('estimated') + ' ' : ''}${c.size.bytes} ${t('bytes')}` : t('unknown')}`, card);
  if (c.support !== 'supported') { node('p', c.unsupportedReason ?? t('busy'), card); return card; }
  let preferred;
  try { preferred = selectPreferred({ ...c, containers: c.capabilities.containers }, { ...settings, quality: settings.quality.mode === 'manual' ? { mode: 'best' } : settings.quality }); }
  catch { node('p', t('unsupported'), card); return card; }
  if (preferred.languageFallback) node('p', t('fallback'), card);
  const selection: Selection = preferred.selection;
  const variant = select('quality', card, c.variants.map(v => ({ value: v.id, label: `${v.height ? v.height + 'p' : t('unknown')} · ${v.bitrate ?? t('unknown')} bit/s · ${v.codecs.join('/')} · ${v.fps ?? '?'} FPS ${v.hdr ?? ''}` })), selection.variantId);
  const audio = select('audio', card, c.audioTracks.map(a => ({ value: a.id, label: `${a.label} [${a.language ?? 'und'}] ${a.role ?? ''} ${a.channels ?? '?'} ch · ${a.bitrate ?? '?'} bit/s` })), selection.audioTrackId);
  audio.disabled = !c.audioTracks.length;
  const audioOnly = field('audioOnly', card, 'checkbox', 'false');
  audioOnly.disabled = c.protocol === 'direct'; // Direct is byte-for-byte, not audio extraction.
  const container = select('container', card, [], selection.container);
  const subtitles = node('fieldset', undefined, card); node('legend', t('subtitles'), subtitles);
  const subs = c.subtitleTracks.map(track => { const input = field(`${track.label} [${track.language ?? 'und'}]`, subtitles, 'checkbox', String(selection.subtitleTrackIds.includes(track.id))); input.name = `subtitle:${track.id}`; return { id: track.id, input }; });
  const name = field('name', card), directory = field('directory', card, 'text', settings.siteDirectories[new URL(c.sourceOrigin).hostname] ?? settings.relativeDirectory), saveAs = field('saveAs', card, 'checkbox', 'false');
  const duration = c.isLive ? field('liveDuration', card, 'number', String(settings.liveMaxDurationSeconds ?? '')) : undefined;
  const bytes = c.isLive ? field('liveBytes', card, 'number', String(settings.liveMaxBytes ?? '')) : undefined;
  if (c.isLive) node('p', t('liveInfo'), card);
  function update(): void {
    const v = c.variants.find(v => v.id === variant.value), a = c.audioTracks.find(a => a.id === audio.value);
    const codecs = [...(!audioOnly.checked ? v?.codecs ?? [] : !a ? (v?.codecs ?? []).filter(c => ['aac', 'opus', 'mp3'].includes(canonicalCodec(c))) : []), ...(a?.codec ? [a.codec] : [])];
    const allowed = c.protocol === 'direct' ? ['original'] : codecs.length ? containersFor(codecs) : c.capabilities.containers;
    const previous = container.value || selection.container; container.replaceChildren(); for (const value of allowed) { const o = node('option', value, container); o.value = value; } if (allowed.includes(previous)) container.value = previous;
    name.value = outputName(settings.filenameTemplate, { title: c.title, site: new URL(c.sourceOrigin).hostname, date: new Date().toISOString().slice(0, 10), height: v?.height, audioLang: a?.language, id: c.id.slice(0, 8) }, container.value === 'original' ? c.originalSuffix ?? 'media' : container.value || 'media');
  }
  variant.onchange = () => { update(); start.disabled = !container.options.length; }; audio.onchange = variant.onchange; audioOnly.onchange = variant.onchange; container.onchange = () => { name.value = safeComponent(name.value.replace(/\.[^.]+$/, '')) + '.' + container.value; }; update();
  if (draft) {
    restoreDraft(card, draft, ['quality', 'audio', 'audioOnly']);
    update();
    restoreDraft(card, draft);
    // Keep a custom filename only when its selected container still exists.
    if (draft.container?.value !== container.value) name.value = safeComponent(name.value.replace(/\.[^.]+$/, '')) + '.' + (container.value === 'original' ? c.originalSuffix ?? 'media' : container.value || 'media');
  }
  const start = button(c.isLive ? 'record' : 'download', card, async () => {
    start.disabled = true;
    try {
      const selected: Selection = { audioOnly: audioOnly.checked, container: container.value as Selection['container'], subtitleTrackIds: subs.filter(s => s.input.checked).map(s => s.id), ...(variant.value ? { variantId: variant.value } : {}), ...(audio.value ? { audioTrackId: audio.value } : {}) };
      await send('CREATE_JOB', { candidateId: c.id, expectedCandidateRevision: c.revision, selection: selected, output: { name: name.value, relativeDirectory: directory.value, saveAs: saveAs.checked }, ...(c.isLive ? { liveLimits: { ...(duration?.value ? { durationSeconds: Number(duration.value) } : {}), ...(bytes?.value ? { bytes: Number(bytes.value) } : {}) } } : {}) }); showStatus(t('queued')); await load();
    } finally { start.disabled = false; }
  });
  start.disabled = !container.options.length;
  return card;
}
button('refresh', main, load); events(() => { void load().catch(showError); }); void load().catch(showError);
