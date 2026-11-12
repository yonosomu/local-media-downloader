import { build } from 'esbuild';
await build({ entryPoints: ['spikes/002-remux-browser/mux-entry.js'], bundle: true, format: 'iife', platform: 'browser', outfile: 'spikes/002-remux-browser/extension/mux.js' });
console.log('Built disposable remux experiment only. No production dist was produced.');
