// Paints the terrain's ground texture the way the original game does, on the GPU.
//
// For every terrain sample the original stamps a brush-shaped patch of its biome's ground
// (or ground-cover) texture into a 256x256 image per 24x24-cell sector (plus a 4-cell margin),
// 8 texels per cell. Interior samples use the small "no blend" brushes, samples at a biome or
// cover boundary use the larger blend brushes; one of four brushes is picked from the sample
// position; stamps are drawn in (transition, biome draw order, biome, cover, y, x) order and
// alpha-blended by brush luminance.
// Algorithm follows OpenZT2's terrain_surface_image_composition (MIT License,
// Copyright (c) OpenZT2 contributors, https://github.com/overyonder/openzt2).
// Here every stamp is an instanced quad rendered into one atlas texture, which is fast enough
// for phones; the CPU would need around a billion pixel operations for a large map.
//
// Cliffs: each biome has five rock textures with strata drawn horizontally (H), vertically (V),
// diagonally (D1, D2) or without direction (U). They are painted into this top-down image on
// cells steeper than world/terrain.xml's cliffZPerMeterHoriz / cliffZPerMeterDiag and then
// stretch up the cliff wall, which turns the drawn bands into horizontal rock layers.
// The per-cell painting and direction rule are our reconstruction; compare with the original.

export const SECTOR_CELLS = 24;
export const MARGIN_CELLS = 4;
const TEXELS_PER_CELL = 8;
const TILE = (SECTOR_CELLS + MARGIN_CELLS * 2) * TEXELS_PER_CELL; // 256

const VS = `#version 300 es
layout(location=0) in vec2 aCorner;      // 0..1 quad corner
layout(location=1) in vec2 aCoord;       // paint coordinate (x, -z) in cells
layout(location=2) in float aSelector;   // brush layer 0..3
uniform vec2 uOrigin;                    // paint coordinate of the tile's corner (cells)
uniform float uStamp;                    // stamp size in texels (brush size)
uniform float uScale;                    // tile pixels per native texel
out vec2 vLocal;
flat out vec2 vCoord;
flat out float vSelector;
void main() {
  vec2 center = (aCoord - uOrigin) * ${TEXELS_PER_CELL}.0;
  vec2 corner = center - vec2(floor(uStamp / 2.0));
  vec2 texel = corner + aCorner * uStamp;
  vLocal = aCorner * uStamp;
  vCoord = aCoord;
  vSelector = aSelector;
  gl_Position = vec4((texel * uScale) / (${TILE}.0 * uScale) * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
in vec2 vLocal;
flat in vec2 vCoord;
flat in float vSelector;
uniform sampler2DArray uBrush;
uniform sampler2D uSource;
out vec4 outColor;
void main() {
  ivec2 local = ivec2(floor(vLocal));
  vec4 b = texelFetch(uBrush, ivec3(local, int(vSelector)), 0) * 255.0;
  int coverage = (int(b.r + 0.5) * 54 + int(b.g + 0.5) * 183 + int(b.b + 0.5) * 19) >> 8;
  if (coverage <= 10) discard;
  ivec2 size = textureSize(uSource, 0);
  ivec2 c = ivec2(floor(vCoord));
  ivec2 src = ivec2(
    ((c.x % size.x + size.x) % size.x * ${TEXELS_PER_CELL} + local.x) % size.x,
    ((c.y % size.y + size.y) % size.y * ${TEXELS_PER_CELL} + local.y) % size.y);
  vec4 color = texelFetch(uSource, src, 0);
  float alpha = coverage >= 246 ? 1.0 : float(coverage) / 255.0;
  outColor = vec4(color.rgb, alpha);
}`;

// terrain: parsed .dat; biomes: Map from loadBiomes; images: async (path) -> {width,height,data} RGBA
// Paths are painted on top: their texture repeats on the original's world lattice of
// 256 texels per 24 cells (OpenZT2 ground path surface projection). Each tile triangle is
// cut out of its whole 3 m square by the original's shared masks (43 lattice texels per
// square): north_mask for N (S mirrored in y), west_mask for W (E mirrored in x); the path
// texture is copied where the mask coverage is above 99 of 255.
const PATH_VS = `#version 300 es
layout(location=0) in vec2 aCell;   // cell coordinates (x, z)
layout(location=1) in vec3 aTile;   // tile's min cell corner (x, z), triangle direction 0..3 = N E S W
uniform vec2 uOrigin;
out vec2 vPaint;
out vec2 vLocal;
flat out int vDir;
void main() {
  vPaint = vec2(aCell.x, -aCell.y);
  vLocal = aCell - aTile.xy;
  vDir = int(aTile.z);
  vec2 texel = (vPaint - uOrigin) * ${TEXELS_PER_CELL}.0;
  gl_Position = vec4(texel / ${TILE}.0 * 2.0 - 1.0, 0.0, 1.0);
}`;
const PATH_FS = `#version 300 es
precision highp float;
precision highp int;
in vec2 vPaint;
in vec2 vLocal;
flat in int vDir;
uniform sampler2D uPath;
uniform sampler2D uMaskNorth;
uniform sampler2D uMaskWest;
out vec4 outColor;
void main() {
  ivec2 m = clamp(ivec2(floor(vLocal * (256.0 / 24.0))), ivec2(0), ivec2(42));
  vec3 c;
  if (vDir == 0) c = texelFetch(uMaskNorth, m, 0).rgb;
  else if (vDir == 2) c = texelFetch(uMaskNorth, ivec2(m.x, 42 - m.y), 0).rgb;
  else if (vDir == 3) c = texelFetch(uMaskWest, m, 0).rgb;
  else c = texelFetch(uMaskWest, ivec2(42 - m.x, m.y), 0).rgb;
  if (floor(dot(floor(c * 255.0 + 0.5), vec3(54.0, 183.0, 19.0)) / 256.0) <= 99.0) discard;
  ivec2 size = textureSize(uPath, 0);
  ivec2 t = ivec2(floor(vPaint * (256.0 / 24.0)));
  outColor = vec4(texelFetch(uPath, ivec2((t.x % size.x + size.x) % size.x, (t.y % size.y + size.y) % size.y), 0).rgb, 1.0);
}`;

// cliffRise: [horizontal, diagonal] metres of rise per metre that make a cell a cliff.
export async function composeTerrainSurface(gl, terrain, biomes, loadImage, cliffRise = [1.6, 2.0], paths = null) {
  const surface = new TerrainSurface(gl, terrain, biomes, cliffRise);
  await surface.loadTextures(loadImage);
  if (paths) {
    surface.setPaths(paths, loadImage);
    await surface.preparePaths();
  }
  for (let sz = 0; sz < surface.sectorsZ; sz++) {
    for (let sx = 0; sx < surface.sectorsX; sx++) {
      surface.composeSector(sx, sz);
      // Let the browser breathe between sectors so loading never freezes the page.
      if ((sz * surface.sectorsX + sx) % 8 === 7) await new Promise((r) => setTimeout(r, 0));
    }
  }
  surface.updateMipmaps();
  return surface;
}

// Owns the composed atlas and everything needed to repaint single sectors after edits.
export class TerrainSurface {
  constructor(gl, terrain, biomes, cliffRise) {
    this.gl = gl;
    this.terrain = terrain;
    this.cliffRise = cliffRise;
    const cellsX = terrain.width - 1, cellsZ = terrain.height - 1;
    this.sectorsX = Math.ceil(cellsX / SECTOR_CELLS);
    this.sectorsZ = Math.ceil(cellsZ / SECTOR_CELLS);
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    // Phones may not allow a 4096 texture; halve the resolution until it fits.
    this.scale = 1;
    while (Math.max(this.sectorsX, this.sectorsZ) * TILE * this.scale > Math.min(maxSize, 4096)) this.scale /= 2;
    this.tileTexels = TILE * this.scale;
    this.atlasW = this.sectorsX * this.tileTexels;
    this.atlasH = this.sectorsZ * this.tileTexels;
    this.mapBiomes = terrain.biomeNames.map((n) => biomes.get(n.toLowerCase()) ?? null);
    this.cliffs = classifyCliffs(terrain, cliffRise);

    this.program = link(gl, VS, FS);
    const p = this.program;
    this.loc = {
      origin: gl.getUniformLocation(p, 'uOrigin'), stamp: gl.getUniformLocation(p, 'uStamp'),
      scale: gl.getUniformLocation(p, 'uScale'), brush: gl.getUniformLocation(p, 'uBrush'),
      source: gl.getUniformLocation(p, 'uSource'),
    };

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(this.atlasW, this.atlasH))) + 1, gl.RGBA8, this.atlasW, this.atlasH);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.inst = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 12, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 12, 8);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);

    // A solid 8x8 "brush" that fills exactly one cell (used for cliff cells).
    this.solid = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.solid);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, TEXELS_PER_CELL, TEXELS_PER_CELL, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array(TEXELS_PER_CELL * TEXELS_PER_CELL * 4 * 4).fill(255));
    setNearest(gl, gl.TEXTURE_2D_ARRAY);
    this.dirtyMipmaps = false;

    this.pathProgram = link(gl, PATH_VS, PATH_FS);
    this.pathLoc = {
      origin: gl.getUniformLocation(this.pathProgram, 'uOrigin'), path: gl.getUniformLocation(this.pathProgram, 'uPath'),
      north: gl.getUniformLocation(this.pathProgram, 'uMaskNorth'), west: gl.getUniformLocation(this.pathProgram, 'uMaskWest'),
    };
    this.pathVao = gl.createVertexArray();
    gl.bindVertexArray(this.pathVao);
    this.pathBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pathBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 20, 8);
    gl.bindVertexArray(null);
    this.paths = null;            // PathGrid
    this.pathTextures = new Map(); // path item -> texture (loaded on demand)
  }

  // paths: PathGrid; loadImage: async path -> decoded image. Call refresh() for changed tiles.
  setPaths(paths, loadImage) {
    this.paths = paths;
    this.loadImage = loadImage;
  }

  async pathMasks() {
    this.pathMaskTextures ??= Promise.all(['north', 'west'].map(async (side) => {
      const img = await this.loadImage(`entities/objects/paths/shared/${side}_mask.dds`);
      if (!img) return null;
      const gl = this.gl, t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.data);
      setNearest(gl, gl.TEXTURE_2D);
      return t;
    }));
    return this.pathMaskTextures;
  }

  async pathTexture(item) {
    if (!this.pathTextures.has(item)) {
      this.pathTextures.set(item, this.loadImage(item.path.texture).then((img) => {
        if (!img) return null;
        const gl = this.gl, t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.data);
        setNearest(gl, gl.TEXTURE_2D);
        return t;
      }));
    }
    return this.pathTextures.get(item);
  }

  // Textures: source images (ground, cover, cliffs) and brush arrays (blend 64px, no-blend 32px) per biome.
  async loadTextures(loadImage) {
    const gl = this.gl;
    const cache = new Map();
    const texture2D = (path) => {
      if (!path) return null;
      const key = path.toLowerCase();
      if (!cache.has(key)) {
        cache.set(key, loadImage(path).then((img) => {
          if (!img) return null;
          const t = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, t);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.data);
          setNearest(gl, gl.TEXTURE_2D);
          return t;
        }));
      }
      return cache.get(key);
    };
    const brushArray = (paths) => {
      if (!paths || paths.some((p) => !p)) return null;
      const key = paths.join('|').toLowerCase();
      if (!cache.has(key)) {
        cache.set(key, Promise.all(paths.map(loadImage)).then((imgs) => {
          if (imgs.some((i) => !i)) return null;
          const { width, height } = imgs[0];
          const t = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
          gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, width, height, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          imgs.forEach((img, i) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, width, height, 1, gl.RGBA, gl.UNSIGNED_BYTE, img.data));
          setNearest(gl, gl.TEXTURE_2D_ARRAY);
          return { texture: t, size: width };
        }));
      }
      return cache.get(key);
    };
    this.res = [];
    for (const b of this.mapBiomes) {
      this.res.push(b ? {
        cliffs: await Promise.all(b.cliffs.map(texture2D)), // H, V, D1, D2, U
        ground: await texture2D(b.ground), cover: await texture2D(b.cover),
        groundBrushes: await brushArray(b.groundBrushes), coverBrushes: await brushArray(b.coverBrushes),
        groundNoBlend: await brushArray(b.groundNoBlend), coverNoBlend: await brushArray(b.coverNoBlend),
      } : null);
    }
  }

  // Repaints the sectors whose images include any cell in [x0, x1] x [z0, z1] (cell coordinates),
  // after the heights (cliffs) or biome/cover samples there changed.
  refresh(x0, z0, x1, z1) {
    this.cliffs = classifyCliffs(this.terrain, this.cliffRise, this.cliffs, x0 - 1, z0 - 1, x1 + 1, z1 + 1);
    const sx0 = Math.max(0, Math.floor((x0 - MARGIN_CELLS - 1) / SECTOR_CELLS));
    const sx1 = Math.min(this.sectorsX - 1, Math.floor((x1 + MARGIN_CELLS + 1) / SECTOR_CELLS));
    const sz0 = Math.max(0, Math.floor((z0 - MARGIN_CELLS - 1) / SECTOR_CELLS));
    const sz1 = Math.min(this.sectorsZ - 1, Math.floor((z1 + MARGIN_CELLS + 1) / SECTOR_CELLS));
    for (let sz = sz0; sz <= sz1; sz++) for (let sx = sx0; sx <= sx1; sx++) this.composeSector(sx, sz);
    this.dirtyMipmaps = true;
  }

  // Regenerates the atlas mipmaps (distant view) after edits; call at most a few times a second.
  updateMipmaps() {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.dirtyMipmaps = false;
  }

  composeSector(sx, sz) {
    const { gl, terrain, loc, res, mapBiomes } = this;
    const W = terrain.width, H = terrain.height;
    const tile = this.tileTexels;
    const sampleAt = (x, z) => Math.min(H - 1, Math.max(0, z)) * W + Math.min(W - 1, Math.max(0, x));
    const span = SECTOR_CELLS + MARGIN_CELLS * 2;
    // Paint coordinates are (x, -z); this tile covers source samples x in [sx*24-4, sx*24+28]
    // and z in [sz*24-4, sz*24+28], i.e. paint y in [-(sz+1)*24-4, ...].
    const origin = [sx * SECTOR_CELLS - MARGIN_CELLS, -(sz + 1) * SECTOR_CELLS - MARGIN_CELLS];
    const paints = [];
    for (let py = origin[1]; py <= origin[1] + span; py++) {
      for (let px = origin[0]; px <= origin[0] + span; px++) {
        const i = sampleAt(px, -py);
        paints.push({ x: px, y: py, biome: terrain.biome[i], cover: terrain.cover[i] !== 0 });
      }
    }
    const side = span + 1;
    const snapshot = paints.map((p) => [p.biome, p.cover]);
    paints.forEach((p, index) => {
      const x = index % side, y = Math.floor(index / side);
      p.transition = false;
      for (let ny = Math.max(0, y - 1); ny <= Math.min(side - 1, y + 1) && !p.transition; ny++) {
        for (let nx = Math.max(0, x - 1); nx <= Math.min(side - 1, x + 1); nx++) {
          const o = snapshot[ny * side + nx];
          if (o[0] !== p.biome || o[1] !== p.cover) { p.transition = true; break; }
        }
      }
      p.order = mapBiomes[p.biome]?.drawOrder ?? 0;
    });
    paints.sort((a, b) => (a.transition - b.transition) || (a.order - b.order) || (a.biome - b.biome)
      || (a.cover - b.cover) || (a.y - b.y) || (a.x - b.x));

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform1i(loc.brush, 0);
    gl.uniform1i(loc.source, 1);
    gl.uniform1f(loc.scale, this.scale);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(sx * tile, sz * tile, tile, tile);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(sx * tile, sz * tile, tile, tile);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(loc.origin, origin[0], origin[1]);

    // Draw consecutive runs that share textures as one instanced call.
    let start = 0;
    while (start < paints.length) {
      const p0 = paints[start];
      let end = start + 1;
      while (end < paints.length && paints[end].transition === p0.transition && paints[end].biome === p0.biome && paints[end].cover === p0.cover) end++;
      const r = res[p0.biome];
      const brush = r && (p0.transition ? (p0.cover ? r.coverBrushes : r.groundBrushes) : (p0.cover ? r.coverNoBlend : r.groundNoBlend));
      const source = r && (p0.cover ? r.cover : r.ground);
      if (brush && source) {
        const data = new Float32Array((end - start) * 3);
        for (let k = start; k < end; k++) {
          const p = paints[k];
          data[(k - start) * 3] = p.x;
          data[(k - start) * 3 + 1] = p.y;
          data[(k - start) * 3 + 2] = (((p.x * 13 + p.y * 7 + 20) % 4) + 4) % 4;
        }
        this.drawStamps(data, brush.texture, source, brush.size);
      }
      start = end;
    }
    // Rock on cliff cells, grouped by texture (biome + direction).
    const cliffRuns = new Map();
    for (let cz = sz * SECTOR_CELLS - MARGIN_CELLS; cz < (sz + 1) * SECTOR_CELLS + MARGIN_CELLS; cz++) {
      if (cz < 0 || cz >= H - 1) continue;
      for (let cx = sx * SECTOR_CELLS - MARGIN_CELLS; cx < (sx + 1) * SECTOR_CELLS + MARGIN_CELLS; cx++) {
        if (cx < 0 || cx >= W - 1) continue;
        const kind = this.cliffs[cz * (W - 1) + cx];
        if (kind < 0) continue;
        const tex = res[terrain.biome[cz * W + cx]]?.cliffs[kind];
        if (!tex) continue;
        if (!cliffRuns.has(tex)) cliffRuns.set(tex, []);
        cliffRuns.get(tex).push(cx + 0.5, -cz - 0.5, 0);
      }
    }
    for (const [tex, list] of cliffRuns) this.drawStamps(new Float32Array(list), this.solid, tex, TEXELS_PER_CELL);

    // Paths on top (textures must already be loaded: see preparePaths).
    if (this.paths) {
      const groups = this.paths.trianglesInCells(sx * SECTOR_CELLS - MARGIN_CELLS, sz * SECTOR_CELLS - MARGIN_CELLS,
        (sx + 1) * SECTOR_CELLS + MARGIN_CELLS, (sz + 1) * SECTOR_CELLS + MARGIN_CELLS, 4);
      if (groups.size && this.readyMasks?.every(Boolean)) {
        gl.useProgram(this.pathProgram);
        gl.bindVertexArray(this.pathVao);
        gl.disable(gl.BLEND);
        gl.uniform2f(this.pathLoc.origin, origin[0], origin[1]);
        gl.uniform1i(this.pathLoc.path, 1);
        gl.uniform1i(this.pathLoc.north, 2);
        gl.uniform1i(this.pathLoc.west, 3);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.readyMasks[0]);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, this.readyMasks[1]);
        gl.activeTexture(gl.TEXTURE1);
        for (const [item, list] of groups) {
          const tex = this.readyPathTextures?.get(item);
          if (!tex) continue;
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.pathBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(list), gl.STREAM_DRAW);
          gl.drawArrays(gl.TRIANGLES, 0, list.length / 5);
        }
        gl.enable(gl.BLEND);
      }
    }

    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }

  // Loads the textures of every path type in use, so composeSector can draw synchronously.
  async preparePaths() {
    this.readyPathTextures ??= new Map();
    this.readyMasks ??= await this.pathMasks();
    for (const t of this.paths?.tiles.values() ?? []) {
      if (!this.readyPathTextures.has(t.item)) this.readyPathTextures.set(t.item, await this.pathTexture(t.item));
    }
  }

  drawStamps(data, brushTexture, sourceTexture, stampSize) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, brushTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
    gl.uniform1f(this.loc.stamp, stampSize);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, data.length / 3);
  }
}

// Per cell: -1 for normal ground, else the cliff texture index 0 H, 1 V, 2 D1, 3 D2, 4 U.
// H = strata along x (wall facing +-y), V = along y (wall facing +-x).
// With `out` and a cell range, only that range is reclassified.
function classifyCliffs(t, [riseHoriz, riseDiag], out = null, x0 = 0, z0 = 0, x1 = Infinity, z1 = Infinity) {
  const W = t.width, H = t.height, cell = t.cellSize;
  out ??= new Int8Array((W - 1) * (H - 1)).fill(-1);
  const h = (x, z) => t.heights[z * W + x];
  for (let z = Math.max(0, z0); z < Math.min(H - 1, z1 + 1); z++) {
    for (let x = Math.max(0, x0); x < Math.min(W - 1, x1 + 1); x++) {
      out[z * (W - 1) + x] = -1;
      const dx = ((h(x + 1, z) - h(x, z)) + (h(x + 1, z + 1) - h(x, z + 1))) / (2 * cell);
      const dz = ((h(x, z + 1) - h(x, z)) + (h(x + 1, z + 1) - h(x + 1, z))) / (2 * cell);
      const ax = Math.abs(dx), az = Math.abs(dz);
      const diagonal = ax > 0.5 * az && az > 0.5 * ax;
      if (Math.hypot(dx, dz) <= (diagonal ? riseDiag : riseHoriz)) continue;
      let kind;
      if (az >= 2 * ax) kind = 0;
      else if (ax >= 2 * az) kind = 1;
      else if (diagonal) kind = dx * dz > 0 ? 2 : 3;
      else kind = 4;
      out[z * (W - 1) + x] = kind;
    }
  }
  return out;
}

function setNearest(gl, target) {
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.REPEAT);
}

function link(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}
