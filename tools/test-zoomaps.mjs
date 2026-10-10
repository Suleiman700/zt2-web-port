// Parses every map's starting zoo (.zt2) and checks it against the catalog and the terrain.
// Usage: node tools/test-zoomaps.mjs [mapFilter]
import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { ZipArchive, GameFS } from '../src/zip.js';
import { buildCatalog } from '../src/catalog.js';
import { parseZooMap } from '../src/zoomap.js';
import { parseTerrainDat } from '../src/mapterrain.js';
process.removeAllListeners('warning');
const fs = new GameFS();
for (const n of ['x300_000.z2f', 'x301_000.z2f', 'x302_000.z2f']) {
  const fh = await open(new URL(`../orgfiles/${n}`, import.meta.url)); const { size } = await fh.stat();
  fs.add(await ZipArchive.open(n, { size, read: async (o, l) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b; } }, async (b) => new Uint8Array(inflateRawSync(b))));
}
const filter = process.argv[2] ?? '';
const catalog = new Map((await buildCatalog(fs)).map((i) => [i.id.toLowerCase(), i]));
const st = (a) => { const m = a.reduce((s, v) => s + v, 0) / a.length; return `${m.toFixed(2)}±${Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length).toFixed(2)}`; };
const missing = new Map();
for (const file of fs.list((p) => /^maps\/.*\.zt2$/.test(p) && p.includes(filter))) {
  const map = parseZooMap(new TextDecoder().decode(await fs.read(file)));
  for (const t of [...map.entities.map((e) => e.type), ...map.fences.map((f) => f.type), ...map.paths.map((p) => p.type)]) {
    if (!catalog.has(t.toLowerCase())) missing.set(t, (missing.get(t) ?? 0) + 1);
  }
  // Heights: entity z minus the terrain at (x, y) and at (x, flipped y); expect a steady +6 m
  // (world height = terrain .dat height + 6) and no flip.
  let err = [], errFlip = [], n = 0;
  const datPath = file.replace(/[^/]+$/, map.terrainFile ?? '');
  if (map.terrainFile && fs.has(datPath)) {
    const t = parseTerrainDat(await fs.read(datPath));
    const h = (x, y) => t.heights[Math.round(y / t.cellSize) * t.width + Math.round(x / t.cellSize)];
    const H = (t.height - 1) * t.cellSize;
    for (const e of map.entities.slice(0, 50)) {
      if (e.pos[1] < 0 || e.pos[1] > H) continue;
      err.push(e.pos[2] - h(e.pos[0], e.pos[1])); errFlip.push(e.pos[2] - h(e.pos[0], H - e.pos[1])); n++;
    }
  }
  console.log(file.padEnd(40), `ent ${map.entities.length} fence ${map.fences.length} path ${map.paths.length} cash ${map.cash} open ${map.zooOpen}`,
    n ? `dz ${st(err)} flipped ${st(errFlip)}` : "");
}
console.log('not in catalog:', [...missing].sort((a, b) => b[1] - a[1]).slice(0, 40));
