// Ground paths on the 3 m tile grid. As in the original (ui/modes/pathcurves.xml), each tile is
// split into four triangles by its diagonals: N (dir 0, +y), E (2, +x), S (4, -y), W (6, -x).
// Straight paths fill whole tiles; diagonal paths add half tiles (two triangles), giving 45° edges.
// Curbs (fence-like pieces) run along the path's straight and diagonal borders.
import { TILE } from './terrain.js';

export const TRI = { N: 1, E: 2, S: 4, W: 8 }; // bit per triangle
const FULL = 15;
const DIRECTIONS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

export const tileKey = (tx, ty) => `${tx},${ty}`;
export const tileAt = (point) => [Math.floor(point[0] / TILE), Math.floor(point[1] / TILE)];

// Triangles to add for a path dragged from tile `start` towards `point`, snapped to 8 directions.
// Returns [{ tx, ty, mask }].
export function pathLine(start, point) {
  const cx = (start[0] + 0.5) * TILE, cy = (start[1] + 0.5) * TILE;
  const dx = point[0] - cx, dy = point[1] - cy;
  const out = [{ tx: start[0], ty: start[1], mask: FULL }];
  const dist = Math.hypot(dx, dy);
  if (dist < TILE * 0.5) return out;
  const [sx, sy] = DIRECTIONS[(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8];
  const steps = Math.round(dist / (Math.hypot(sx, sy) * TILE));
  let [x, y] = start;
  for (let k = 0; k < steps; k++) {
    if (sx && sy) {
      // Half tiles beside the diagonal step: the tile beside us across x faces back towards us and
      // forward in y; the one across y faces forward in x and back towards us.
      out.push({ tx: x + sx, ty: y, mask: (sx > 0 ? TRI.W : TRI.E) | (sy > 0 ? TRI.N : TRI.S) });
      out.push({ tx: x, ty: y + sy, mask: (sx > 0 ? TRI.E : TRI.W) | (sy > 0 ? TRI.S : TRI.N) });
    }
    x += sx; y += sy;
    out.push({ tx: x, ty: y, mask: FULL });
  }
  return out;
}

export const triangleCount = (mask) => ((mask & 1) + ((mask >> 1) & 1) + ((mask >> 2) & 1) + ((mask >> 3) & 1));

export class PathGrid {
  constructor() { this.tiles = new Map(); } // key -> { tx, ty, mask, item }

  // Adds triangles; returns how many new triangles were added. A tile keeps one path type.
  add(item, tx, ty, mask) {
    const key = tileKey(tx, ty);
    const t = this.tiles.get(key);
    if (!t) { this.tiles.set(key, { tx, ty, mask, item }); return triangleCount(mask); }
    const added = mask & ~t.mask;
    t.mask |= mask;
    t.item = item;
    return triangleCount(added);
  }

  // Removes triangles; returns how many were removed.
  remove(tx, ty, mask) {
    const key = tileKey(tx, ty);
    const t = this.tiles.get(key);
    if (!t) return 0;
    const removed = t.mask & mask;
    t.mask &= ~mask;
    if (!t.mask) this.tiles.delete(key);
    return triangleCount(removed);
  }

  has(tx, ty, bit) { return ((this.tiles.get(tileKey(tx, ty))?.mask ?? 0) & bit) !== 0; }

  // Curb edges between path and non-path, as fence-style corner pairs: { a, b, item }.
  curbEdges() {
    const out = [];
    for (const t of this.tiles.values()) {
      const { tx, ty, mask, item } = t;
      // Straight borders: a triangle whose outer tile edge has no path triangle facing it.
      if (mask & TRI.N && !this.has(tx, ty + 1, TRI.S)) out.push({ a: [tx, ty + 1], b: [tx + 1, ty + 1], item });
      if (mask & TRI.S && !this.has(tx, ty - 1, TRI.N)) out.push({ a: [tx, ty], b: [tx + 1, ty], item });
      if (mask & TRI.E && !this.has(tx + 1, ty, TRI.W)) out.push({ a: [tx + 1, ty], b: [tx + 1, ty + 1], item });
      if (mask & TRI.W && !this.has(tx - 1, ty, TRI.E)) out.push({ a: [tx, ty], b: [tx, ty + 1], item });
      // Diagonal borders across half tiles.
      if (mask === (TRI.N | TRI.W) || mask === (TRI.S | TRI.E)) out.push({ a: [tx, ty], b: [tx + 1, ty + 1], item });
      if (mask === (TRI.N | TRI.E) || mask === (TRI.S | TRI.W)) out.push({ a: [tx, ty + 1], b: [tx + 1, ty], item });
    }
    return out;
  }

  // Masked squares for tiles overlapping a cell rectangle (cell coordinates, 4 cells per tile):
  // each triangle of a tile becomes two triangles covering the whole tile, cut by its mask.
  // Grouped by path item: Map(item -> array of x, z, tileX, tileZ, direction (0..3 = N E S W) per vertex).
  trianglesInCells(x0, z0, x1, z1, cellsPerTile) {
    const groups = new Map();
    for (const t of this.tiles.values()) {
      const cx0 = t.tx * cellsPerTile, cz0 = t.ty * cellsPerTile, c = cellsPerTile;
      if (cx0 > x1 || cx0 + c < x0 || cz0 > z1 || cz0 + c < z0) continue;
      const list = groups.get(t.item) ?? [];
      [TRI.N, TRI.E, TRI.S, TRI.W].forEach((bit, dir) => {
        if (!(t.mask & bit)) return;
        for (const [x, z] of [[0, 0], [c, 0], [c, c], [0, 0], [c, c], [0, c]]) list.push(cx0 + x, cz0 + z, cx0, cz0, dir);
      });
      groups.set(t.item, list);
    }
    return groups;
  }

  toJSON() { return [...this.tiles.values()].map((t) => [t.tx, t.ty, t.mask, t.item.id]); }
}
