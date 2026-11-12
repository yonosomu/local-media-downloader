import type { MediaCandidate, RuntimeSource, SettingsV1, JobSnapshot } from '../shared/contracts';
import { mediaUrl } from '../core/security';
import { safeComponent } from '../core/filename';
import { fail } from '../shared/errors';
export const TTL = 30 * 60 * 1000;
export function safeTitle(value: string): string { return safeComponent(value.replace(/https?:\/\/\S+|Bearer\s+\S+/gi, '[скрыто]').slice(0, 160)); }
export function isSegment(url: string, mime = ''): boolean { return /\.(ts|m4s|cmfv|cmfa|vtt|ttml|key)(?:$|[?#])/i.test(url) || /(?:mp2t|iso.segment|vtt|ttml)/i.test(mime); }
export function isMedia(url: string, mime = ''): boolean { return !isSegment(url, mime) && (/\.(mp4|webm|mkv|mp3|m4a|ogg|wav|m3u8|mpd)(?:$|[?#])/i.test(url) || /^(?:video\/|audio\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml))/i.test(mime)); }
export function originPattern(origin: string): string { const u = new URL(origin); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) fail('INVALID_REQUEST'); return `${u.protocol}//${u.hostname}/*`; }
export function checkedUrl(value: string, localOrigins: string[]): string { const u = new URL(value); return mediaUrl(value, undefined, localOrigins.includes(u.origin)); }
export function uiSender(sender: chrome.runtime.MessageSender, id: string): boolean { return sender.id === id && ['popup', 'manager', 'options'].some(p => sender.url === `chrome-extension://${id}/ui/${p}/index.html`); }
export function jobActive(job: JobSnapshot): boolean { return ['queued', 'resolving', 'downloading', 'assembling', 'awaiting_export', 'exporting'].includes(job.state); }
export function discoveryAllowed(settings: SettingsV1, host: string): boolean { return settings.discoveryEnabled && settings.siteDiscovery[host] !== false; }
export interface Binding { tabId: number; frameId: number; documentId: string; generation: number; documentKey: string; origin: string }
export interface Entry { candidate: MediaCandidate & { originalSuffix?: string }; source: RuntimeSource; requiredOrigins: string[]; relatedUrls?: string[]; error?: string }
export interface RegistryState { entries: Entry[]; bindings: Binding[]; revision: number }
export class Registry {
  entries: Entry[] = []; bindings: Binding[] = []; revision = 0;
  restore(state?: RegistryState): void { if (state) { this.entries = state.entries ?? []; this.bindings = state.bindings ?? []; this.revision = state.revision ?? 0; } this.trim(); }
  snapshot(): RegistryState { return { entries: this.entries, bindings: this.bindings, revision: this.revision }; }
  bind(tabId: number, frameId: number, documentId: string, origin: string, force = false): Binding {
    const old = this.bindings.find(b => b.tabId === tabId && b.frameId === frameId);
    if (old && old.documentId === documentId && !force) return old;
    const next = { tabId, frameId, documentId, origin, generation: (old?.generation ?? 0) + 1, documentKey: crypto.randomUUID() };
    this.bindings = this.bindings.filter(b => !(b.tabId === tabId && (frameId === 0 || b.frameId === frameId))); this.bindings.push(next);
    this.entries = this.entries.filter(e => !(e.candidate.tabId === tabId && (frameId === 0 || e.candidate.frameId === frameId)));
    this.revision++; return next;
  }
  current(binding: Binding): boolean { return this.bindings.some(b => b.documentKey === binding.documentKey); }
  trim(now = Date.now(), pinned: Set<string> = new Set()): void {
    this.entries = this.entries.filter(e => pinned.has(e.candidate.id) || now - e.candidate.detectedAt < TTL);
    const tabs = new Set(this.entries.map(e => e.candidate.tabId));
    for (const tab of tabs) { const unpinned = this.entries.filter(e => e.candidate.tabId === tab && !pinned.has(e.candidate.id)).sort((a, b) => b.candidate.detectedAt - a.candidate.detectedAt); const discard = new Set(unpinned.slice(Math.max(0, 200 - this.entries.filter(e => e.candidate.tabId === tab && pinned.has(e.candidate.id)).length))); this.entries = this.entries.filter(e => !discard.has(e)); }
  }
  find(id: string): Entry { const e = this.entries.find(e => e.candidate.id === id); if (!e) fail('URL_EXPIRED'); return e; }
}
