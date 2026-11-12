import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchRequests } from '../../../src/background/web-request';

function setup(origins: string[] = []) {
  const listeners = () => {
    const active = new Set<unknown>();
    return { active, addListener: vi.fn((callback: unknown) => active.add(callback)), removeListener: vi.fn((callback: unknown) => active.delete(callback)) };
  };
  const events = { onBeforeRequest: listeners(), onCompleted: listeners(), onErrorOccurred: listeners(), onHeadersReceived: listeners() };
  const getAll = vi.fn(async () => ({ origins }));
  vi.stubGlobal('chrome', { webRequest: events, permissions: { getAll } });
  const handlers = { before: vi.fn(), completed: vi.fn(), error: vi.fn(), headers: vi.fn() };
  const clear = vi.fn(), sync = watchRequests(handlers, clear);
  return { events, getAll, handlers, clear, sync, grant: (next: string[]) => { origins = next; } };
}
afterEach(() => vi.unstubAllGlobals());
describe('webRequest registration follows actual host permissions', () => {
  it('never registers an empty/no-host filter on clean startup', async () => {
    const { events, sync } = setup(); await sync();
    for (const event of Object.values(events)) expect(event.addListener).not.toHaveBeenCalled();
  });
  it('registers only granted HTTP(S) scopes and removes all handlers on revoke', async () => {
    const { events, sync, grant, handlers, clear } = setup(['https://media.example/*', 'file:///*']);
    await sync();
    expect(events.onBeforeRequest.addListener).toHaveBeenCalledWith(handlers.before, { urls: ['https://media.example/*'] });
    expect(events.onHeadersReceived.addListener).toHaveBeenCalledWith(handlers.headers, { urls: ['https://media.example/*'] }, ['responseHeaders']);
    await sync();
    for (const event of Object.values(events)) expect(event.addListener).toHaveBeenCalledTimes(1);
    grant([]); await sync();
    for (const event of Object.values(events)) expect(event.active.size).toBe(0);
    expect(clear).toHaveBeenCalledTimes(2);
    grant(['http://127.0.0.1/*']); await sync();
    for (const event of Object.values(events)) expect(event.active.size).toBe(1);
  });
  it('serializes overlapping permission refreshes without restoring stale scope', async () => {
    const { getAll, sync, events, grant } = setup(['https://old.example/*']);
    let release!: (value: { origins: string[] }) => void;
    getAll.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = sync(); await Promise.resolve();
    grant([]); const second = sync();
    release({ origins: ['https://old.example/*'] });
    await Promise.all([first, second]);
    for (const event of Object.values(events)) expect(event.active.size).toBe(0);
  });
  it('restores listeners on a new SW instance with persisted grants', async () => {
    const { events, sync } = setup(['http://*/*', 'https://*/*']); await sync();
    for (const event of Object.values(events)) expect(event.active.size).toBe(1);
  });
});
