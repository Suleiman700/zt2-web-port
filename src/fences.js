// Fences: segments along 3 m tile edges (straight) or tile diagonals, posts on tile corners.
// Each segment model is sheared vertically to follow the ground between its two corners,
// like the original's BFSkewComponent. Corners are integer tile coordinates.
import { TILE } from './terrain.js';
import { mat4 } from './math.js';

// The 8 directions a fence can run in, as corner steps.
const DIRECTIONS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

export const cornerWorld = (c) => [c[0] * TILE, c[1] * TILE];

export function nearestCorner(point) {
  return [Math.round(point[0] / TILE), Math.round(point[1] / TILE)];
}

// Corners from `start` towards the pointer, snapped to the nearest of the 8 directions.
export function fenceLine(start, point) {
  const [sx, sy] = cornerWorld(start);
  const dx = point[0] - sx, dy = point[1] - sy;
  const dist = Math.hypot(dx, dy);
  if (dist < TILE * 0.5) return [start];
  const dir = DIRECTIONS[(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8];
  const stepLen = Math.hypot(dir[0], dir[1]) * TILE;
  const steps = Math.max(1, Math.round(dist / stepLen));
  const out = [];
  for (let k = 0; k <= steps; k++) out.push([start[0] + dir[0] * k, start[1] + dir[1] * k]);
  return out;
}

// Edge key that is the same in both directions.
export function edgeKey(a, b) {
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]) ? `${a[0]},${a[1]}:${b[0]},${b[1]}` : `${b[0]},${b[1]}:${a[0]},${a[1]}`;
}

// Matrix for a segment from corner a to b: the model runs along +X from its origin.
export function segmentMatrix(a, b, heightAt) {
  const [ax, ay] = cornerWorld(a), [bx, by] = cornerWorld(b);
  const za = heightAt(ax, ay), zb = heightAt(bx, by);
  const len = Math.hypot(bx - ax, by - ay);
  const base = mat4.fromPosYawScale([ax, ay, za], Math.atan2(by - ay, bx - ax), 1);
  // Vertical shear: z rises by (zb - za) over the segment's length.
  const shear = mat4.identity();
  shear[2] = (zb - za) / len;
  return mat4.multiply(base, shear);
}

export function postMatrix(c, heightAt) {
  const [x, y] = cornerWorld(c);
  return mat4.fromPosYawScale([x, y, heightAt(x, y)], 0, 1);
}

export const isDiagonal = (a, b) => a[0] !== b[0] && a[1] !== b[1];
