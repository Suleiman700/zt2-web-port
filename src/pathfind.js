// A* path finding on a square grid (8 neighbours, no corner cutting), used for animals moving
// around their exhibit's objects. `passable(cx, cy)` says whether a cell can be walked; cells are
// `cell` metres wide starting at the world origin. Returns world waypoints (with straight runs
// merged) from start to goal, or null when the goal cannot be reached within `maxNodes`.
// With `nearGoal` (metres) the path may end at any walkable cell that close to the goal (for
// targets standing on cells of their own, like a food dish).

class MinHeap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  push(node, f) {
    const a = this.items;
    a.push([f, node]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.items, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top[1];
  }
}

const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

export function findPath(start, goal, passable, { cell = 1, maxNodes = 20000, nearGoal = 0 } = {}) {
  const sx = Math.floor(start[0] / cell), sy = Math.floor(start[1] / cell);
  const gx = Math.floor(goal[0] / cell), gy = Math.floor(goal[1] / cell);
  const close = (x, y) => nearGoal > 0 && Math.hypot((x + 0.5) * cell - goal[0], (y + 0.5) * cell - goal[1]) <= nearGoal;
  if (!nearGoal && !passable(gx, gy)) return null;
  if ((sx === gx && sy === gy) || close(sx, sy)) return [goal];
  const key = (x, y) => `${x},${y}`;
  const h = (x, y) => { const dx = Math.abs(x - gx), dy = Math.abs(y - gy); return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy); };
  const open = new MinHeap();
  const g = new Map([[key(sx, sy), 0]]);
  const from = new Map();
  open.push([sx, sy], h(sx, sy));
  let expanded = 0, end = null;
  while (open.size) {
    const [x, y] = open.pop();
    if ((x === gx && y === gy) || close(x, y)) { end = [x, y]; break; }
    if (++expanded > maxNodes) return null;
    const gc = g.get(key(x, y));
    for (const [dx, dy, cost] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (!passable(nx, ny)) continue;
      if (dx && dy && (!passable(x + dx, y) || !passable(x, y + dy))) continue; // no corner cutting
      const k = key(nx, ny), ng = gc + cost;
      if (ng >= (g.get(k) ?? Infinity)) continue;
      g.set(k, ng);
      from.set(k, [x, y]);
      open.push([nx, ny], ng + h(nx, ny));
    }
  }
  if (!end) return null;
  // Walk back, keeping only the cells where the direction changes.
  const cells = [];
  for (let c = end; c; c = from.get(key(c[0], c[1]))) cells.push(c);
  cells.reverse();
  const out = [];
  for (let i = 1; i < cells.length - 1; i++) {
    const [ax, ay] = cells[i - 1], [bx, by] = cells[i], [cx, cy] = cells[i + 1];
    if (bx - ax !== cx - bx || by - ay !== cy - by) out.push([(bx + 0.5) * cell, (by + 0.5) * cell]);
  }
  out.push(end[0] === gx && end[1] === gy ? goal : [(end[0] + 0.5) * cell, (end[1] + 0.5) * cell]);
  return out;
}
