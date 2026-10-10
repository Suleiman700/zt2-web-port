// Renders an original-map terrain: one mesh per 24x24-cell sector, textured from the
// composed surface atlas (terrainsurface.js), plus water regions.
import { SECTOR_CELLS, MARGIN_CELLS } from './terrainsurface.js';

const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
uniform mat4 uViewProj;
out vec3 vPos;
out vec3 vNormal;
void main() {
  vPos = aPos;
  vNormal = aNormal;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vPos;
in vec3 vNormal;
uniform sampler2D uAtlas;
uniform vec2 uSector;        // sector x, z
uniform float uCell;         // metres per cell
uniform float uTile;         // atlas texels per sector tile
uniform vec2 uAtlasSize;
uniform vec3 uAmbientLight;
uniform vec3 uLightDir[3];   // world/lights terrainLights: sun, side, back
uniform vec3 uLightColor[3];
uniform float uGrid;         // grid line spacing in metres, 0 = off
uniform vec3 uBrush;         // terrain tool brush: centre x, y and radius in metres (radius 0 = off)
out vec4 outColor;
void main() {
  vec2 cells = vPos.xy / uCell;
  vec2 paint = vec2(cells.x, -cells.y);
  vec2 origin = vec2(uSector.x * ${SECTOR_CELLS}.0 - ${MARGIN_CELLS}.0, -(uSector.y + 1.0) * ${SECTOR_CELLS}.0 - ${MARGIN_CELLS}.0);
  vec2 texel = (paint - origin) / ${SECTOR_CELLS + MARGIN_CELLS * 2}.0 * uTile;
  vec2 uv = (uSector * uTile + texel) / uAtlasSize;
  vec3 base = texture(uAtlas, uv).rgb;
  vec3 n = normalize(vNormal);
  vec3 light = uAmbientLight;
  for (int i = 0; i < 3; i++) light += uLightColor[i] * max(dot(n, uLightDir[i]), 0.0);
  vec3 color = base * clamp(light, 0.0, 1.0);
  if (uGrid > 0.0) {
    vec2 g = abs(fract(vPos.xy / uGrid + 0.5) - 0.5) * uGrid;
    float line = 1.0 - smoothstep(0.0, 0.05, min(g.x, g.y));
    color = mix(color, vec3(1.0), line * 0.3);
  }
  if (uBrush.z > 0.0) {
    float d = distance(vPos.xy, uBrush.xy);
    float ring = 1.0 - smoothstep(0.0, 0.12, abs(d - uBrush.z));
    color = mix(color, vec3(1.0, 0.95, 0.4), ring * 0.9);
    color = mix(color, vec3(1.0, 1.0, 0.8), (1.0 - step(uBrush.z, d)) * 0.08);
  }
  outColor = vec4(color, 1.0);
}`;

export class TerrainRenderer {
  constructor(gl, terrain, surface) {
    this.gl = gl;
    this.terrain = terrain;
    this.surface = surface;
    this.program = link(gl, VS, FS);
    this.u = {};
    for (const n of ['uViewProj', 'uAtlas', 'uSector', 'uCell', 'uTile', 'uAtlasSize', 'uAmbientLight', 'uLightDir', 'uLightColor', 'uGrid', 'uBrush']) this.u[n] = gl.getUniformLocation(this.program, n);
    this.grid = 0;
    this.brush = null; // [x, y, radius] while a terrain tool is active
    this.chunks = [];
    const W = terrain.width, H = terrain.height, cell = terrain.cellSize;
    const normals = this.normals = computeNormals(terrain);
    for (let sz = 0; sz < surface.sectorsZ; sz++) {
      for (let sx = 0; sx < surface.sectorsX; sx++) {
        const x0 = sx * SECTOR_CELLS, z0 = sz * SECTOR_CELLS;
        const x1 = Math.min(W - 1, x0 + SECTOR_CELLS), z1 = Math.min(H - 1, z0 + SECTOR_CELLS);
        const nx = x1 - x0 + 1, nz = z1 - z0 + 1;
        const pos = new Float32Array(nx * nz * 3), nor = new Float32Array(nx * nz * 3);
        let minZ = Infinity, maxZ = -Infinity;
        for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
          const s = (z0 + j) * W + (x0 + i), v = (j * nx + i) * 3;
          pos[v] = (x0 + i) * cell; pos[v + 1] = (z0 + j) * cell; pos[v + 2] = terrain.heights[s];
          nor[v] = normals[s * 3]; nor[v + 1] = normals[s * 3 + 1]; nor[v + 2] = normals[s * 3 + 2];
          minZ = Math.min(minZ, pos[v + 2]); maxZ = Math.max(maxZ, pos[v + 2]);
        }
        const idx = new Uint16Array((nx - 1) * (nz - 1) * 6);
        let k = 0;
        for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
          const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
          idx[k++] = a; idx[k++] = b; idx[k++] = d; idx[k++] = a; idx[k++] = d; idx[k++] = c;
        }
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        const bufs = [buffer(gl, 0, pos, 3), buffer(gl, 1, nor, 3)];
        const ib = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
        gl.bindVertexArray(null);
        this.chunks.push({
          sx, sz, vao, bufs: [...bufs, ib], count: idx.length, x0, z0, nx, nz, pos, nor,
          bounds: { min: [x0 * cell, z0 * cell, minZ], max: [x1 * cell, z1 * cell, maxZ] },
        });
      }
    }
  }

  // lighting: { ambient, lights: [{ color, direction }] } (terrainLights from lighting.js)
  draw(viewProj, lighting) {
    const { gl, u, surface, terrain } = this;
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(u.uViewProj, false, viewProj);
    gl.uniform1f(u.uCell, terrain.cellSize);
    gl.uniform1f(u.uTile, surface.tileTexels);
    gl.uniform2f(u.uAtlasSize, surface.atlasW, surface.atlasH);
    gl.uniform3fv(u.uAmbientLight, lighting.ambient);
    gl.uniform3fv(u.uLightDir, lighting.lights.flatMap((l) => l.direction));
    gl.uniform3fv(u.uLightColor, lighting.lights.flatMap((l) => l.color));
    gl.uniform1f(u.uGrid, this.grid);
    gl.uniform3fv(u.uBrush, this.brush ?? [0, 0, 0]);
    gl.uniform1i(u.uAtlas, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, surface.texture);
    for (const c of this.chunks) {
      if (!boxVisible(viewProj, c.bounds)) continue; // skip off-screen sectors
      gl.uniform2f(u.uSector, c.sx, c.sz);
      gl.bindVertexArray(c.vao);
      gl.drawElements(gl.TRIANGLES, c.count, gl.UNSIGNED_SHORT, 0);
    }
    gl.bindVertexArray(null);
    gl.disable(gl.CULL_FACE);
  }

  // Rebuilds normals and vertex buffers for samples in [x0, x1] x [z0, z1] after height edits.
  updateRegion(x0, z0, x1, z1) {
    const { gl, terrain: t } = this;
    const W = t.width, H = t.height, c = t.cellSize;
    const h = (x, z) => t.heights[Math.min(H - 1, Math.max(0, z)) * W + Math.min(W - 1, Math.max(0, x))];
    for (let z = Math.max(0, z0 - 1); z <= Math.min(H - 1, z1 + 1); z++) {
      for (let x = Math.max(0, x0 - 1); x <= Math.min(W - 1, x1 + 1); x++) {
        const dx = (h(x + 1, z) - h(x - 1, z)) / (2 * c), dz = (h(x, z + 1) - h(x, z - 1)) / (2 * c);
        const l = Math.hypot(dx, dz, 1), i = (z * W + x) * 3;
        this.normals[i] = -dx / l; this.normals[i + 1] = -dz / l; this.normals[i + 2] = 1 / l;
      }
    }
    for (const ch of this.chunks) {
      if (ch.x0 > x1 + 1 || ch.x0 + ch.nx - 1 < x0 - 1 || ch.z0 > z1 + 1 || ch.z0 + ch.nz - 1 < z0 - 1) continue;
      let minZ = Infinity, maxZ = -Infinity;
      for (let j = 0; j < ch.nz; j++) for (let i = 0; i < ch.nx; i++) {
        const sIdx = (ch.z0 + j) * W + (ch.x0 + i), v = (j * ch.nx + i) * 3;
        ch.pos[v + 2] = t.heights[sIdx];
        ch.nor[v] = this.normals[sIdx * 3]; ch.nor[v + 1] = this.normals[sIdx * 3 + 1]; ch.nor[v + 2] = this.normals[sIdx * 3 + 2];
        minZ = Math.min(minZ, ch.pos[v + 2]); maxZ = Math.max(maxZ, ch.pos[v + 2]);
      }
      ch.bounds.min[2] = minZ; ch.bounds.max[2] = maxZ;
      gl.bindBuffer(gl.ARRAY_BUFFER, ch.bufs[0]);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, ch.pos);
      gl.bindBuffer(gl.ARRAY_BUFFER, ch.bufs[1]);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, ch.nor);
    }
  }

  // Bilinear height at world (x, y).
  heightAt(x, y) {
    const t = this.terrain;
    const fx = Math.min(t.width - 1.001, Math.max(0, x / t.cellSize));
    const fz = Math.min(t.height - 1.001, Math.max(0, y / t.cellSize));
    const i = Math.floor(fx), j = Math.floor(fz), a = fx - i, b = fz - j;
    const h = (ii, jj) => t.heights[jj * t.width + ii];
    return (h(i, j) * (1 - a) + h(i + 1, j) * a) * (1 - b) + (h(i, j + 1) * (1 - a) + h(i + 1, j + 1) * a) * b;
  }

  // First intersection of a ray with the terrain surface (ray marching + refinement).
  raycast(ray) {
    const maxDist = 2000;
    let t = 0, step = 1;
    let prevAbove = true, prevT = 0;
    for (; t < maxDist; t += step) {
      const x = ray.origin[0] + ray.dir[0] * t, y = ray.origin[1] + ray.dir[1] * t, z = ray.origin[2] + ray.dir[2] * t;
      const inside = x >= 0 && y >= 0 && x <= this.size[0] && y <= this.size[1];
      const above = !inside || z > this.heightAt(x, y);
      if (inside && !above && prevAbove) {
        let lo = prevT, hi = t;
        for (let k = 0; k < 20; k++) {
          const m = (lo + hi) / 2;
          const mx = ray.origin[0] + ray.dir[0] * m, my = ray.origin[1] + ray.dir[1] * m, mz = ray.origin[2] + ray.dir[2] * m;
          if (mz > this.heightAt(mx, my)) lo = m; else hi = m;
        }
        return [ray.origin[0] + ray.dir[0] * hi, ray.origin[1] + ray.dir[1] * hi, ray.origin[2] + ray.dir[2] * hi];
      }
      prevAbove = above;
      prevT = t;
      step = Math.max(0.25, t * 0.01);
    }
    return null;
  }

  get size() { return [(this.terrain.width - 1) * this.terrain.cellSize, (this.terrain.height - 1) * this.terrain.cellSize]; }
}

// Water regions as flat translucent surfaces (the original water shaders come in Phase 13).
// waterColor(style) -> [r, g, b, a]: the water look of the region's biome.
export function buildWaterModel(terrain, waterColor = () => [0.28, 0.42, 0.42, 0.6]) {
  const cellsX = terrain.width - 1, cell = terrain.cellSize;
  const meshes = [];
  for (const region of terrain.waterRegions) {
    if (!region.cells.length) continue;
    const pos = [], idx = [], nor = [], uv = [];
    for (const c of region.cells) {
      const x = (c % cellsX) * cell, y = Math.floor(c / cellsX) * cell, z = region.height;
      const base = pos.length / 3;
      pos.push(x, y, z, x + cell, y, z, x + cell, y + cell, z, x, y + cell, z);
      nor.push(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1);
      uv.push(x / 8, y / 8, (x + cell) / 8, y / 8, (x + cell) / 8, (y + cell) / 8, x / 8, (y + cell) / 8);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const [r, g, b, a] = waterColor(region.style);
    meshes.push({
      positions: new Float32Array(pos), normals: new Float32Array(nor), uvs: new Float32Array(uv), colors: null,
      indices: pos.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx),
      texture: 'water', textureWrap: true, node: null, skin: null,
      material: { diffuse: [r, g, b], ambient: [r, g, b], emissive: [0, 0, 0], alpha: a },
      alphaBlend: true, alphaTest: false, alphaThreshold: 0, doubleSided: true,
    });
  }
  return { meshes, bounds: { min: [0, 0, 0], max: [0, 0, 0] }, skeleton: null };
}

function computeNormals(t) {
  const W = t.width, H = t.height, c = t.cellSize, out = new Float32Array(W * H * 3);
  const h = (x, z) => t.heights[Math.min(H - 1, Math.max(0, z)) * W + Math.min(W - 1, Math.max(0, x))];
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
    const dx = (h(x + 1, z) - h(x - 1, z)) / (2 * c), dz = (h(x, z + 1) - h(x, z - 1)) / (2 * c);
    const l = Math.hypot(dx, dz, 1), i = (z * W + x) * 3;
    out[i] = -dx / l; out[i + 1] = -dz / l; out[i + 2] = 1 / l;
  }
  return out;
}

// Conservative frustum test: is any corner of the box inside the clip volume (or does the box straddle it)?
function boxVisible(m, b) {
  let left = 0, right = 0, bottom = 0, top = 0, behind = 0, far = 0;
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? b.max[0] : b.min[0], y = i & 2 ? b.max[1] : b.min[1], z = i & 4 ? b.max[2] : b.min[2];
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cx < -cw) left++; if (cx > cw) right++;
    if (cy < -cw) bottom++; if (cy > cw) top++;
    if (cz < -cw) behind++; if (cz > cw) far++;
  }
  return !(left === 8 || right === 8 || bottom === 8 || top === 8 || behind === 8 || far === 8);
}

function buffer(gl, loc, data, size) {
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  return b;
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
