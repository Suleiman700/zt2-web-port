// Prints skin matrices for the first skinned mesh of one model. Usage: node tools/inspect-skin.mjs <archive> <path>
import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { ZipArchive, normalizePath } from '../src/zip.js';
import { parseNif } from '../src/nif.js';
import { mat4 } from '../src/math.js';
process.removeAllListeners('warning');
const [arc, path] = process.argv.slice(2);
const fh = await open(arc); const { size } = await fh.stat();
const zip = await ZipArchive.open(arc, { size, read: async (o, l) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b; } }, async (b) => new Uint8Array(inflateRawSync(b)));
const nif = parseNif(await zip.readEntry(zip.entries.get(normalizePath(path))));
const blocks = []; for (const b of nif.blocks) blocks[b.index] = b;
const world = new Map(), parent = new Map();
const walk = (ref, pw, pref) => { const b = blocks[ref]; if (!b || !b.rotation) return; const w = mat4.multiply(pw, mat4.fromNif(b.rotation, b.translation, b.scale)); world.set(ref, w); parent.set(ref, pref); for (const c of b.children ?? []) walk(c, w, ref); };
for (const r of nif.roots) walk(r, mat4.identity(), -1);
const fmt = (m) => [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => m[c * 4 + r].toFixed(3).padStart(7)).join(' ')).join('\n');
const shape = nif.blocks.find((b) => b.skinInstance >= 0);
const si = blocks[shape.skinInstance], sd = blocks[si.data];
const chain = []; for (let r = shape.index; r >= 0; r = parent.get(r)) chain.push(blocks[r].name || blocks[r].type);
console.log('shape', shape.name, 'parents:', chain.join(' <- '), 'skeletonRoot', blocks[si.skeletonRoot]?.name);
console.log('meshWorld\n' + fmt(world.get(shape.index)));
console.log('skin S\n' + fmt(mat4.fromNif(sd.rotation, sd.translation, sd.scale)));
for (const i of [0, 1]) {
  const bone = blocks[si.bones[i]], bd = sd.bones[i];
  console.log(`bone ${bone.name} world\n` + fmt(world.get(si.bones[i])));
  console.log('B\n' + fmt(mat4.fromNif(bd.rotation, bd.translation, bd.scale)));
  console.log('W*B\n' + fmt(mat4.multiply(world.get(si.bones[i]), mat4.fromNif(bd.rotation, bd.translation, bd.scale))));
}
console.log('--- per-bone error of W*B vs meshWorld, all skinned shapes');
for (const s of nif.blocks.filter((b) => b.skinInstance >= 0)) {
  const si2 = blocks[s.skinInstance], sd2 = blocks[si2.data];
  si2.bones.forEach((ref, i) => {
    const W = world.get(ref);
    if (!W) { console.log(s.name, blocks[ref]?.name, 'NOT REACHABLE from root'); return; }
    const m = mat4.multiply(W, mat4.fromNif(sd2.bones[i].rotation, sd2.bones[i].translation, sd2.bones[i].scale));
    const e = Math.max(...m.map((v, k) => Math.abs(v - world.get(s.index)[k])));
    if (e > 1e-3) console.log(s.name, blocks[ref].name, e.toFixed(3), 'flags', blocks[ref].flags);
  });
}
