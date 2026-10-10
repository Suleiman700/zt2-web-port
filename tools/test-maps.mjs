// Parses every map terrain (.dat) and prints a summary. Usage: node tools/test-maps.mjs <archives...>
import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { ZipArchive, GameFS } from '../src/zip.js';
import { parseTerrainDat } from '../src/mapterrain.js';
process.removeAllListeners('warning');
const fs = new GameFS();
for (const a of process.argv.slice(2).sort()) {
  const fh = await open(a); const { size } = await fh.stat();
  fs.add(await ZipArchive.open(a, { size, read: async (o, l) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b; } }, async (b) => new Uint8Array(inflateRawSync(b))));
}
const versions = {}, sizes = {}, biomes = new Set();
let ok = 0;
for (const p of fs.list((k) => k.startsWith('maps/') && k.endsWith('.dat'))) {
  try {
    const t = parseTerrainDat(await fs.read(p));
    versions[t.version] = (versions[t.version] || 0) + 1;
    const key = `${t.width - 1}x${t.height - 1} cells @ ${t.cellSize.toFixed(2)}m`;
    sizes[key] = (sizes[key] || 0) + 1;
    t.biomeNames.forEach((b) => biomes.add(b));
    let lo = Infinity, hi = -Infinity; for (const h of t.heights) { lo = Math.min(lo, h); hi = Math.max(hi, h); }
    if (/grassland\.dat|polarcoast|savannahridge/.test(p)) console.log(p, `v${t.version}`, key, `height ${lo.toFixed(1)}..${hi.toFixed(1)}`, `water regions ${t.waterRegions.length}`, 'biomes:', t.biomeNames.join(','));
    ok++;
  } catch (e) { console.log('FAIL', p, e.message); }
}
console.log(`\n${ok} maps parsed. versions`, versions, '\nsizes', sizes, '\nbiomes', [...biomes].join(', '));
