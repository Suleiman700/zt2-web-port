// DDS texture decoder. Decodes the top mip level to RGBA8 so it works on every GPU,
// including mobile GPUs without S3TC/DXT support.
// Formats used by Zoo Tycoon 2: DXT1, DXT3, DXT5, and uncompressed 8/16/24/32-bit RGB(A).

// Decodes the top level, plus (when withMips) the file's own mipmap chain as `mips`
// ([{ width, height, data }], level 0 first). The game's hand-made mip levels keep thin
// alpha-tested details (fence wire, leaves) intact at a distance, unlike averaged mipmaps.
export function decodeDDS(bytes, withMips = false) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x20534444) throw new Error('Not a DDS file');
  const flags = dv.getUint32(8, true);
  const levels = withMips && (flags & 0x20000) ? Math.max(1, dv.getUint32(28, true)) : 1;
  const top = decodeLevel(bytes, dv, 128, dv.getUint32(16, true), dv.getUint32(12, true));
  if (levels === 1) return top;
  const mips = [{ width: top.width, height: top.height, data: top.data }];
  let offset = 128 + top.byteSize, w = top.width, h = top.height;
  for (let i = 1; i < levels; i++) {
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
    if (offset >= bytes.length) break;
    const level = decodeLevel(bytes, dv, offset, w, h);
    mips.push({ width: w, height: h, data: level.data });
    offset += level.byteSize;
  }
  return { ...top, mips };
}

function decodeLevel(bytes, dv, start, width, height) {
  const pfFlags = dv.getUint32(80, true);
  const fourCC = String.fromCharCode(bytes[84], bytes[85], bytes[86], bytes[87]);
  const bits = dv.getUint32(88, true);
  const masks = [dv.getUint32(92, true), dv.getUint32(96, true), dv.getUint32(100, true), dv.getUint32(104, true)];
  const data = bytes.subarray(start);
  const out = new Uint8Array(width * height * 4);

  if (pfFlags & 4) {
    if (fourCC === 'DXT1') decodeBlocks(data, out, width, height, 8, decodeDXT1Block);
    else if (fourCC === 'DXT3') decodeBlocks(data, out, width, height, 16, decodeDXT3Block);
    else if (fourCC === 'DXT5') decodeBlocks(data, out, width, height, 16, decodeDXT5Block);
    else throw new Error(`Unsupported DDS format ${fourCC}`);
    const blockSize = fourCC === 'DXT1' ? 8 : 16;
    const byteSize = Math.max(1, (width + 3) >> 2) * Math.max(1, (height + 3) >> 2) * blockSize;
    return { width, height, data: out, hasAlpha: fourCC !== 'DXT1', byteSize };
  }

  // Uncompressed: decode via channel bit masks.
  const bpp = bits >> 3;
  const luminance = (pfFlags & 0x20000) !== 0;
  const hasAlpha = (pfFlags & 1) !== 0 && masks[3] !== 0;
  const shifts = masks.map(maskShift);
  const scales = masks.map((m) => (m ? 255 / (m >>> maskShift(m)) : 0));
  for (let i = 0, p = 0; i < width * height; i++, p += bpp) {
    let v = 0;
    for (let b = 0; b < bpp; b++) v |= data[p + b] << (8 * b);
    v >>>= 0;
    const o = i * 4;
    if (luminance) {
      const l = ((v & masks[0]) >>> shifts[0]) * scales[0];
      out[o] = out[o + 1] = out[o + 2] = l;
    } else {
      out[o] = ((v & masks[0]) >>> shifts[0]) * scales[0];
      out[o + 1] = ((v & masks[1]) >>> shifts[1]) * scales[1];
      out[o + 2] = ((v & masks[2]) >>> shifts[2]) * scales[2];
    }
    out[o + 3] = hasAlpha ? ((v & masks[3]) >>> shifts[3]) * scales[3] : 255;
  }
  return { width, height, data: out, hasAlpha, byteSize: width * height * bpp };
}

function maskShift(m) {
  if (!m) return 0;
  let s = 0;
  while (((m >>> s) & 1) === 0) s++;
  return s;
}

function decodeBlocks(data, out, width, height, blockSize, decodeBlock) {
  const bw = Math.max(1, (width + 3) >> 2);
  const bh = Math.max(1, (height + 3) >> 2);
  const block = new Uint8Array(64);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const off = (by * bw + bx) * blockSize;
      if (off + blockSize > data.length) return;
      decodeBlock(data, off, block);
      for (let y = 0; y < 4; y++) {
        const py = by * 4 + y;
        if (py >= height) break;
        for (let x = 0; x < 4; x++) {
          const px = bx * 4 + x;
          if (px >= width) break;
          const o = (py * width + px) * 4, s = (y * 4 + x) * 4;
          out[o] = block[s]; out[o + 1] = block[s + 1]; out[o + 2] = block[s + 2]; out[o + 3] = block[s + 3];
        }
      }
    }
  }
}

const palette = new Uint8Array(16);

function colorBlock(d, off, block, allowTransparent) {
  const c0 = d[off] | (d[off + 1] << 8);
  const c1 = d[off + 2] | (d[off + 3] << 8);
  rgb565(c0, palette, 0);
  rgb565(c1, palette, 4);
  palette[3] = palette[7] = 255;
  if (c0 > c1 || !allowTransparent) {
    for (let i = 0; i < 3; i++) {
      palette[8 + i] = (2 * palette[i] + palette[4 + i]) / 3;
      palette[12 + i] = (palette[i] + 2 * palette[4 + i]) / 3;
    }
    palette[11] = palette[15] = 255;
  } else {
    for (let i = 0; i < 3; i++) { palette[8 + i] = (palette[i] + palette[4 + i]) >> 1; palette[12 + i] = 0; }
    palette[11] = 255;
    palette[15] = 0;
  }
  for (let i = 0; i < 16; i++) {
    const idx = (d[off + 4 + (i >> 2)] >> ((i & 3) * 2)) & 3;
    block[i * 4] = palette[idx * 4];
    block[i * 4 + 1] = palette[idx * 4 + 1];
    block[i * 4 + 2] = palette[idx * 4 + 2];
    block[i * 4 + 3] = palette[idx * 4 + 3];
  }
}

function rgb565(c, out, o) {
  const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
  out[o] = (r << 3) | (r >> 2);
  out[o + 1] = (g << 2) | (g >> 4);
  out[o + 2] = (b << 3) | (b >> 2);
}

function decodeDXT1Block(d, off, block) { colorBlock(d, off, block, true); }

function decodeDXT3Block(d, off, block) {
  colorBlock(d, off + 8, block, false);
  for (let i = 0; i < 16; i++) {
    const a = (d[off + (i >> 1)] >> ((i & 1) * 4)) & 15;
    block[i * 4 + 3] = a * 17;
  }
}

const alphas = new Uint8Array(8);
function decodeDXT5Block(d, off, block) {
  colorBlock(d, off + 8, block, false);
  const a0 = d[off], a1 = d[off + 1];
  alphas[0] = a0; alphas[1] = a1;
  if (a0 > a1) for (let i = 1; i < 7; i++) alphas[i + 1] = ((7 - i) * a0 + i * a1) / 7;
  else { for (let i = 1; i < 5; i++) alphas[i + 1] = ((5 - i) * a0 + i * a1) / 5; alphas[6] = 0; alphas[7] = 255; }
  // 48 bits of 3-bit indices
  let lo = d[off + 2] | (d[off + 3] << 8) | (d[off + 4] << 16);
  let hi = d[off + 5] | (d[off + 6] << 8) | (d[off + 7] << 16);
  for (let i = 0; i < 16; i++) {
    const bits = i < 8 ? (lo >> (i * 3)) & 7 : (hi >> ((i - 8) * 3)) & 7;
    block[i * 4 + 3] = alphas[bits];
  }
}
