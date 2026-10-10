// Lists archive paths matching a regex across every game archive; with "cat" also prints them.
// Usage: node tools/ls-archives.mjs <pathRegex> [cat]
import { open, readdir } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { ZipArchive, GameFS } from '../src/zip.js';
process.removeAllListeners('warning');
const fs = new GameFS();
const dir = new URL('../orgfiles/', import.meta.url);
for (const n of (await readdir(dir)).filter((f) => /\.z2f$/i.test(f)).sort()) {
  const fh = await open(new URL(n, dir)); const { size } = await fh.stat();
  fs.add(await ZipArchive.open(n, { size, read: async (o, l) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b; } }, async (b) => new Uint8Array(inflateRawSync(b))));
}
process.stdout.on('error', () => process.exit(0));
const re = new RegExp(process.argv[2], 'i');
for (const p of fs.list((k) => re.test(k))) {
  console.log(process.argv[3] === 'cat' ? '=== ' + p : p);
  if (process.argv[3] === 'cat') console.log(new TextDecoder('latin1').decode(await fs.read(p)));
}
