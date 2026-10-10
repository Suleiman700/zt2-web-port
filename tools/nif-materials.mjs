// Lists each mesh of a model with its material name and texture (for texture replacement work).
// Usage: node tools/nif-materials.mjs <path-in-archives>
import { open, readdir } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { ZipArchive, GameFS } from '../src/zip.js';
import { parseNif } from '../src/nif.js';
import { buildModel } from '../src/model.js';
process.removeAllListeners('warning');
const fs = new GameFS();
const dir = new URL('../orgfiles/', import.meta.url);
for (const n of (await readdir(dir)).filter((f) => /\.z2f$/i.test(f)).sort()) {
  const fh = await open(new URL(n, dir)); const { size } = await fh.stat();
  fs.add(await ZipArchive.open(n, { size, read: async (o, l) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b; } }, async (b) => new Uint8Array(inflateRawSync(b))));
}
const model = buildModel(parseNif(await fs.read(process.argv[2])));
for (const m of model.meshes) console.log(m.name, '| material:', m.materialName, '| texture:', m.texture, '| skinned:', Boolean(m.skin));
