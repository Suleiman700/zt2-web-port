// Minimal read-only ZIP reader for .z2f archives.
// `source` must provide: size (number) and read(offset, length) -> Promise<Uint8Array>.
// `inflateRaw(Uint8Array) -> Promise<Uint8Array>` is injected so this works in browser and Node.

const td = new TextDecoder('utf-8');

export class ZipArchive {
  constructor(name, source, inflateRaw) {
    this.name = name;
    this.source = source;
    this.inflateRaw = inflateRaw;
    this.entries = new Map(); // lowercase normalized path -> entry
  }

  static async open(name, source, inflateRaw) {
    const zip = new ZipArchive(name, source, inflateRaw);
    await zip._readDirectory();
    return zip;
  }

  async _readDirectory() {
    const { source } = this;
    const tailLen = Math.min(source.size, 65557);
    const tail = await source.read(source.size - tailLen, tailLen);
    const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error(`${this.name}: not a ZIP archive`);
    const count = dv.getUint16(eocd + 10, true);
    const cdSize = dv.getUint32(eocd + 12, true);
    const cdOffset = dv.getUint32(eocd + 16, true);
    const cd = await source.read(cdOffset, cdSize);
    const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cv.getUint32(p, true) !== 0x02014b50) throw new Error(`${this.name}: bad central directory`);
      const method = cv.getUint16(p + 10, true);
      const compSize = cv.getUint32(p + 20, true);
      const size = cv.getUint32(p + 24, true);
      const nameLen = cv.getUint16(p + 28, true);
      const extraLen = cv.getUint16(p + 30, true);
      const commentLen = cv.getUint16(p + 32, true);
      const localOffset = cv.getUint32(p + 42, true);
      const path = td.decode(cd.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (path.endsWith('/')) continue;
      this.entries.set(normalizePath(path), { path, method, compSize, size, localOffset, nameLen, extraLen, archive: this });
    }
  }

  async readEntry(entry) {
    // Read the local header and data in one request, guessing the header's variable part;
    // fall back to a second read if the guess was too small.
    const guess = 30 + entry.nameLen + entry.extraLen + 64;
    const chunk = await this.source.read(entry.localOffset, Math.min(guess + entry.compSize, this.source.size - entry.localOffset));
    const hv = new DataView(chunk.buffer, chunk.byteOffset, 30);
    if (hv.getUint32(0, true) !== 0x04034b50) throw new Error(`${entry.path}: bad local header`);
    const headerLen = 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
    const raw = headerLen + entry.compSize <= chunk.length
      ? chunk.subarray(headerLen, headerLen + entry.compSize)
      : await this.source.read(entry.localOffset + headerLen, entry.compSize);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return this.inflateRaw(raw);
    throw new Error(`${entry.path}: unsupported compression method ${entry.method}`);
  }

  // The first bytes of an entry without reading all of it (e.g. a map save's header), using
  // `inflatePartial(Uint8Array) -> Promise<Uint8Array>` that tolerates a truncated stream.
  async readEntryPrefix(entry, bytes, inflatePartial) {
    if (!inflatePartial || entry.method !== 8) return (await this.readEntry(entry)).subarray(0, bytes);
    const head = await this.source.read(entry.localOffset, 30);
    const hv = new DataView(head.buffer, head.byteOffset, 30);
    const headerLen = 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
    // Text compresses well: a quarter of the wanted size (plus slack) is plenty of input.
    const want = Math.min(entry.compSize, Math.max(4096, Math.ceil(bytes / 2)));
    const raw = await this.source.read(entry.localOffset + headerLen, want);
    return (await inflatePartial(raw)).subarray(0, bytes);
  }
}

export function normalizePath(p) {
  return p.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

// Virtual file system over several archives. Archives added later override earlier ones,
// matching how the game layers its expansion packs.
export class GameFS {
  constructor() { this.files = new Map(); }

  add(zip) {
    for (const [key, entry] of zip.entries) this.files.set(key, entry);
  }

  has(path) { return this.files.has(normalizePath(path)); }

  async read(path) {
    const entry = this.files.get(normalizePath(path));
    if (!entry) throw new Error(`File not found: ${path}`);
    return entry.archive.readEntry(entry);
  }

  async readPrefix(path, bytes) {
    const entry = this.files.get(normalizePath(path));
    if (!entry) throw new Error(`File not found: ${path}`);
    return entry.archive.readEntryPrefix(entry, bytes, this.inflatePartial);
  }

  list(filter) {
    const out = [];
    for (const [key, entry] of this.files) if (!filter || filter(key)) out.push(entry.path);
    return out.sort();
  }
}
