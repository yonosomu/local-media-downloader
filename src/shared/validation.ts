import type { Container, Selection, SettingsV1, JobState } from './contracts';
import { fail } from './errors';
import { relativeDirectory, validateTemplate, safeComponent } from '../core/filename';
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_REQUEST');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(k => ['__proto__', 'constructor', 'prototype'].includes(k))) fail('INVALID_REQUEST');
  return result;
}
export function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void { if (Object.keys(value).some(k => !allowed.includes(k))) fail('INVALID_REQUEST'); }
export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_REQUEST'); return value; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') fail('INVALID_REQUEST'); return value; }
function string(value: unknown, max = 512): string { if (typeof value !== 'string' || value.length > max) fail('INVALID_REQUEST'); return value; }
const containers = ['mp4', 'webm', 'mkv', 'm4a', 'mp3', 'original'];
function container(value: unknown): Container { if (typeof value !== 'string' || !containers.includes(value)) fail('INVALID_REQUEST'); return value as Container; }
function strings(value: unknown): string[] { if (!Array.isArray(value) || value.length > 100) fail('INVALID_REQUEST'); return value.map(v => string(v, 64)); }
export function validateSelection(value: unknown): Selection {
  const v = object(value); exactKeys(v, ['variantId', 'audioTrackId', 'subtitleTrackIds', 'audioOnly', 'container']);
  const result: Selection = { subtitleTrackIds: strings(v.subtitleTrackIds), audioOnly: bool(v.audioOnly), container: container(v.container) };
  if (new Set(result.subtitleTrackIds).size !== result.subtitleTrackIds.length) fail('INVALID_REQUEST');
  if (v.variantId !== undefined) result.variantId = string(v.variantId, 128);
  if (v.audioTrackId !== undefined) result.audioTrackId = string(v.audioTrackId, 128);
  return result;
}
export const COMMANDS = ['GET_TAB_MEDIA', 'CREATE_JOB', 'GET_JOBS', 'PAUSE_JOB', 'RESUME_JOB', 'CANCEL_JOB', 'STOP_LIVE_AND_SAVE', 'RETRY_JOB', 'UPDATE_SETTINGS', 'EXPORT_DIAGNOSTICS', 'GET_SETTINGS', 'GET_STORAGE_USAGE', 'CLEAR_TEMP', 'RESET_SETTINGS'] as const;
export function validateEnvelope(value: unknown): { version: 1; requestId: string; type: typeof COMMANDS[number]; payload: Record<string, unknown> } {
  const v = object(value); exactKeys(v, ['version', 'requestId', 'type', 'payload']);
  if (v.version !== 1 || typeof v.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.requestId) || !COMMANDS.includes(v.type as typeof COMMANDS[number])) fail('INVALID_REQUEST');
  const p = object(v.payload), type = v.type as typeof COMMANDS[number];
  if (['PAUSE_JOB', 'RESUME_JOB', 'CANCEL_JOB', 'STOP_LIVE_AND_SAVE', 'RETRY_JOB'].includes(type)) { exactKeys(p, ['jobId', 'expectedRevision']); string(p.jobId, 128); integer(p.expectedRevision); }
  else if (type === 'GET_TAB_MEDIA') { exactKeys(p, ['tabId']); integer(p.tabId); }
  else if (type === 'CREATE_JOB') {
    exactKeys(p, ['candidateId', 'expectedCandidateRevision', 'selection', 'output', 'liveLimits']); string(p.candidateId, 128); integer(p.expectedCandidateRevision); validateSelection(p.selection);
    const out = object(p.output); exactKeys(out, ['name', 'relativeDirectory', 'saveAs']);
    const name = string(out.name, 180); if (safeComponent(name) !== name) fail('INVALID_REQUEST'); relativeDirectory(string(out.relativeDirectory, 1024)); bool(out.saveAs);
    if (p.liveLimits !== undefined) { const l = object(p.liveLimits); exactKeys(l, ['durationSeconds', 'bytes']); if (l.durationSeconds !== undefined) integer(l.durationSeconds, 1); if (l.bytes !== undefined) integer(l.bytes, 1); }
  } else if (['GET_SETTINGS', 'GET_STORAGE_USAGE'].includes(type)) exactKeys(p, []);
  else if (type === 'UPDATE_SETTINGS') { exactKeys(p, ['expectedRevision', 'settings']); integer(p.expectedRevision); validateSettings(p.settings); }
  else if (type === 'RESET_SETTINGS') { exactKeys(p, ['expectedRevision', 'confirmed']); integer(p.expectedRevision); if (p.confirmed !== true) fail('INVALID_REQUEST'); }
  else if (type === 'CLEAR_TEMP') { exactKeys(p, ['jobIds', 'confirmed']); strings(p.jobIds); if (p.confirmed !== true) fail('INVALID_REQUEST'); }
  else if (type === 'GET_JOBS') { exactKeys(p, ['filter', 'cursor', 'limit']); if (typeof p.filter !== 'string' || !['all', 'active', 'completed', 'errors'].includes(p.filter)) fail('INVALID_REQUEST'); if (p.limit !== undefined) integer(p.limit, 1, 100); if (p.cursor !== undefined) string(p.cursor, 128); }
  else if (type === 'EXPORT_DIAGNOSTICS') { exactKeys(p, ['preview', 'approvedPreviewId']); bool(p.preview); if (!p.preview) string(p.approvedPreviewId, 128); }
  return { version: 1, requestId: v.requestId, type, payload: p };
}
export function validateSettings(value: unknown): SettingsV1 {
  const v = object(value);
  exactKeys(v, ['schemaVersion', 'quality', 'audioLanguages', 'subtitleLanguages', 'subtitlesEnabled', 'container', 'filenameTemplate', 'relativeDirectory', 'siteDirectories', 'jobsConcurrency', 'segmentsConcurrency', 'retries', 'firstByteTimeoutMs', 'stallTimeoutMs', 'liveMaxDurationSeconds', 'liveMaxBytes', 'discoveryEnabled', 'siteDiscovery', 'permissionMode', 'historyEnabled', 'historyMaxEntries', 'historyMaxDays']);
  if (v.schemaVersion !== 1) fail('INVALID_REQUEST');
  const q = object(v.quality); exactKeys(q, ['mode', 'maxHeight']);
  if (typeof q.mode !== 'string' || !['best', 'max_height', 'manual'].includes(q.mode)) fail('INVALID_REQUEST');
  if (q.maxHeight !== undefined) integer(q.maxHeight, 1, 16384);
  if (q.mode === 'max_height' && q.maxHeight === undefined) fail('INVALID_REQUEST');
  strings(v.audioLanguages); strings(v.subtitleLanguages); container(v.container);
  for (const key of ['subtitlesEnabled', 'discoveryEnabled', 'historyEnabled']) bool(v[key]);
  integer(v.jobsConcurrency, 1, 4); integer(v.segmentsConcurrency, 1, 8); integer(v.retries, 0, 10);
  integer(v.firstByteTimeoutMs, 1, 300000); integer(v.stallTimeoutMs, 1, 600000);
  integer(v.historyMaxEntries, 1, 10000); integer(v.historyMaxDays, 1, 3650);
  for (const key of ['liveMaxDurationSeconds', 'liveMaxBytes']) if (v[key] !== undefined) integer(v[key], 1);
  validateTemplate(string(v.filenameTemplate)); relativeDirectory(string(v.relativeDirectory, 1024));
  for (const [host, dir] of Object.entries(object(v.siteDirectories))) { if (!/^[a-z0-9.-]+$/.test(host)) fail('INVALID_REQUEST'); relativeDirectory(string(dir, 1024)); }
  for (const [host, enabled] of Object.entries(object(v.siteDiscovery))) { if (!/^[a-z0-9.-]+$/.test(host)) fail('INVALID_REQUEST'); bool(enabled); }
  if (typeof v.permissionMode !== 'string' || !['selected_sites', 'all_http_https'].includes(v.permissionMode)) fail('INVALID_REQUEST');
  return structuredClone(v) as unknown as SettingsV1;
}
export function validateHostSender(sender: { id?: string; url?: string }, extensionId: string, hostUrl: string): void { if (sender.id !== extensionId || sender.url !== hostUrl) fail('INVALID_REQUEST'); }
export function validateHintBinding(sender: { tab?: { id?: number }; frameId?: number; documentId?: string }, expected: { tabId: number; frameId: number; documentId: string; generation: number; documentKey: string }, hint: unknown): void {
  const h = object(hint); exactKeys(h, ['generation', 'documentKey', 'kind', 'url', 'title', 'mime']);
  if (sender.tab?.id !== expected.tabId || sender.frameId !== expected.frameId || sender.documentId !== expected.documentId || h.generation !== expected.generation || h.documentKey !== expected.documentKey || typeof h.kind !== 'string' || !['video', 'audio', 'source'].includes(h.kind)) fail('INVALID_REQUEST');
  string(h.url, 16384); if (h.title !== undefined) string(h.title); if (h.mime !== undefined) string(h.mime, 128);
}
export const TERMINAL_STATES: readonly JobState[] = ['completed', 'completed_with_warnings', 'failed', 'cancelled', 'interrupted'];
