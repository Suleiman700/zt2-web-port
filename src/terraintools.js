// Terrain editing: raise, lower, smooth, flatten and biome painting, applied with a round brush.
// Height edits rebuild only the touched mesh chunks; paint edits repaint only touched sectors.

const RAISE_SPEED = 1.2;      // metres per second at the brush centre
const SMOOTH_SPEED = 6;       // fraction per second towards the neighbourhood average
const FLATTEN_SPEED = 6;
const MIN_HEIGHT = -10, MAX_HEIGHT = 60;
const SURFACE_INTERVAL = 0.08; // seconds between repaints while sculpting (cliff rock follows the shape)
const MIPMAP_INTERVAL = 0.4;

export class TerrainEditor {
  constructor(data, renderer, surface) {
    this.data = data;          // parsed .dat terrain (heights, biome, cover are edited in place)
    this.renderer = renderer;  // TerrainRenderer
    this.surface = surface;    // TerrainSurface
    this.pendingSurface = null;
    this.sinceSurface = 0;
    this.sinceMipmaps = 0;
    this.changed = false;      // edits since the last save
  }

  // Applies one frame of a tool. tool: { kind, radius (m), strength (0.1-2, 1 = normal), biome, cover, flattenHeight }.
  apply(tool, center, dt) {
    const t = this.data, W = t.width, H = t.height, cell = t.cellSize;
    const r = tool.radius / cell;
    const cx = center[0] / cell, cz = center[1] / cell;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r));
    const z0 = Math.max(0, Math.floor(cz - r)), z1 = Math.min(H - 1, Math.ceil(cz + r));
    if (x0 > x1 || z0 > z1) return;

    if (tool.kind === 'paint') {
      let touched = false;
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        if (Math.hypot(x - cx, z - cz) > r) continue;
        const i = z * W + x;
        if (t.biome[i] !== tool.biome || t.cover[i] !== (tool.cover ? 1 : 0)) {
          t.biome[i] = tool.biome;
          t.cover[i] = tool.cover ? 1 : 0;
          touched = true;
        }
      }
      if (touched) {
        this.surface.refresh(x0, z0, x1, z1);
        this.changed = true;
      }
      return;
    }

    const before = tool.kind === 'smooth' ? t.heights.slice() : null;
    const h = (x, z) => before[Math.min(H - 1, Math.max(0, z)) * W + Math.min(W - 1, Math.max(0, x))];
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, z - cz) / r;
      if (d >= 1) continue;
      const w = (1 - d * d) ** 2 * (tool.strength ?? 1); // smooth falloff towards the brush edge, scaled by strength
      const i = z * W + x;
      let v = t.heights[i];
      if (tool.kind === 'raise') v += RAISE_SPEED * dt * w;
      else if (tool.kind === 'lower') v -= RAISE_SPEED * dt * w;
      else if (tool.kind === 'smooth') {
        const avg = (h(x - 1, z) + h(x + 1, z) + h(x, z - 1) + h(x, z + 1) + h(x - 1, z - 1) + h(x + 1, z + 1) + h(x - 1, z + 1) + h(x + 1, z - 1) + h(x, z)) / 9;
        v += (avg - v) * Math.min(1, SMOOTH_SPEED * dt * w);
      } else if (tool.kind === 'flatten') {
        v += (tool.flattenHeight - v) * Math.min(1, FLATTEN_SPEED * dt * w);
      }
      t.heights[i] = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, v));
    }
    this.renderer.updateRegion(x0, z0, x1, z1);
    this.changed = true;
    // Repainting cliff rock is batched so sculpting stays smooth.
    const p = this.pendingSurface;
    this.pendingSurface = p ? [Math.min(p[0], x0), Math.min(p[1], z0), Math.max(p[2], x1), Math.max(p[3], z1)] : [x0, z0, x1, z1];
  }

  // Water brush, as in the original ("left click to create shallow/deep water"): digs the ground under
  // the brush to `depth` below the water level and adds those cells to the water body.
  // tool: { kind: 'water', radius, depth, style, stroke } where stroke = { region } for the current drag.
  // A stroke that starts in existing water extends that body at its level; otherwise the level is the
  // ground height where the stroke starts.
  paintWater(tool, center, startOfStroke) {
    const t = this.data, W = t.width, H = t.height, cell = t.cellSize, CW = W - 1, CH = H - 1;
    if (startOfStroke) {
      const ci = Math.floor(center[1] / cell) * CW + Math.floor(center[0] / cell);
      let region = t.waterRegions.find((r) => r.cells.includes(ci));
      if (!region) {
        region = { height: center[2] - 0.15, style: tool.style, cells: [] };
        t.waterRegions.push(region);
      }
      tool.stroke = { region, cellSet: new Set(region.cells) };
    }
    const { region, cellSet } = tool.stroke;
    const r = tool.radius / cell, cx = center[0] / cell, cz = center[1] / cell;
    const x0 = Math.max(0, Math.floor(cx - r - 1)), x1 = Math.min(W - 1, Math.ceil(cx + r + 1));
    const z0 = Math.max(0, Math.floor(cz - r - 1)), z1 = Math.min(H - 1, Math.ceil(cz + r + 1));
    let changed = false;
    // Dig the brush area to full depth. Around it, ground that is not already lake bed becomes a
    // bank exactly at the water level, so the water's edge meets the land even on slopes.
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, z - cz);
      if (d > r + 1) continue;
      const i = z * W + x;
      if (d <= r) {
        const target = region.height - Math.max(0.3, tool.depth);
        if (t.heights[i] > target) { t.heights[i] = target; changed = true; }
      } else if (t.heights[i] > region.height - 0.25 && t.heights[i] < region.height + 0.05) {
        t.heights[i] = region.height + 0.05;
        changed = true;
      }
    }
    // Cells now under the surface join the water body.
    for (let z = Math.max(0, z0 - 1); z < Math.min(CH, z1 + 1); z++) for (let x = Math.max(0, x0 - 1); x < Math.min(CW, x1 + 1); x++) {
      const c = z * CW + x;
      if (cellSet.has(c) || Math.hypot(x + 0.5 - cx, z + 0.5 - cz) > r + 1) continue;
      const low = Math.min(t.heights[z * W + x], t.heights[z * W + x + 1], t.heights[(z + 1) * W + x], t.heights[(z + 1) * W + x + 1]);
      if (low < region.height) { cellSet.add(c); region.cells.push(c); changed = true; }
    }
    if (!changed) return;
    this.markWaterSamples(region, true);
    this.renderer.updateRegion(x0, z0, x1, z1);
    this.queueSurface(x0, z0, x1, z1);
    this.waterDirty = true;
    this.changed = true;
  }

  // Remove-water brush: takes cells under the brush out of their water bodies and fills the basin
  // back up to the old water level, so the land returns.
  removeWater(tool, center) {
    const t = this.data, W = t.width, cell = t.cellSize, CW = W - 1;
    const r = tool.radius / cell, cx = center[0] / cell, cz = center[1] / cell;
    let changed = false;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const region of t.waterRegions) {
      const keep = [];
      for (const c of region.cells) {
        const x = c % CW, z = Math.floor(c / CW);
        if (Math.hypot(x + 0.5 - cx, z + 0.5 - cz) > r) { keep.push(c); continue; }
        for (const s of [z * W + x, z * W + x + 1, (z + 1) * W + x, (z + 1) * W + x + 1]) {
          t.heights[s] = Math.max(t.heights[s], region.height + 0.15);
          t.water[s] = 0;
        }
        x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x + 1); z1 = Math.max(z1, z + 1);
        changed = true;
      }
      region.cells = keep;
    }
    if (!changed) return;
    t.waterRegions = t.waterRegions.filter((reg) => reg.cells.length);
    this.renderer.updateRegion(x0, z0, x1, z1);
    this.queueSurface(x0, z0, x1, z1);
    this.waterDirty = true;
    this.changed = true;
  }

  queueSurface(x0, z0, x1, z1) {
    const p = this.pendingSurface;
    this.pendingSurface = p ? [Math.min(p[0], x0), Math.min(p[1], z0), Math.max(p[2], x1), Math.max(p[3], z1)] : [x0, z0, x1, z1];
  }

  // Keeps the per-sample water depth flags (0 dry, 1 shallow, 2 deep) in step with water bodies.
  markWaterSamples(region, wet) {
    const t = this.data, W = t.width, CW = W - 1;
    for (const c of region.cells) {
      const x = c % CW, z = Math.floor(c / CW);
      for (const s of [z * W + x, z * W + x + 1, (z + 1) * W + x, (z + 1) * W + x + 1]) {
        const depth = region.height - t.heights[s];
        t.water[s] = !wet || depth <= 0 ? 0 : depth < 1 ? 1 : 2;
      }
    }
  }

  // Call once per frame.
  update(dt, force = false) {
    this.sinceSurface += dt;
    this.sinceMipmaps += dt;
    if (this.pendingSurface && (force || this.sinceSurface >= SURFACE_INTERVAL)) {
      this.surface.refresh(...this.pendingSurface);
      this.pendingSurface = null;
      this.sinceSurface = 0;
    }
    if (this.surface.dirtyMipmaps && (force || this.sinceMipmaps >= MIPMAP_INTERVAL)) {
      this.surface.updateMipmaps();
      this.sinceMipmaps = 0;
    }
  }
}

