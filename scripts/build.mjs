import { build } from 'esbuild';
import { mkdir, rm, cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd(), dist = path.join(root, 'dist');
// Only the generated product directory is replaced, never test/user Downloads.
await rm(dist, { recursive: true, force: true }); await mkdir(dist, { recursive: true });
await build({ entryPoints: ['src/background/service-worker.ts', 'src/offscreen/host.ts', 'src/offscreen/worker.ts', ...['popup', 'manager', 'options'].map(s => `src/ui/${s}/index.ts`)], outdir: dist, outbase: 'src', bundle: true, format: 'esm', target: 'chrome120', sourcemap: false, legalComments: 'eof', logLevel: 'info' });
await build({ entryPoints: ['src/content/observer.ts'], outfile: path.join(dist, 'content/observer.js'), bundle: true, format: 'iife', target: 'chrome120' });
await cp('src/manifest.json', path.join(dist, 'manifest.json'));
await cp('src/_locales', path.join(dist, '_locales'), { recursive: true });
await cp('src/offscreen/host.html', path.join(dist, 'offscreen/host.html'));
await cp('src/ui/style.css', path.join(dist, 'ui/style.css'));
const shell = await readFile('src/ui/shell.html', 'utf8');
for (const screen of ['popup', 'manager', 'options']) await writeFile(path.join(dist, `ui/${screen}/index.html`), shell.replace('$SCREEN', screen));
await mkdir(path.join(dist, 'licenses'), { recursive: true });
await cp('node_modules/mediabunny/LICENSE', path.join(dist, 'licenses/Mediabunny-MPL-2.0.txt'));
console.log('dist/ ready: one MV3 build for Chrome and Brave.');
