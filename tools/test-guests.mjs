// Lists the everyday guest types with their body, head and clothing sets.
// Usage: node tools/test-guests.mjs
import { open, readdir } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { ZipArchive, GameFS } from '../src/zip.js';
import { loadGuestTypes, pickLook, loadGuestConfig } from '../src/guests.js';
process.removeAllListeners('warning');
const fs = new GameFS();
const dir = new URL('../orgfiles/', import.meta.url);
for (const n of (await readdir(dir)).filter((f) => /\.z2f$/i.test(f)).sort()) {
  const fh = await open(new URL(n, dir)); const { size } = await fh.stat();
  fs.add(await ZipArchive.open(n, { size, read: async (o, l) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b; } }, async (b) => new Uint8Array(inflateRawSync(b))));
}
const types = await loadGuestTypes(fs);
for (const t of types) {
  const missing = [t.actor, t.head].filter((p) => p && !fs.has(p) && !fs.has(p + '.nif'));
  console.log(t.id, t.adult ? 'adult' : 'child', t.male ? 'M' : 'F', t.actor, t.head, t.attach, `${t.sets.length} sets`, missing.length ? `MISSING ${missing}` : '', pickLook(t).map(({ material, layer, image }) => `${material}/${layer}=${image.split('/').pop()}`).join(' '));
}
console.log(await loadGuestConfig(fs));
