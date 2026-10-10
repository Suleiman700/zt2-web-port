// Parser for Zoo Tycoon 2 terrain files (maps/**/*.dat).
// Layout cross-checked against OpenZT2 (MIT License, Copyright (c) OpenZT2 contributors,
// https://github.com/overyonder/openzt2), assets/terrain/source/blue_fang_terrain_source_parsing.
//
// Header (44 bytes): u32 version, f32 extentX, f32 extentY, ..., u32 width @28, u32 height @32,
//   u32 sectorColumns @36, u32 sectorRows @40   (width/height count samples, i.e. cells + 1)
// Then: u32 biomeCount, biomeCount x (u32 length, chars)  -- biome names, index = sample biome
// Then width*height samples whose layout grows with the version:
//   f32 height | v>=8: f32 relativeHeight | v>0: u32 biome, u8 cover, u32 water
//   | v>=6: u8 constraint, f32 min, f32 max | v>=9: u8 link | v>=11: u8 noElevatedPath | v>=13: u8 waterSurface
// Then: u32 waterRegionCount, regions (f32 height, u32 style, u32 n, n x u32 cell index, v13/14 extras)
// Then one slope-orientation byte (2 bytes from v11) per 4x4-cell slope tile.

const td = new TextDecoder('latin1');

export function parseTerrainDat(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (o) => dv.getUint32(o, true);
  const f32 = (o) => dv.getFloat32(o, true);
  const version = u32(0);
  if (version > 14) throw new Error(`Unsupported terrain version ${version}`);
  const extentX = f32(4), extentY = f32(8);
  const width = u32(28), height = u32(32);
  if (width < 2 || height < 2 || (width - 1) % 4 || (height - 1) % 4) throw new Error('Invalid terrain size');

  let p = 44;
  const biomeNames = [];
  for (let n = u32(p), i = (p += 4, 0); i < n; i++) {
    const len = u32(p);
    let s = td.decode(bytes.subarray(p + 4, p + 4 + len));
    if (s.endsWith('\0')) s = s.slice(0, -1);
    biomeNames.push(s);
    p += 4 + len;
  }

  // Sample record layout for this version.
  let stride = 4;
  const off = { height: 0 };
  if (version >= 8) { off.relative = stride; stride += 4; }
  if (version > 0) { off.biome = stride; off.cover = stride + 4; off.water = stride + 5; stride += 9; }
  if (version >= 6) { off.constraint = stride; off.min = stride + 1; off.max = stride + 5; stride += 9; }
  if (version >= 9) { off.link = stride; stride += 1; }
  if (version >= 11) { off.noElevatedPath = stride; stride += 1; }
  if (version >= 13) { off.waterSurface = stride; stride += 1; }

  const count = width * height;
  const heights = new Float32Array(count);
  const biome = new Uint8Array(count);
  const cover = new Uint8Array(count);
  const water = new Uint8Array(count); // 0 dry, 1 shallow, 2 deep
  for (let i = 0; i < count; i++) {
    const s = p + i * stride;
    heights[i] = f32(s);
    if (off.biome !== undefined) {
      biome[i] = u32(s + off.biome);
      cover[i] = bytes[s + off.cover];
      water[i] = u32(s + off.water);
    }
  }
  p += count * stride;

  const waterRegions = [];
  if (p < bytes.length) {
    const n = u32(p); p += 4;
    for (let r = 0; r < n; r++) {
      const region = { height: f32(p), style: u32(p + 4), cells: [] };
      const cells = u32(p + 8); p += 12;
      for (let c = 0; c < cells; c++) region.cells.push(u32(p + c * 4));
      p += cells * 4;
      if (version === 13) { region.depthRatio = f32(p); region.tankMinimum = (u32(p + 4) & 0xff) !== 0; p += 8; }
      else if (version === 14) { region.depthRatio = f32(p); region.tankMinimum = bytes[p + 4] !== 0; p += 5; }
      waterRegions.push(region);
    }
  }

  return {
    version,
    width, height,                     // samples
    cellSize: extentX / (width - 1),   // metres per cell
    extentX, extentY,
    biomeNames, heights, biome, cover, water, waterRegions,
  };
}
