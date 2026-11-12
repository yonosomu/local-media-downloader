import { fail } from '../shared/errors';
const TOKENS = new Set(['title', 'site', 'date', 'height', 'audioLang', 'id']);
export function validateTemplate(template: string): void {
  if (!template || template.length > 512 || /[{}]/.test(template.replace(/\{([^{}]+)\}/g, (_, token: string) => { if (!TOKENS.has(token)) fail('INVALID_REQUEST'); return ''; }))) fail('INVALID_REQUEST');
}
export function safeComponent(value: string): string {
  let result = value.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/g, '_').replace(/\.\./g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 180).replace(/[. ]+$/g, '');
  if (!result) result = 'media';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = `_${result}`;
  return result;
}
export function relativeDirectory(value: string): string {
  if (!value) return '';
  if (value.length > 1024 || /^(?:[/\\]|[a-z]:)/i.test(value)) fail('INVALID_REQUEST');
  const pieces = value.replace(/\\/g, '/').split('/');
  if (pieces.some(p => !p || p === '.' || p === '..' || safeComponent(p) !== p)) fail('INVALID_REQUEST');
  return pieces.join('/');
}
export function outputName(template: string, values: Record<string, string | number | undefined>, suffix: string): string {
  validateTemplate(template);
  if (!/^[a-z0-9]{1,8}$/.test(suffix)) fail('INVALID_REQUEST');
  const rendered = template.replace(/\{([^{}]+)\}/g, (_, token: string) => String(values[token] ?? ''))
    .replace(/\[\s*p?\]/g, '').replace(/\s+/g, ' ').trim();
  return `${safeComponent(rendered)}.${suffix}`;
}
