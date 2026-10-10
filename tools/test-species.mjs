// For every animal species in the catalog: checks walk/idle animations exist and posing works.
// Usage: node tools/test-species.mjs <archives...>
import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { ZipArchive, GameFS } from '../src/zip.js';
import { buildCatalog } from '../src/catalog.js';
import { parseNif } from '../src/nif.js';
import { parseBF } from '../src/bf.js';
import { buildModel } from '../src/model.js';
import { isBFB, parseBFB, buildBFBModel } from '../src/bfb.js';
import { computePose, rootTravel } from '../src/skeleton.js';
process.removeAllListeners('warning');
const fs = new GameFS();
for (const a of process.argv.slice(2).sort()) {
  const fh = await open(a); const { size } = await fh.stat();
  fs.add(await ZipArchive.open(a, { size, read: async (o, l) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b; } }, async (b) => new Uint8Array(inflateRawSync(b))));
}
const catalog = await buildCatalog(fs);
const problems = [];
let good = 0;
for (const sp of catalog.filter((c) => c.isAnimal)) {
  const v = sp.variants[0];
  try {
    if (!v.actor) { problems.push(`${sp.name}: no actor file`); continue; }
    const s = new TextDecoder().decode(await fs.read(v.actor));
    const list = new Map([...s.matchAll(/anim="([^"]+)"\s+animName="([^"]+)"/g)].map((m) => [m[2].toLowerCase(), m[1]]));
    const walkName = ['walk_ahead', 'swim_ahead', 'fly_ahead', 'run_ahead'].find((n) => list.has(n));
    const idleName = ['stand_idle', 'swim_idle', 'fly_idle', 'sit_idle', 'lie_idle'].find((n) => list.has(n)) ?? [...list.keys()].find((k) => k.endsWith('_idle'));
    const mb = await fs.read(v.model);
    const model = isBFB(mb) ? buildBFBModel(parseBFB(mb)) : buildModel(parseNif(mb));
    const skinned = model.meshes.filter((m) => m.skin).length;
    let speed = 0;
    if (walkName) {
      const walk = parseBF(await fs.read(list.get(walkName)));
      speed = rootTravel(walk) / walk.duration * v.scale;
      const pose = computePose(model.skeleton, walk, walk.duration / 2, []);
      if (pose.some((m) => m.some((x) => !Number.isFinite(x)))) throw new Error('NaN in pose');
    }
    const issues = [!walkName && 'no walk', !idleName && 'no idle', !skinned && 'not skinned', model.meshes.some((m) => m.skin?.bones.length > 128) && '>128 bones'].filter(Boolean);
    if (issues.length) problems.push(`${sp.name}: ${issues.join(', ')} (${list.size} anims)`);
    else good++;
    if (['Lion', 'Dodo', 'Orca', 'Velociraptor', 'Woolly Rhinoceros'].includes(sp.name)) console.log(`${sp.name.padEnd(16)} walk=${walkName} idle=${idleName} speed=${speed.toFixed(2)} m/s`);
  } catch (err) {
    problems.push(`${sp.name}: ERROR ${err.message}`);
  }
}
console.log(`\n${good} species fully OK, ${problems.length} with issues:`);
for (const p of problems) console.log('  ' + p);
