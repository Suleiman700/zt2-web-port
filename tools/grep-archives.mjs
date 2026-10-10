// Searches text files inside the game archives. Usage: node tools/grep-archives.mjs <regex> [pathRegex]
import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { ZipArchive, GameFS } from '../src/zip.js';
process.removeAllListeners('warning');
const fs = new GameFS();
for (const n of ['x300_000.z2f', 'x301_000.z2f', 'x302_000.z2f']) {
  const fh = await open(new URL(`../orgfiles/${n}`, import.meta.url)); const { size } = await fh.stat();
  fs.add(await ZipArchive.open(n, { size, read: async (o, l) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b; } }, async (b) => new Uint8Array(inflateRawSync(b))));
}
process.stdout.on('error', () => process.exit(0));
const re = new RegExp(process.argv[2], 'i');
const pathRe = new RegExp(process.argv[3] ?? '\.(xml|lua|txt|cfg|ini|tsk|beh)$', 'i');
for (const p of fs.list((k) => pathRe.test(k) && !/^maps\//.test(k))) {
  const lines = new TextDecoder('latin1').decode(await fs.read(p)).split(/\r?\n/);
  lines.forEach((l, i) => { if (re.test(l)) console.log(`${p}:${i + 1}: ${l.trim().slice(0, 220)}`); });
}
