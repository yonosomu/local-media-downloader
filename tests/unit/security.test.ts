import { expect, test } from 'vitest';

test('untrusted media URLs cannot access private networks or non-HTTP protocols', async () => {
  const module = await import('../../src/core/security.ts').catch(() => ({})) as { mediaUrl?: (value: string, base?: string, local?: boolean) => string };
  expect(module.mediaUrl, 'mediaUrl policy must exist').toBeTypeOf('function');
  const mediaUrl = module.mediaUrl!;
  expect(mediaUrl('/video?sig=do%2Bnot%2Falter', 'https://cdn.example/movie/master.m3u8')).toBe('https://cdn.example/video?sig=do%2Bnot%2Falter');
  for (const value of ['file:///etc/passwd', 'data:video/mp4,a', 'http://127.0.0.1/a', 'http://2130706433/a', 'http://[::1]/a', 'http://[::ffff:7f00:1]/a', 'http://10.0.0.1/a', 'http://172.16.1.1/a', 'http://192.168.0.1/a', 'http://169.254.169.254/a', 'http://localhost/a', 'https://user:secret@cdn.example/a']) expect(() => mediaUrl(value)).toThrow();
  expect(mediaUrl('http://127.0.0.1/fixture', undefined, true)).toBe('http://127.0.0.1/fixture');
});
