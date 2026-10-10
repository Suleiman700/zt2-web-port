// Parses every NIF in the given .z2f archives and reports how many parse completely.
// Usage: node tools/test-nif.mjs <archive.z2f> [...more]
import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { basename } from 'node:path';
import { ZipArchive } from '../src/zip.js';
import { parseNif } from '../src/nif.js';

async function fileSource(path) {
  const fh = await open(path, 'r');
  const { size } = await fh.stat();
  return {
    size,
    async read(offset, length) {
      const buf = new Uint8Array(length);
      await fh.read(buf, 0, length, offset);
      return buf;
    },
  };
}

process.removeAllListeners("warning");
const failures = new Map();
let total = 0, ok = 0;
for (const path of process.argv.slice(2)) {
  const zip = await ZipArchive.open(basename(path), await fileSource(path), async (b) => new Uint8Array(inflateRawSync(b)));
  for (const entry of zip.entries.values()) {
    if (!entry.path.toLowerCase().endsWith('.nif')) continue;
    const bytes = await zip.readEntry(entry);
    if (!new TextDecoder().decode(bytes.subarray(0, 10)).startsWith('NetImmerse')) continue;
    total++;
    const nif = parseNif(bytes);
    if (nif.complete) { ok++; continue; }
    const key = nif.error.replace(/\(#\d+\)| at offset \d+|ended at \d+, file is \d+ bytes/g, '').trim();
    if (!failures.has(key)) failures.set(key, []);
    failures.get(key).push(entry.path);
  }
}
console.log(`Parsed completely: ${ok}/${total}`);
for (const [k, v] of [...failures].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${v.length.toString().padStart(5)}  ${k}   e.g. ${v[0]}`);
}
