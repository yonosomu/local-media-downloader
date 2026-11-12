import type { JobSnapshot } from '../../shared/contracts';
import { preserveFocus } from '../focus';
import { t, node, button, select, send, setup, showError, showStatus, events } from '../common';
const main = setup(), filter = select('filter', main, ['all', 'active', 'completed', 'errors'].map(value => ({ value, label: t(value) }))), list = node('section', undefined, main);
let cursor: string | undefined, loading = false;
const samples = new Map<string, { bytes: number; at: number }>();
async function load(append = false): Promise<void> {
  if (loading) return; loading = true;
  try {
    const data = await send<{ revision: number; jobs: (JobSnapshot & { title: string; domain: string; isLive: boolean })[]; nextCursor?: string }>('GET_JOBS', { filter: filter.value, limit: 100, ...(append && cursor ? { cursor } : {}) });
    const restoreFocus = preserveFocus(list, filter);
    if (!append) list.replaceChildren();
    cursor = data.nextCursor;
    for (const job of data.jobs) {
      const card = node('article', undefined, list); card.dataset.jobId = job.id;
      node('h2', job.title, card); node('p', `${job.domain} · ${job.outputName}`, card);
      node('p', t(job.state), card).setAttribute('role', 'status');
      const progress = node('progress', undefined, card); progress.setAttribute('aria-label', t(job.state));
      if (job.totalBytes) { progress.max = job.totalBytes; progress.value = job.bytesWritten; }
      else if (job.segmentsTotal) { progress.max = job.segmentsTotal; progress.value = job.segmentsDone ?? 0; }
      node('p', `${job.bytesWritten} ${t('bytes')} · ${job.segmentsDone ?? '?'} / ${job.segmentsTotal ?? '?'} ${t('segments')}`, card);
      const before = samples.get(job.id), now = Date.now();
      if (before && now > before.at && job.state === 'downloading' && job.bytesWritten > before.bytes) {
        const speed = (job.bytesWritten - before.bytes) * 1000 / (now - before.at); node('p', `${Math.round(speed)} ${t('speed')}${job.totalBytes ? ` · ${Math.ceil((job.totalBytes - job.bytesWritten) / speed)} ${t('eta')}` : ''}`, card);
      }
      samples.set(job.id, { bytes: job.bytesWritten, at: now });
      if (job.error) { node('p', `${job.error.code}: ${job.error.message}`, card); if (['URL_EXPIRED', 'AUTH_REQUIRED', 'PERMISSION_REQUIRED'].includes(job.error.code)) node('p', t('redetect'), card); }
      for (const warning of job.warnings) node('p', `${warning.code}: ${warning.message}`, card);
      for (const output of job.outputs) node('p', `${output.name} · ${output.bytes} ${t('bytes')} · ${t(output.state === 'ready' ? 'awaiting_export' : output.state)}`, card);
      const action = (label: string, type: string) => button(label, card, async () => { await send(type, { jobId: job.id, expectedRevision: job.revision }); showStatus(t('saved')); await load(); });
      if (job.capabilities.pause && job.state === 'downloading') action('pause', 'PAUSE_JOB');
      if (job.capabilities.resume && job.state === 'paused') action('resume', 'RESUME_JOB');
      if (job.isLive && job.state === 'downloading') action('stop', 'STOP_LIVE_AND_SAVE');
      if (['queued', 'resolving', 'downloading', 'assembling', 'awaiting_export', 'exporting', 'paused'].includes(job.state)) action('cancel', 'CANCEL_JOB');
      if (['failed', 'interrupted'].includes(job.state) && !job.outputs.some(o => o.state === 'saved')) action('retry', 'RETRY_JOB');
    }
    if (!data.jobs.length) node('p', t('noJobs'), list);
    more.hidden = !cursor;
    restoreFocus();
  } finally { loading = false; }
}
const more = button('more', main, () => load(true));
filter.onchange = () => { void load().catch(showError); }; button('refresh', main, () => load()); events(() => { void load().catch(showError); }); void load().catch(showError);
