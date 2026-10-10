// Loads the original AI data and prints a species' merged needs and the tasks it can do.
// Usage: node tools/test-aidata.mjs [Lion_Adult_F]
import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { ZipArchive, GameFS } from '../src/zip.js';
import { AIData } from '../src/aidata.js';
process.removeAllListeners('warning');
const fs = new GameFS();
for (const n of ['x300_000.z2f', 'x301_000.z2f', 'x302_000.z2f']) {
  const fh = await open(new URL(`../orgfiles/${n}`, import.meta.url)); const { size } = await fh.stat();
  fs.add(await ZipArchive.open(n, { size, read: async (o, l) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b; } }, async (b) => new Uint8Array(inflateRawSync(b))));
}
const ai = new AIData(fs);
let t = Date.now();
await ai.loadAll();
console.log(`tasks ${ai.tasks.length}, behavior sets ${ai.behaviorSets.size}, ${Date.now() - t} ms`);
const e = await ai.entity(process.argv[2] ?? 'Lion_Adult_F');
console.log('types', e.types.join(' > '));
console.log('adjusts', e.needAdjusts);
console.log('needs', [...e.stateVars].map(([n, v]) => `${n}:${v.ValueMin ?? v.Value}-${v.ValueMax ?? v.Value}/trig ${v.TriggerThreshold}`).join(', '));
const flags = Object.entries(e.attrs).filter(([k, v]) => /^b_/i.test(k) && v === true).map(([k]) => k.toLowerCase());
const keys = [...e.types.map((x) => x.toLowerCase()), ...flags];
const candidates = new Set(keys.flatMap((k) => ai.tasksBySubject.get(k) ?? []));
console.log('flags', flags.length, 'candidate tasks', candidates.size);
console.log([...candidates].slice(0, 40).map((x) => `${x.file}:${x.name}`).join(', '));
console.log('Eat set for lion:', ai.behaviorSet('Eat', [...e.types].reverse().map((x) => x.toLowerCase()))?.children.map((c) => c.name).join(','));
