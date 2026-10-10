// Dumps block layout of one NIF for debugging. Usage: node tools/dump-nif.mjs <archive.z2f> <path-in-archive>
import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { ZipArchive, normalizePath } from '../src/zip.js';
import { parseNif } from '../src/nif.js';
const [arc, path] = process.argv.slice(2);
const fh = await open(arc, 'r'); const { size } = await fh.stat();
const zip = await ZipArchive.open(arc, { size, read: async (o, l) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b; } }, async (b) => new Uint8Array(inflateRawSync(b)));
const bytes = await zip.readEntry(zip.entries.get(normalizePath(path)));
const nif = parseNif(bytes, { trace: true });
console.log('types', nif.types.join(','), '\norder', Array.from(nif.typeIndex).map(i => nif.types[i]).join(','));
for (const b of nif.blocks) {
  const s = {}; for (const [k, v] of Object.entries(b)) { if (k === 'type' || k === 'index' || k === '_start') continue; s[k] = (v && v.length > 12) ? `[${v.length}]` : v; }
  console.log(b.index, b.type, '@' + b._start, JSON.stringify(s).slice(0, 400));
}
console.log('ERROR:', nif.error);
const m = /offset (\d+)/.exec(nif.error || ''); const at = m ? +m[1] : (nif.blocks.at(-1)?._start ?? 0);
for (let i = at; i < Math.min(bytes.length, at + 512); i += 32) console.log(i.toString().padStart(6), Buffer.from(bytes.subarray(i, i + 32)).toString('hex').replace(/(..)/g, '$1 '), Buffer.from(bytes.subarray(i, i + 32)).toString('latin1').replace(/[^\x20-\x7e]/g, '.'));
