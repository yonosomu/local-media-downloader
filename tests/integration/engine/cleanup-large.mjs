import { readdir, rm, statfs } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve('.test-data/engine-large');
// This directory was created by browser-large.mjs in this task run only.
// Never touch historical spikes/evidence, personal profiles, or other test suites.
const removed = [];
for (const item of await readdir(root, { withFileTypes: true })) {
  if (item.isDirectory() && (/^(?:chrome|brave)-(?:256|2048)-(?:direct|segmented)-[a-zA-Z0-9]+$/.test(item.name) || item.name === 'downloads') || item.isFile() && /^(?:chrome|brave)-(?:256|2048)-(?:direct|segmented)\.mp4$/.test(item.name)) {
    await rm(path.join(root, item.name), { recursive: true, force: true }); removed.push(item.name);
  }
}
const disk = await statfs(root);
console.log(JSON.stringify({ removed, freeBytes: disk.bavail * disk.bsize }, null, 2));
