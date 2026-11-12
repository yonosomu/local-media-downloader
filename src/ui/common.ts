import { safeError } from '../shared/errors';
export const t = (key: string): string => chrome.i18n.getMessage(key) || key;
export function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, parent?: HTMLElement): HTMLElementTagNameMap[K] { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; parent?.append(n); return n; }
export function button(label: string, parent: HTMLElement, action: () => unknown): HTMLButtonElement { const b = node('button', t(label), parent); b.type = 'button'; b.dataset.focusKey = label; b.addEventListener('click', () => { try { Promise.resolve(action()).catch(showError); } catch (error) { showError(error); } }); return b; }
export function field(label: string, parent: HTMLElement, type = 'text', value = ''): HTMLInputElement { const l = node('label', t(label), parent), input = node('input', undefined, l); input.name = label; input.type = type; if (type === 'checkbox') input.checked = value === 'true'; else input.value = value; return input; }
export function select(label: string, parent: HTMLElement, choices: { value: string; label: string }[], selected?: string): HTMLSelectElement { const l = node('label', t(label), parent), s = node('select', undefined, l); s.name = label; for (const choice of choices) { const o = node('option', choice.label, s); o.value = choice.value; } if (selected !== undefined) s.value = selected; return s; }
export const status = document.getElementById('status')!;
export function showError(error: unknown): void { status.textContent = error instanceof Error ? error.message : safeError(error).message; status.setAttribute('role', 'alert'); }
export function showStatus(text: string): void { status.textContent = text; status.setAttribute('role', 'status'); }
export async function send<T>(type: string, payload: object = {}, requestId = crypto.randomUUID()): Promise<T> { const reply = await chrome.runtime.sendMessage({ version: 1, requestId, type, payload }); if (!reply?.ok) throw new Error(reply?.error?.message ?? t('genericError')); return reply.data as T; }
export function events(update: () => void): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const connect = () => { if (stopped) return; const port = chrome.runtime.connect({ name: 'lmd-events' }); port.onMessage.addListener(() => { if (!timer) timer = setTimeout(() => { timer = undefined; update(); }, 100); }); port.onDisconnect.addListener(() => { if (!stopped) setTimeout(() => { connect(); update(); }, 500); }); window.addEventListener('pagehide', () => { stopped = true; port.disconnect(); }, { once: true }); };
  connect();
}
export async function grant(origin: string): Promise<void> {
  const u = new URL(origin), pattern = `${u.protocol}//${u.hostname}/*`;
  const privateHost = u.hostname === 'localhost' || !u.hostname.includes('.') || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[)/.test(u.hostname);
  if (privateHost && !confirm(t('localConfirm'))) return;
  // request remains on the original user-gesture path; no background permission prompts.
  if (!await chrome.permissions.request({ origins: [pattern] })) throw new Error(t('denied'));
  if (privateHost) { const stored = await chrome.storage.local.get('localModeOrigins'), origins = stored.localModeOrigins as string[] ?? []; await chrome.storage.local.set({ localModeOrigins: [...new Set([...origins, origin])] }); }
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) if (tab.id !== undefined && tab.url?.startsWith(origin + '/')) await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content/observer.js'] }).catch(() => {});
}
export function downloadJson(name: string, value: unknown): void { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })), a = node('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); }
export function setup(): HTMLElement {
  node('h1', t('app'), document.getElementById('header')!);
  const nav = document.getElementById('nav')!;
  for (const screen of ['popup', 'manager', 'options']) if (!location.pathname.includes(`/${screen}/`)) { const a = node('a', t(screen === 'popup' ? 'app' : screen), nav); a.href = chrome.runtime.getURL(`ui/${screen}/index.html`); a.target = '_blank'; }
  return document.getElementById('main')!;
}
