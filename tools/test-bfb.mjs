// Parses every .bfb, builds the engine model, and checks geometry, skins and bind poses.
// Usage: node tools/test-bfb.mjs <archives...>
import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { ZipArchive, GameFS } from '../src/zip.js';
import { parseBFB, buildBFBModel } from '../src/bfb.js';
import { mat4 } from '../src/math.js';
process.removeAllListeners('warning');
const fs = new GameFS();
for (const a of process.argv.slice(2).sort()) {
  const fh = await open(a); const { size } = await fh.stat();
  fs.add(await ZipArchive.open(a, { size, read: async (o, l) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b; } }, async (b) => new Uint8Array(inflateRawSync(b))));
}
let ok = 0, empty = 0, skinned = 0, worstBind = 0, nan = 0;
const errors = new Map();
for (const p of fs.list((k) => k.endsWith('.bfb'))) {
  try {
    const model = buildBFBModel(parseBFB(await fs.read(p)));
    if (!model.meshes.length) { empty++; continue; }
    for (const m of model.meshes) {
      if ([m.positions, m.normals, m.uvs].some((a) => a && a.some((v) => !Number.isFinite(v)))) nan++;
      if (m.skin) {
        skinned++;
        m.skin.bones.forEach((node, i) => {
          const r = mat4.multiply(model.skeleton.bindWorld[node], m.skin.offsets[i]);
          worstBind = Math.max(worstBind, ...r.map((v, k) => Math.abs(v - (k % 5 === 0 ? 1 : 0))));
        });
      }
    }
    ok++;
  } catch (e) {
    const k = e.message.replace(/\d+/g, 'N');
    if (!errors.has(k)) errors.set(k, []);
    errors.get(k).push(p);
  }
}
console.log(`models with meshes: ${ok}, without meshes: ${empty}, skinned meshes: ${skinned}, meshes with NaN: ${nan}, worst bind-pose error: ${worstBind.toExponential(2)}`);
for (const [k, v] of errors) console.log(`${v.length} x ${k}  e.g. ${v[0]}`);
