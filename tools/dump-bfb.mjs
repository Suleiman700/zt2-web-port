// Prints a .bfb's blocks and node tree. Usage: node tools/dump-bfb.mjs <path-in-archives>
import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { ZipArchive, GameFS } from '../src/zip.js';
import { parseBFB } from '../src/bfb.js';
process.removeAllListeners('warning');
const fs = new GameFS();
for (const n of ['x300_000.z2f', 'x301_000.z2f', 'x302_000.z2f']) {
  const fh = await open(new URL(`../orgfiles/${n}`, import.meta.url)); const { size } = await fh.stat();
  fs.add(await ZipArchive.open(n, { size, read: async (o, l) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b; } }, async (b) => new Uint8Array(inflateRawSync(b))));
}
const bytes = await fs.read(process.argv[2]);
const dv = new DataView(bytes.buffer, bytes.byteOffset);
let p = 88; const n = dv.getUint32(80, true);
const types = {};
for (let b = 0; b < n; b++) {
  const id = dv.getUint32(p, true), type = dv.getUint16(p + 4, true), end = dv.getUint32(p + 8, true);
  const name = new TextDecoder('latin1').decode(bytes.subarray(p + 12, p + 76)).replace(/\0.*$/s, '');
  types[`${type}:${name.toLowerCase() === 'meshdata' ? 'meshData' : '*'}`] = (types[`${type}:${name.toLowerCase() === 'meshdata' ? 'meshData' : '*'}`] ?? 0) + 1;
  if (process.env.V) console.log('block', id, type, name, end - p);
  p = end;
}
console.log('blocks', n, types, 'tree at', p, 'of', bytes.length);
const doc = parseBFB(bytes);
for (const [id, d] of doc.meshData) console.log('meshData', id, d.format, d.stride, d.count, 'idx', d.indices.length, 'prim', bytes[0] && '');
const t = {};
for (const h of doc.hierarchy) t[`type${h.type} lod${h.lod}`] = (t[`type${h.type} lod${h.lod}`] ?? 0) + 1;
console.log('nodes', doc.hierarchy.length, t);
let tri = 0, missing = 0;
for (const h of doc.hierarchy) if (h.mesh !== null) { const b = doc.meshBlocks.get(h.mesh); if (!b) missing++; else if (h.lod === null || h.lod === 0) tri += b.subMeshes.reduce((s, m) => s + m.indexCount / 3, 0); if (b && b.subMeshes.length !== h.materials.length) console.log("count mismatch", h.name, b.subMeshes.length, h.materials.length); }
console.log('tris lod0', tri, 'mesh refs missing', missing);
if (process.env.TREE) for (const h of doc.hierarchy) console.log(h.type, h.parent, h.lod, h.name, h.mesh, h.materials.join(", "));
