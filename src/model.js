// Turns a parsed NIF into render-ready meshes attached to skeleton nodes.
// Static meshes keep node-local vertices and follow their node's world matrix;
// skinned meshes carry up to 4 bone influences per vertex.
import { mat4 } from './math.js';
import { buildSkeleton } from './skeleton.js';

const HIDDEN = 1;

export function buildModel(nif) {
  const blocks = [];
  for (const b of nif.blocks) blocks[b.index] = b;
  const get = (ref) => (ref >= 0 ? blocks[ref] : null);
  const skeleton = buildSkeleton(nif);

  const meshes = [];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const grow = (p) => { for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); } };

  function visit(ref, parentProps) {
    const b = get(ref);
    if (!b || b.flags === undefined || (b.flags & HIDDEN)) return;
    const props = new Map(parentProps);
    for (const pr of b.properties) { const p = get(pr); if (p) props.set(p.type, p); }

    if (b.type === 'NiTriShape' || b.type === 'NiTriStrips') {
      const mesh = buildMesh(b, get(b.data), props, get, skeleton);
      if (mesh) {
        meshes.push(mesh);
        const world = skeleton.bindWorld[mesh.node];
        for (let i = 0; i < mesh.positions.length; i += 3) grow(mat4.transformPoint(world, mesh.positions.subarray(i, i + 3)));
      }
      return;
    }
    if (!b.children) return;
    // LOD nodes: render only the highest-detail level (the first child).
    const children = b.type === 'NiLODNode' ? b.children.slice(0, 1) : b.children;
    for (const c of children) visit(c, props);
  }

  for (const root of nif.roots) visit(root, new Map());
  return { meshes, skeleton, bounds: { min, max } };
}

function buildMesh(shape, data, props, get, skeleton) {
  if (!data || !data.vertices || !data.numVertices) return null;
  const n = data.numVertices;
  const node = skeleton.byBlock.get(shape.index);
  if (node === undefined) return null;

  const indices = [];
  if (data.triangles) {
    for (let i = 0; i + 2 < data.triangles.length; i += 3) indices.push(data.triangles[i], data.triangles[i + 1], data.triangles[i + 2]);
  } else if (data.strips) {
    for (const s of data.strips) {
      for (let i = 2; i < s.length; i++) {
        const a = s[i - 2], b = s[i - 1], c = s[i];
        if (a === b || b === c || a === c) continue;
        if (i & 1) indices.push(a, c, b); else indices.push(a, b, c);
      }
    }
  }
  if (!indices.length) return null;

  const normals = data.normals ?? new Float32Array(n * 3).map((_, i) => (i % 3 === 2 ? 1 : 0));
  const skin = shape.skinInstance >= 0 ? buildSkin(get(shape.skinInstance), n, skeleton, get) : null;

  const texProp = props.get('NiTexturingProperty');
  const baseSlot = texProp?.base;
  const source = baseSlot ? get(baseSlot.source) : null;
  const mat = props.get('NiMaterialProperty');
  const alpha = props.get('NiAlphaProperty');
  const stencil = props.get('NiStencilProperty');
  const vcol = props.get('NiVertexColorProperty');

  return {
    name: shape.name,
    node,
    skin,
    positions: data.vertices,
    normals,
    uvs: data.uvSets[baseSlot?.uvSet ?? 0] ?? data.uvSets[0] ?? null,
    colors: data.colors && vcol?.vertexMode === 2 ? data.colors : null,
    indices: n > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
    texture: source?.fileName ?? null,
    materialName: mat?.name?.toLowerCase() || null, // for per-entity texture swaps (guest clothes)
    textureWrap: baseSlot ? baseSlot.clampMode !== 0 : true,
    material: {
      diffuse: mat?.diffuse ?? [1, 1, 1],
      ambient: mat?.ambient ?? [1, 1, 1],
      emissive: mat?.emissive ?? [0, 0, 0],
      alpha: mat?.alpha ?? 1,
    },
    alphaBlend: alpha ? (alpha.flags & 1) !== 0 : false,
    alphaTest: alpha ? (alpha.flags & 0x200) !== 0 : false,
    alphaThreshold: alpha ? alpha.threshold / 255 : 0,
    doubleSided: stencil ? stencil.drawMode === 3 : false,
    uvAnim: uvAnimation(shape, get),
  };
}

// Scrolling textures (NiUVController + NiUVData: key groups for U offset, V offset, U tiling,
// V tiling), e.g. waving flags and flowing water. Returns { start, stop, frequency, phase, groups }.
function uvAnimation(shape, get) {
  for (let c = get(shape.controller); c; c = get(c.nextController)) {
    if (c.type !== 'NiUVController') continue;
    const data = get(c.data);
    if (!data?.groups?.some((g) => g.keys.length)) return null;
    return { start: c.startTime, stop: c.stopTime, frequency: c.frequency || 1, phase: c.phase || 0, groups: data.groups.map((g) => g.keys) };
  }
  return null;
}

// Value of a float key list at time t (linear between keys; constant outside).
function sampleKeys(keys, t, fallback) {
  if (!keys.length) return fallback;
  if (t <= keys[0].time) return keys[0].value;
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].time) {
      const a = keys[i - 1], b = keys[i], f = (t - a.time) / Math.max(b.time - a.time, 1e-6);
      return a.value + (b.value - a.value) * f;
    }
  }
  return keys.at(-1).value;
}

// [uOffset, vOffset, uTiling, vTiling] of a UV animation at `time` seconds (looping).
export function uvTransformAt(anim, time) {
  const length = Math.max(anim.stop - anim.start, 1e-6);
  const t = anim.start + ((((time * anim.frequency + anim.phase) % length) + length) % length);
  const [u, v, su, sv] = anim.groups;
  return [sampleKeys(u, t, 0), sampleKeys(v, t, 0), sampleKeys(su, t, 1), sampleKeys(sv, t, 1)];
}

// Per-vertex bone influences. Skin matrix for bone i = boneWorld_i * offset_i,
// which equals the mesh's world transform at the bind pose (verified on all animal models).
function buildSkin(instance, numVertices, skeleton, get) {
  const data = get(instance.data);
  if (!data) return null;
  const bones = instance.bones.map((ref) => skeleton.byBlock.get(ref) ?? -1);
  if (bones.some((b) => b < 0)) return null;
  const offsets = data.bones.map((b) => mat4.fromNif(b.rotation, b.translation, b.scale));

  // Gather all influences per vertex.
  const influences = Array.from({ length: numVertices }, () => []);
  if (data.hasVertexWeights) {
    data.bones.forEach((b, bi) => { for (const [v, w] of b.weights) if (v < numVertices && w > 0) influences[v].push([bi, w]); });
  } else {
    const part = get(data.skinPartition);
    for (const pt of part?.partitions ?? []) {
      for (let i = 0; i < pt.numVerts; i++) {
        for (let k = 0; k < pt.wpv; k++) {
          const w = pt.weights[i * pt.wpv + k];
          const local = pt.boneIndices ? pt.boneIndices[i * pt.wpv + k] : k;
          if (w > 0) influences[pt.vertexMap[i]].push([pt.bones[local], w]);
        }
      }
    }
  }

  const boneIndex = new Float32Array(numVertices * 4);
  const boneWeight = new Float32Array(numVertices * 4);
  for (let v = 0; v < numVertices; v++) {
    const list = influences[v].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const total = list.reduce((s, x) => s + x[1], 0) || 1;
    list.forEach(([bi, w], k) => { boneIndex[v * 4 + k] = bi; boneWeight[v * 4 + k] = w / total; });
    if (!list.length) boneWeight[v * 4] = 1;
  }
  return { bones, offsets, boneIndex, boneWeight };
}
