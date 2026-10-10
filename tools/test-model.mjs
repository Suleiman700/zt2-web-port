// Builds render meshes for matching models and decodes their textures. Usage: node tools/test-model.mjs <filter> <archives...>
import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { ZipArchive, GameFS, normalizePath } from '../src/zip.js';
import { parseNif } from '../src/nif.js';
import { buildModel } from '../src/model.js';
import { decodeDDS } from '../src/dds.js';
process.removeAllListeners('warning');
const [filter, ...archives] = process.argv.slice(2);
const fs = new GameFS();
for (const a of archives) {
  const fh = await open(a); const { size } = await fh.stat();
  fs.add(await ZipArchive.open(a, { size, read: async (o, l) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b; } }, async (b) => new Uint8Array(inflateRawSync(b))));
}
for (const p of fs.list((k) => k.endsWith('.nif') && k.includes(filter) && !k.includes('/low/')).slice(0, 8)) {
  const nif = parseNif(await fs.read(p));
  const m = buildModel(nif);
  const dir = normalizePath(p).split('/').slice(0, -1).join('/');
  const tex = [...new Set(m.meshes.map((x) => x.texture).filter(Boolean))].map((t) => {
    const tp = `${dir}/${t.toLowerCase()}`;
    if (!fs.has(tp)) return `${t}:MISSING`;
    return fs.read(tp).then((b) => { const d = decodeDDS(b); return `${t}:${d.width}x${d.height}`; }, (e) => `${t}:ERR ${e.message}`);
  });
  const tris = m.meshes.reduce((s, x) => s + x.indices.length / 3, 0);
  console.log(p, nif.complete ? 'ok' : 'PARTIAL', `meshes=${m.meshes.length} tris=${tris}`, 'bounds', m.bounds.min.map((v) => v.toFixed(2)), m.bounds.max.map((v) => v.toFixed(2)), (await Promise.all(tex)).join(' '));
}
