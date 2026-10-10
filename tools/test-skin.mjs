// Checks skinning math on animal models: at bind pose, boneWorld * boneOffset * skinTransform
// must equal the mesh's own world transform. Also reports max bones per skinned mesh.
// Usage: node tools/test-skin.mjs <filter> <archives...>
import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { ZipArchive, GameFS } from '../src/zip.js';
import { parseNif } from '../src/nif.js';
import { mat4 } from '../src/math.js';
process.removeAllListeners('warning');
const [filter, ...archives] = process.argv.slice(2);
const fs = new GameFS();
for (const a of archives.sort()) {
  const fh = await open(a); const { size } = await fh.stat();
  fs.add(await ZipArchive.open(a, { size, read: async (o, l) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b; } }, async (b) => new Uint8Array(inflateRawSync(b))));
}
let maxBones = 0, files = 0;
const T = (r) => [r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]];
const err = {};
const note = (k, a, b) => { err[k] = Math.max(err[k] ?? 0, ...a.map((v, i) => Math.abs(v - b[i]))); };
const I = mat4.identity();
for (const p of fs.list((k) => k.endsWith('.nif') && k.includes(filter) && !k.includes('/low/'))) {
  const nif = parseNif(await fs.read(p));
  if (!nif.complete) continue;
  const blocks = []; for (const b of nif.blocks) blocks[b.index] = b;
  const world = new Map();
  const walk = (ref, parent) => {
    const b = blocks[ref]; if (!b || !b.rotation) return;
    const w = mat4.multiply(parent, mat4.fromNif(b.rotation, b.translation, b.scale));
    world.set(ref, w);
    for (const c of b.children ?? []) walk(c, w);
  };
  for (const r of nif.roots) walk(r, mat4.identity());
  for (const b of nif.blocks) {
    if (b.skinInstance === undefined || b.skinInstance < 0) continue;
    const si = blocks[b.skinInstance], sd = blocks[si.data];
    maxBones = Math.max(maxBones, si.bones.length);
    const meshW = world.get(b.index);
    si.bones.forEach((boneRef, i) => {
      const bd = sd.bones[i];
      const W = world.get(boneRef);
      for (const [tag, tr] of [['R', (r) => r], ['T', T]]) {
        const S = mat4.fromNif(tr(sd.rotation), sd.translation, sd.scale);
        const B = mat4.fromNif(tr(bd.rotation), bd.translation, bd.scale);
        note(tag + ' W*B*S=meshW', mat4.multiply(mat4.multiply(W, B), S), meshW);
        note(tag + ' W*B=meshW', mat4.multiply(W, B), meshW);
        note(tag + ' W*B*S=I', mat4.multiply(mat4.multiply(W, B), S), I);
        note(tag + ' W*B=I', mat4.multiply(W, B), I);
        note(tag + ' S*W*B=I', mat4.multiply(S, mat4.multiply(W, B)), I);
      }
    });
  }
  files++;
}
console.log(`files=${files} maxBonesPerSkin=${maxBones}`);
for (const [k, v] of Object.entries(err).sort((a, b) => a[1] - b[1])) console.log(v.toExponential(2).padStart(10), k);
