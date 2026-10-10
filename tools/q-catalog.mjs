// Prints catalog entries by id. Usage: node tools/q-catalog.mjs id1 id2 ...
import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { ZipArchive, GameFS } from '../src/zip.js';
import { buildCatalog } from '../src/catalog.js';
process.removeAllListeners('warning');
const fs = new GameFS();
for (const n of ['x300_000.z2f', 'x301_000.z2f', 'x302_000.z2f']) {
  const fh = await open(new URL(`../orgfiles/${n}`, import.meta.url)); const { size } = await fh.stat();
  fs.add(await ZipArchive.open(n, { size, read: async (o, l) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b; } }, async (b) => new Uint8Array(inflateRawSync(b))));
}
const items = await buildCatalog(fs);
for (const id of process.argv.slice(2)) {
  const i = items.find((x) => x.id.toLowerCase() === id.toLowerCase()) ?? items.find((x) => new RegExp(id, "i").test(x.id));
  console.log(id, i ? JSON.stringify({ ...i, placement: undefined, parts: i.parts?.map((p) => p.name) }) : 'MISSING');
}
