// Node hierarchy of a NIF model, and posing it with .bf animations.
import { mat4 } from './math.js';
import { sampleRotation, samplePosition, sampleScalar } from './bf.js';

// Builds a flat node list in parent-before-child order.
export function buildSkeleton(nif) {
  const blocks = [];
  for (const b of nif.blocks) blocks[b.index] = b;
  const nodes = [];
  const byBlock = new Map();
  const byName = new Map();

  function visit(ref, parent) {
    const b = blocks[ref];
    if (!b || !b.rotation || byBlock.has(ref)) return;
    const index = nodes.length;
    nodes.push({
      name: b.name,
      parent,
      block: ref,
      translation: b.translation,
      rotation: b.rotation,
      scale: b.scale,
      bind: mat4.fromNif(b.rotation, b.translation, b.scale),
    });
    byBlock.set(ref, index);
    if (b.name && !byName.has(b.name.toLowerCase())) byName.set(b.name.toLowerCase(), index);
    for (const c of b.children ?? []) visit(c, index);
  }
  for (const r of nif.roots) visit(r, -1);

  const bindWorld = nodes.map(() => null);
  nodes.forEach((n, i) => { bindWorld[i] = n.parent < 0 ? n.bind : mat4.multiply(bindWorld[n.parent], n.bind); });
  return { nodes, byBlock, byName, bindWorld, bindings: new WeakMap() };
}

// Maps an animation's bone tracks onto skeleton node indices (cached per animation).
function binding(skel, anim) {
  let b = skel.bindings.get(anim);
  if (!b) {
    b = [];
    for (const bone of anim.bones) {
      const node = skel.byName.get(bone.name.toLowerCase());
      if (node !== undefined) b.push({ node, bone });
    }
    skel.bindings.set(anim, b);
  }
  return b;
}

const q = [0, 0, 0, 1], p = [0, 0, 0];

// Computes world matrices for every node with the animation sampled at `time`.
// options.lockRootXY: keep the root bone's horizontal position fixed (the game moves the entity instead).
export function computePose(skel, anim, time, out, options = {}) {
  const local = skel.nodes.map((n) => n.bind);
  if (anim) {
    for (const { node, bone } of binding(skel, anim)) {
      const n = skel.nodes[node];
      const rot = bone.rotation ? sampleRotation(bone.rotation, time, q)
        : bone.euler.some(Boolean) ? eulerToQuat(bone.euler, time, q) : null;
      const pos = bone.position ? samplePosition(bone.position, time, p) : null;
      if (pos && options.lockRootXY && node === options.rootNode) {
        pos[0] = options.rootXY[0];
        pos[1] = options.rootXY[1];
      }
      local[node] = compose(pos ?? n.translation, rot, rot ? null : n.rotation, n.scale);
    }
  }
  for (let i = 0; i < skel.nodes.length; i++) {
    const parent = skel.nodes[i].parent;
    out[i] = parent < 0 ? local[i] : mat4.multiply(out[parent], local[i]);
  }
  return out;
}

// Root bone horizontal position at the start of an animation, used to strip root motion.
export function rootStart(anim, skel) {
  for (const { node, bone } of binding(skel, anim)) {
    if (skel.nodes[node].parent >= 0 && skel.nodes[skel.nodes[node].parent].parent < 0 && bone.position) {
      return { node, xy: [bone.position.values[0], bone.position.values[1]] };
    }
  }
  return null;
}

// Distance the root bone travels during the animation (for matching walk speed to the feet).
export function rootTravel(anim) {
  const root = anim.bones[0]?.position;
  if (!root) return 0;
  const v = root.values, n = root.times.length - 1;
  return Math.hypot(v[n * 3] - v[0], v[n * 3 + 1] - v[1]);
}

function compose(t, quat, rotMatrix, s) {
  let m;
  if (quat) {
    const [x, y, z, w] = quat;
    // Row-major 3x3, same convention as NIF rotations (applied to column vectors).
    m = [
      1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
      2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
      2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
    ];
  } else {
    m = rotMatrix;
  }
  return mat4.fromNif(m, t, s);
}

// Euler X/Y/Z tracks (radians), applied X then Y then Z.
function eulerToQuat(euler, time, out) {
  const [ax, ay, az] = euler.map((tr) => (tr ? sampleScalar(tr, time) : 0));
  const cx = Math.cos(ax / 2), sx = Math.sin(ax / 2);
  const cy = Math.cos(ay / 2), sy = Math.sin(ay / 2);
  const cz = Math.cos(az / 2), sz = Math.sin(az / 2);
  // q = qz * qy * qx
  out[0] = sx * cy * cz - cx * sy * sz;
  out[1] = cx * sy * cz + sx * cy * sz;
  out[2] = cx * cy * sz - sx * sy * cz;
  out[3] = cx * cy * cz + sx * sy * sz;
  return out;
}
