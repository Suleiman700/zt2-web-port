// Checks exhibit detection on a map's starting zoo, then with a test enclosure added.
// Usage: node tools/test-exhibits.mjs [map]
import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { ZipArchive, GameFS } from '../src/zip.js';
import { parseZooMap, pathTriangle } from '../src/zoomap.js';
import { PathGrid } from '../src/paths.js';
import { ExhibitMap } from '../src/exhibits.js';
process.removeAllListeners('warning');
const fs = new GameFS();
for (const n of ['x300_000.z2f', 'x301_000.z2f', 'x302_000.z2f']) {
  const fh = await open(new URL(`../orgfiles/${n}`, import.meta.url)); const { size } = await fh.stat();
  fs.add(await ZipArchive.open(n, { size, read: async (o, l) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b; } }, async (b) => new Uint8Array(inflateRawSync(b))));
}
const name = process.argv[2] ?? 'grassland';
const map = parseZooMap(new TextDecoder().decode(await fs.read(`maps/default/${name}.zt2`)));
const paths = new PathGrid();
const item = { id: 'path' };
for (const p of map.paths) { const t = pathTriangle(p.pos); paths.add(item, t.tx, t.ty, t.bit); }
const fences = map.fences.filter((f) => !/curb/i.test(f.type)).map((f) => ({ a: f.a.map((v) => v / 3), b: f.b.map((v) => v / 3) }));
const tiles = { large: 96, medium: 72, small: 54 }[map.size?.split(':')[1]] ?? 96;
const ex = new ExhibitMap(tiles, tiles);
const summary = (regions) => regions.filter((r) => r.triangles > 4).map((r) => `${r.kind}:${Math.round(r.area)}m²${r.pathTriangles ? ` paths ${r.pathTriangles}` : ''}`).join(', ');
console.log('start:', summary(ex.rebuild(fences, paths)));
// A 3x3-tile square with a diagonal corner, inside the zoo.
const sq = [[50, 50], [53, 50], [53, 52], [52, 53], [50, 53], [50, 50]];
const extra = [];
for (let k = 1; k < sq.length; k++) {
  let [x, y] = sq[k - 1]; const [bx, by] = sq[k];
  while (x !== bx || y !== by) { const nx = x + Math.sign(bx - x), ny = y + Math.sign(by - y); extra.push({ a: [x, y], b: [nx, ny] }); x = nx; y = ny; }
}
const regions = ex.rebuild([...fences, ...extra], paths);
console.log('with enclosure:', summary(regions));
const inside = ex.regionAt(51 * 3 + 1, 51 * 3 + 1), outside = ex.regionAt(49 * 3, 49 * 3);
console.log('inside', regions[inside]?.kind, Math.round(regions[inside]?.area), 'm² (expect 9 tiles - half tile = 76.5); outside', regions[outside]?.kind);
