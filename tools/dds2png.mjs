// Converts a texture from the game archives to PNG for inspection.
// Usage: node tools/dds2png.mjs <path-in-archives> <out.png> [scale]
import { open, writeFile } from 'node:fs/promises';
import { inflateRawSync, deflateSync } from 'node:zlib';
import { ZipArchive, GameFS } from '../src/zip.js';
import { decodeDDS } from '../src/dds.js';
process.removeAllListeners('warning');
const [path, out, scaleArg] = process.argv.slice(2);
const fs = new GameFS();
for (const n of ['x300_000.z2f', 'x301_000.z2f', 'x302_000.z2f']) {
  const fh = await open(new URL(`../orgfiles/${n}`, import.meta.url)); const { size } = await fh.stat();
  fs.add(await ZipArchive.open(n, { size, read: async (o, l) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b; } }, async (b) => new Uint8Array(inflateRawSync(b))));
}
const img = decodeDDS(await fs.read(path));
const s = Number(scaleArg || 1), w = img.width * s, h = img.height * s;
const raw = Buffer.alloc((w * 4 + 1) * h);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const si = ((Math.floor(y / s) * img.width) + Math.floor(x / s)) * 4, di = y * (w * 4 + 1) + 1 + x * 4;
  raw[di] = img.data[si]; raw[di + 1] = img.data[si + 1]; raw[di + 2] = img.data[si + 2]; raw[di + 3] = 255;
}
const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
await writeFile(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log(`${path}: ${img.width}x${img.height} -> ${out}`);
