export function mediaUrl(value: string, base?: string, allowPrivate = false): string {
  if (value.length > 16384) throw new Error('MANIFEST_LIMIT');
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('UNSUPPORTED_FORMAT');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  let privateHost = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.');
  if (host.includes(':')) {
    privateHost = true; // Conservative: IPv6 literals require explicit local mode.
  } else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    privateHost = a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  }
  if (!allowPrivate && privateHost) throw new Error('PERMISSION_REQUIRED');
  return url.href;
}
