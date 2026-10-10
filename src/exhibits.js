// Exhibits: the areas that fences (including the zoo wall) close off. The ground is divided like
// paths: four triangles per 3 m tile (N +y, E +x, S -y, W -x, as in paths.js). Straight fences
// lie on tile edges and block the two triangles facing each other across the edge; diagonal
// fences cut a tile along a diagonal and block the triangles on either side. A flood fill over the
// triangles gives the regions. The guest area is the region with most path triangles; regions
// touching the map edge are outside the zoo; every other region is an exhibit.
import { TILE } from './terrain.js';

const N = 0, E = 1, S = 2, W = 3;
const BIT = [1, 2, 4, 8]; // path TRI bits for N, E, S, W

export class ExhibitMap {
  // tilesX/tilesY: map size in tiles.
  constructor(tilesX, tilesY) {
    this.tilesX = tilesX;
    this.tilesY = tilesY;
    this.region = new Int32Array(tilesX * tilesY * 4).fill(-1);
    this.regions = []; // { id, kind: 'guest' | 'outside' | 'exhibit', triangles, area, pathTriangles, touchesEdge }
  }

  index(tx, ty, dir) { return (ty * this.tilesX + tx) * 4 + dir; }

  // fences: [{ a: [i, j], b: [i, j] }] tile-corner segments; paths: PathGrid.
  rebuild(fences, paths) {
    const { tilesX: W_, tilesY: H_ } = this;
    // Blocked crossings: edge key -> true; diagonal cuts per tile: 1 = "/" (SW-NE), 2 = "\" (NW-SE).
    const blocked = new Set(), cuts = new Map();
    for (const f of fences) {
      if (f.broken) continue; // smashed by an animal: animals can walk through
      const [ax, ay] = f.a, [bx, by] = f.b;
      const dx = bx - ax, dy = by - ay;
      if (dx && dy) {
        const tx = Math.min(ax, bx), ty = Math.min(ay, by);
        const kind = dx * dy > 0 ? 1 : 2;
        cuts.set(ty * W_ + tx, (cuts.get(ty * W_ + tx) ?? 0) | kind);
      } else if (dx) {
        // Horizontal edge at y = ay between x and x+1: blocks N of (x, ay-1) and S of (x, ay).
        blocked.add(`h${Math.min(ax, bx)},${ay}`);
      } else if (dy) {
        blocked.add(`v${ax},${Math.min(ay, by)}`);
      }
    }
    const region = this.region.fill(-1);
    const regions = [];
    const stack = [];
    for (let start = 0; start < region.length; start++) {
      if (region[start] >= 0) continue;
      const id = regions.length;
      const info = { id, kind: 'exhibit', triangles: 0, pathTriangles: 0, touchesEdge: false };
      region[start] = id;
      stack.push(start);
      while (stack.length) {
        const i = stack.pop();
        const dir = i & 3, t = i >> 2, tx = t % W_, ty = (t / W_) | 0;
        info.triangles++;
        if (paths?.has(tx, ty, BIT[dir])) info.pathTriangles++;
        const cut = cuts.get(t) ?? 0;
        const visit = (j) => { if (region[j] < 0) { region[j] = id; stack.push(j); } };
        // Within the tile: N and S each touch E and W, unless a diagonal fence separates them.
        if (dir === N || dir === S) {
          // "/" separates {N, W} from {S, E}; "\" separates {N, E} from {S, W}.
          const toE = dir === N ? !(cut & 1) : !(cut & 2);
          const toW = dir === N ? !(cut & 2) : !(cut & 1);
          if (toE) visit(t * 4 + E);
          if (toW) visit(t * 4 + W);
        } else {
          const toN = dir === E ? !(cut & 1) : !(cut & 2);
          const toS = dir === E ? !(cut & 2) : !(cut & 1);
          if (toN) visit(t * 4 + N);
          if (toS) visit(t * 4 + S);
        }
        // Across the tile edge.
        if (dir === N) { if (ty + 1 < H_) { if (!blocked.has(`h${tx},${ty + 1}`)) visit(this.index(tx, ty + 1, S)); } else info.touchesEdge = true; }
        if (dir === S) { if (ty > 0) { if (!blocked.has(`h${tx},${ty}`)) visit(this.index(tx, ty - 1, N)); } else info.touchesEdge = true; }
        if (dir === E) { if (tx + 1 < W_) { if (!blocked.has(`v${tx + 1},${ty}`)) visit(this.index(tx + 1, ty, W)); } else info.touchesEdge = true; }
        if (dir === W) { if (tx > 0) { if (!blocked.has(`v${tx},${ty}`)) visit(this.index(tx - 1, ty, E)); } else info.touchesEdge = true; }
      }
      info.area = info.triangles * TILE * TILE / 4;
      regions.push(info);
    }
    const guest = regions.reduce((best, r) => (r.pathTriangles > (best?.pathTriangles ?? 0) ? r : best), null);
    for (const r of regions) r.kind = r === guest ? 'guest' : r.touchesEdge ? 'outside' : 'exhibit';
    this.regions = regions;
    return regions;
  }

  // Region id at a world point (metres), or -1 outside the map.
  regionAt(x, y) {
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    if (tx < 0 || ty < 0 || tx >= this.tilesX || ty >= this.tilesY) return -1;
    const lx = x / TILE - tx - 0.5, ly = y / TILE - ty - 0.5;
    const dir = Math.abs(lx) > Math.abs(ly) ? (lx > 0 ? E : W) : (ly > 0 ? N : S);
    return this.region[this.index(tx, ty, dir)];
  }

  // A random point inside a region (for wandering), or null.
  randomPoint(id, tries = 64) {
    if (id < 0) return null;
    for (let k = 0; k < tries; k++) {
      const i = Math.floor(Math.random() * this.region.length);
      if (this.region[i] !== id) continue;
      const dir = i & 3, t = i >> 2, tx = t % this.tilesX, ty = (t / this.tilesX) | 0;
      // A point inside the triangle: towards its outer edge from the tile centre.
      const u = 0.1 + Math.random() * 0.35, v = (Math.random() - 0.5) * 2 * u * 0.9;
      const [ox, oy] = [[v, u], [u, v], [v, -u], [-u, v]][dir];
      return [(tx + 0.5 + ox) * TILE, (ty + 0.5 + oy) * TILE];
    }
    return null;
  }
}
