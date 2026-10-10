// Reports why entity definitions are excluded from the catalog. Usage: node tools/debug-catalog.mjs <archives...>
import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { ZipArchive, GameFS } from '../src/zip.js';
process.removeAllListeners('warning');
const fs = new GameFS();
for (const a of process.argv.slice(2).sort()) {
  const fh = await open(a); const { size } = await fh.stat();
  fs.add(await ZipArchive.open(a, { size, read: async (o, l) => { const b = new Uint8Array(l); await fh.read(b, 0, l, o); return b; } }, async (b) => new Uint8Array(inflateRawSync(b))));
}
const reasons = {}; const ex = {};
for (const p of fs.list((k) => k.startsWith('entities/') && k.includes('/ai/') && k.endsWith('.xml'))) {
  const s = new TextDecoder().decode(await fs.read(p));
  if (/abstract="true"/.test(s)) continue;
  const model = /(?:modelfile|actorfile)="([^"]+\.(?:nif|bfm))"/i.exec(s)?.[1];
  const icon = /<UIAspect>\s*<default image="([^"]+)"/.exec(s)?.[1];
  const r = !icon ? 'no-icon' : !model ? 'no-model' : !fs.has(model) ? 'model-missing' : 'ok';
  reasons[r] = (reasons[r] || 0) + 1;
  (ex[r] ||= []).push(p + (model ? ' -> ' + model : ''));
}
console.log(reasons);
for (const r in ex) console.log(r, ex[r].filter((_, i) => i % Math.ceil(ex[r].length / 6) === 0));
