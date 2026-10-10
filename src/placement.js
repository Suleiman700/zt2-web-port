// Object placement rules, following the original's ZTPlacementData (as implemented in OpenZT2's
// object_placement_validation, MIT License, Copyright (c) OpenZT2 contributors):
// footprints are 1 m cells; rotation is in 45° steps, using the diagonal footprint (dfootprint) on
// odd steps; grid-snapped objects align their footprint to whole metres; a placement is invalid
// if a cell is taken, off the map, or in water / on land when the object does not allow it.

// Footprint for an item: authored size (cfootprint/dfootprint, metres) with the object at its
// centre, or automatic from the model's bounds.
export function footprintFor(rules, bounds, scale = 1) {
  const fromSize = ([w, h]) => ({ dims: [Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h))], pivot: [w / 2, h / 2] });
  if (rules.cfootprint && !rules.autoFootprint) {
    return { cardinal: fromSize(rules.cfootprint), diagonal: fromSize(rules.dfootprint ?? rules.cfootprint) };
  }
  const min = bounds.min.map((v) => v * scale), max = bounds.max.map((v) => v * scale);
  if (!Number.isFinite(min[0])) return { cardinal: fromSize([1, 1]), diagonal: fromSize([1, 1]) };
  const fp = { dims: [Math.max(1, Math.ceil(max[0] - min[0])), Math.max(1, Math.ceil(max[1] - min[1]))], pivot: [-min[0], -min[1]] };
  return { cardinal: fp, diagonal: fp };
}

const eighthTurns = (yaw) => ((Math.round(yaw / (Math.PI / 4)) % 8) + 8) % 8;

// Rotates a point / a unit cell by quarter turns counter-clockwise (our yaw direction).
const rotatePoint = ([x, y], q) => [[x, y], [-y, x], [-x, -y], [y, -x]][q & 3];
const rotateCell = ([x, y], q) => [[x, y], [-y - 1, x], [-x - 1, -y - 1], [y, -x - 1]][q & 3];

// World cells covered by an object at `pos` with `yaw`, and (if snapping) the snapped position.
export function placeFootprint(footprint, pos, yaw, snap) {
  const turns = eighthTurns(yaw);
  const fp = turns & 1 ? footprint.diagonal : footprint.cardinal;
  const q = turns >> 1;
  const pivot = rotatePoint(fp.pivot, q);
  const origin = [Math.round(pos[0] - pivot[0]), Math.round(pos[1] - pivot[1])];
  const cells = [];
  for (let y = 0; y < fp.dims[1]; y++) for (let x = 0; x < fp.dims[0]; x++) {
    const [rx, ry] = rotateCell([x, y], q);
    cells.push([origin[0] + rx, origin[1] + ry]);
  }
  const snapped = snap ? [origin[0] + pivot[0], origin[1] + pivot[1], pos[2]] : [...pos];
  return { cells, pos: snapped, yaw: snap ? turns * (Math.PI / 4) : yaw };
}

export const cellKey = (c) => `${c[0]},${c[1]}`;

// Occupancy of 1 m cells by placed objects.
export class Occupancy {
  constructor() { this.cells = new Map(); }
  occupy(cells, owner) { for (const c of cells) this.cells.set(cellKey(c), owner); }
  free(owner) { for (const [k, v] of this.cells) if (v === owner) this.cells.delete(k); }
  blocked(cells, ignore = null) { return cells.some((c) => { const o = this.cells.get(cellKey(c)); return o && o !== ignore; }); }
}

// Checks a placement; returns null if valid, else a short reason for the player.
export function placementProblem(rules, cells, { size, occupancy, isWater }) {
  for (const [x, y] of cells) {
    if (x < 0 || y < 0 || x + 1 > size[0] || y + 1 > size[1]) return 'Outside the zoo';
  }
  if (occupancy.blocked(cells)) return 'Something is already there';
  const wet = cells.some(([x, y]) => isWater(x + 0.5, y + 0.5));
  const dry = cells.some(([x, y]) => !isWater(x + 0.5, y + 0.5));
  if (wet && !rules.waterPlacement) return 'This can not go in water';
  if (dry && !rules.landPlacement) return 'This needs to go in water';
  return null;
}
