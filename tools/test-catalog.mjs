// Builds the catalog in Node and prints a summary. Usage: node tools/test-catalog.mjs <archives...>
import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { ZipArchive, GameFS } from '../src/zip.js';
import { buildCatalog } from '../src/catalog.js';
process.removeAllListeners('warning');
const fs = new GameFS();
for (const a of process.argv.slice(2).sort()) {
  const fh = await open(a); const { size } = await fh.stat();
  fs.add(await ZipArchive.open(a, { size, read: async (o, l) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b; } }, async (b) => new Uint8Array(inflateRawSync(b))));
}
const t = Date.now();
const items = await buildCatalog(fs);
console.log(`${items.length} items in ${Date.now() - t} ms`);
const groups = Object.groupBy(items, (i) => i.group);
for (const [g, list] of Object.entries(groups)) console.log(g.padEnd(12), list.length, '|', list.slice(0, 6).map((i) => `${i.name} [${i.types.slice(1, 4).join('/')}]`).join('; '));
