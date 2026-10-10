// Compares key bone positions at bind pose vs. an animation's first frame.
// Usage: node tools/test-anim.mjs <model.nif> <anim.bf> <archives...>
import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { ZipArchive, GameFS } from '../src/zip.js';
import { parseNif } from '../src/nif.js';
import { parseBF } from '../src/bf.js';
import { buildModel } from '../src/model.js';
import { computePose } from '../src/skeleton.js';
process.removeAllListeners('warning');
const [modelPath, animPath, ...archives] = process.argv.slice(2);
const fs = new GameFS();
for (const a of archives.sort()) {
  const fh = await open(a); const { size } = await fh.stat();
  fs.add(await ZipArchive.open(a, { size, read: async (o, l) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b; } }, async (b) => new Uint8Array(inflateRawSync(b))));
}
const model = buildModel(parseNif(await fs.read(modelPath)));
const anim = parseBF(await fs.read(animPath));
const skel = model.skeleton;
const posed = computePose(skel, anim, 0, []);
const matched = anim.bones.filter((b) => skel.byName.has(b.name.toLowerCase())).length;
console.log(`anim bones ${anim.bones.length}, matched to model ${matched}; skinned meshes ${model.meshes.filter((m) => m.skin).length}/${model.meshes.length}`);
for (const name of ['Bip01', 'Bip01 Head', 'Bip01 L Hand', 'Bip01 R Foot', 'Bip01 Tail3']) {
  const i = skel.byName.get(name.toLowerCase());
  if (i === undefined) continue;
  const f = (m) => [m[12], m[13], m[14]].map((v) => v.toFixed(2).padStart(6)).join(' ');
  console.log(name.padEnd(14), 'bind', f(skel.bindWorld[i]), '| anim', f(posed[i]));
}
