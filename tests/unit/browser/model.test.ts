import { describe, it, expect } from 'vitest';
import { Registry, TTL, isMedia, isSegment, checkedUrl, originPattern, safeTitle, uiSender, discoveryAllowed } from '../../../src/background/model';
import { DEFAULT_SETTINGS, type MediaCandidate } from '../../../src/shared/contracts';

function add(registry: Registry, id: string, tabId = 1, detectedAt = Date.now()): void {
  const binding = registry.bind(tabId, 0, `document-${tabId}`, 'https://example.org');
  registry.entries.push({ candidate: { id, tabId, frameId: 0, documentKey: binding.documentKey, detectedAt } as MediaCandidate, source: { sourceRef: id, exactUrl: `https://example.org/${id}.mp4`, ...binding, discoveredOrigins: [] }, requiredOrigins: [] });
}

describe('browser registry and trust boundaries', () => {
  it('invalidates previous document and nested frames without mixing tabs', () => {
    const registry = new Registry(); add(registry, 'one'); add(registry, 'two', 2);
    const before = registry.bindings[0]; registry.bind(1, 7, 'iframe', 'https://cdn.example.org');
    const after = registry.bind(1, 0, 'new-document', 'https://example.org');
    expect(after.generation).toBe(before.generation + 1); expect(registry.current(before)).toBe(false);
    expect(registry.entries.map(e => e.candidate.id)).toEqual(['two']);
    expect(registry.bindings.some(b => b.frameId === 7)).toBe(false);
  });
  it('keeps same-document binding until authoritative SPA generation changes', () => {
    const registry = new Registry(); add(registry, 'one'); const old = registry.bindings[0];
    expect(registry.bind(1, 0, old.documentId, old.origin)).toBe(old);
    expect(registry.bind(1, 0, old.documentId, old.origin, true).generation).toBe(2);
    expect(registry.entries).toEqual([]);
  });
  it('bounds registry per tab and expires unpinned sources', () => {
    const registry = new Registry(), now = Date.now();
    for (let n = 0; n < 205; n++) add(registry, String(n), 1, now - n);
    add(registry, 'other', 2, now); registry.trim(now);
    expect(registry.entries.filter(e => e.candidate.tabId === 1)).toHaveLength(200);
    expect(registry.entries.some(e => e.candidate.id === '204')).toBe(false);
    registry.trim(now + TTL, new Set(['other'])); expect(registry.entries.map(e => e.candidate.id)).toEqual(['other']);
  });
  it('restores only unexpired candidates', () => {
    const registry = new Registry(); add(registry, 'old', 1, Date.now() - TTL - 1);
    const restored = new Registry(); restored.restore(registry.snapshot()); expect(restored.entries).toEqual([]);
  });
  it('recognizes extensionless MIME but never surfaces transport segments or keys', () => {
    expect(isMedia('https://example.org/opaque?sig=x', 'video/mp4')).toBe(true);
    expect(isMedia('https://example.org/opaque', 'application/dash+xml')).toBe(true);
    for (const suffix of ['ts', 'm4s', 'cmfa', 'cmfv', 'vtt', 'ttml', 'key']) { expect(isSegment(`https://example.org/a.${suffix}?sig=x`)).toBe(true); expect(isMedia(`https://example.org/a.${suffix}`, 'video/mp4')).toBe(false); }
    expect(isMedia('https://example.org/a', 'text/html')).toBe(false);
  });
  it('preserves signed URLs and requires explicit exact local origin', () => {
    const url = 'https://example.org/movie.mp4?signature=a%2Fb&expires=100'; expect(checkedUrl(url, [])).toBe(url);
    expect(() => checkedUrl('http://127.0.0.1:8000/video', [])).toThrow();
    expect(checkedUrl('http://127.0.0.1:8000/video', ['http://127.0.0.1:8000'])).toBe('http://127.0.0.1:8000/video');
    expect(() => checkedUrl('http://127.0.0.1:8001/video', ['http://127.0.0.1:8000'])).toThrow();
    expect(originPattern('https://cdn.example.org:8443')).toBe('https://cdn.example.org/*');
  });
  it('allows only exact own extension UI paths', () => {
    const id = 'extension'; expect(uiSender({ id, url: `chrome-extension://${id}/ui/popup/index.html` }, id)).toBe(true);
    for (const url of ['https://example.org', `chrome-extension://${id}/ui/popup/index.html?forged=1`, `chrome-extension://${id}/offscreen/host.html`]) expect(uiSender({ id, url }, id)).toBe(false);
    expect(uiSender({ id: 'other', url: `chrome-extension://${id}/ui/popup/index.html` }, id)).toBe(false);
  });
  it('respects global/site discovery and redacts unsafe title URL metadata', () => {
    expect(discoveryAllowed(DEFAULT_SETTINGS, 'example.org')).toBe(true);
    expect(discoveryAllowed({ ...DEFAULT_SETTINGS, discoveryEnabled: false }, 'example.org')).toBe(false);
    expect(discoveryAllowed({ ...DEFAULT_SETTINGS, siteDiscovery: { 'example.org': false } }, 'example.org')).toBe(false);
    expect(safeTitle('Title https://example.org/?secret=xyz Bearer abc')).not.toMatch(/secret|abc/);
  });
});
