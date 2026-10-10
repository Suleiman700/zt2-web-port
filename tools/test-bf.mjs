// Parses all .bf animations and reports stats; prints root motion for a few named animations.
// Usage: node tools/test-bf.mjs <archives...>
import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { ZipArchive, GameFS } from '../src/zip.js';
import { parseBF } from '../src/bf.js';
process.removeAllListeners('warning');
const fs = new GameFS();
for (const a of process.argv.slice(2).sort()) {
  const fh = await open(a); const { size } = await fh.stat();
  fs.add(await ZipArchive.open(a, { size, read: async (o, l) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b; } }, async (b) => new Uint8Array(inflateRawSync(b))));
}
let ok = 0, bad = 0, badQuat = 0;
for (const p of fs.list((k) => k.endsWith('.bf'))) {
  try {
    const a = parseBF(await fs.read(p));
    for (const b of a.bones) {
      if (!b.rotation) continue;
      for (let i = 0; i < b.rotation.values.length; i += 4) {
        const v = b.rotation.values;
        if (Math.abs(Math.hypot(v[i], v[i + 1], v[i + 2], v[i + 3]) - 1) > 0.01) badQuat++;
      }
    }
    ok++;
  } catch (e) { bad++; }
}
console.log(`parsed ${ok}, failed ${bad}, non-unit quaternions ${badQuat}`);
for (const name of ['TigerBengal_Adult_F_Walk_Ahead', 'TigerBengal_Adult_F_Run_Ahead', 'TigerBengal_Adult_F_Stand_Idle']) {
  const p = fs.list((k) => k.endsWith(name.toLowerCase() + '.bf'))[0];
  if (!p) { console.log('missing', name); continue; }
  const a = parseBF(await fs.read(p));
  const root = a.bones[0];
  const pv = root.position?.values, n = root.position?.times.length;
  const q = root.rotation?.values;
  console.log(name, `dur=${a.duration.toFixed(2)} bones=${a.bones.length} root=${root.name}`,
    pv ? `pos first=[${[...pv.slice(0, 3)].map((v) => v.toFixed(3))}] last=[${[...pv.slice((n - 1) * 3)].map((v) => v.toFixed(3))}]` : 'no pos',
    q ? `rot first=[${[...q.slice(0, 4)].map((v) => v.toFixed(3))}]` : '');
}
