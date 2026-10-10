// Parser for Blue Fang .bfb models (Endangered Species / Marine Mania / Extinct Animals era).
// Produces the same { meshes, skeleton, bounds } shape as model.js so the renderer and
// animation code handle both formats alike.
//
// Layout cross-checked against OpenZT2 (MIT License, Copyright (c) OpenZT2 contributors,
// https://github.com/overyonder/openzt2), crates/game/src/assets/model_source/blue_fang_bfb_source.
//
//   0   "BFB!*000", version, "BlueFang" (80-byte header)
//   80  u32 object block count, u32 unknown
//   88  object blocks: u32 id, u16 type, u16 flags, u32 end offset, char name[64], content
//         type 6/8 "meshData": u8, char vertexFormat[64], u32 stride, u32 count, vertices,
//                               u8 primitive, u32 indexCount, u16 indices
//         type 5/8 (other names): logical mesh = u8, u32 meshDataId, u32 subMeshCount, then per
//                               sub-mesh: u32 indexStart, u32 indexCount, u32 vertexStart,
//                               u32 vertexCount, u32 faces, vec3 center, f32 radius (36 bytes);
//                               type 8 adds a skin table after them
//   then a node tree: u32 id, u32 type, i32 child, i32 sibling, u8, char name[64], 4x4 matrix;
//   mesh nodes (type 3) add u32 meshId @161, u32 count @165 and one char[128] material name
//   per sub-mesh @169; billboards (type 4) have one sub-mesh: u32 meshId @185, material @189
// Matrices are row-major with row vectors (Direct3D); copied as-is into a column-major
// Float32Array they become the column-vector matrices the rest of the engine uses.
import { mat4 } from './math.js';

const td = new TextDecoder('latin1');

export function isBFB(bytes) {
  return bytes.length > 8 && td.decode(bytes.subarray(0, 8)) === 'BFB!*000';
}

export function parseBFB(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (o) => dv.getUint32(o, true);
  const f32 = (o) => dv.getFloat32(o, true);
  const str = (o, n) => { const s = bytes.subarray(o, o + n); const e = s.indexOf(0); return td.decode(e >= 0 ? s.subarray(0, e) : s); };
  const matrix = (o) => { const m = new Float32Array(16); for (let i = 0; i < 16; i++) m[i] = f32(o + i * 4); return m; };

  const meshData = new Map();   // block id -> { format, stride, positions, normals, uvs, colors, indices }
  const meshBlocks = new Map(); // block id -> logical mesh (+ skin)
  const blockCount = u32(80);
  let p = 88;
  for (let b = 0; b < blockCount; b++) {
    const id = u32(p), type = dv.getUint16(p + 4, true), end = u32(p + 8);
    const name = str(p + 12, 64);
    const content = p + 76;
    if ((type === 6 || type === 8) && name.toLowerCase() === 'meshdata') {
      meshData.set(id, parseMeshData(dv, bytes, content, str));
    } else if (type === 5 || type === 8) {
      meshBlocks.set(id, parseMeshBlock(dv, content, type === 8, str, matrix));
    }
    if (end <= p) throw new Error('Invalid BFB block end');
    p = end;
  }
  const hierarchy = p < bytes.length ? parseHierarchy(dv, bytes.length, p, str, matrix) : [];
  return { meshData, meshBlocks, hierarchy };
}

function parseMeshData(dv, bytes, o, str) {
  const format = str(o + 1, 64);
  const stride = dv.getUint32(o + 65, true);
  const count = dv.getUint32(o + 69, true);
  const v0 = o + 73;
  const layout = vertexLayout(format);
  const positions = new Float32Array(count * 3);
  const normals = layout.normal >= 0 ? new Float32Array(count * 3) : null;
  const uvs = layout.uv >= 0 ? new Float32Array(count * 2) : null;
  const colors = layout.diffuse >= 0 ? new Float32Array(count * 4) : null;
  for (let i = 0; i < count; i++) {
    const v = v0 + i * stride;
    for (let k = 0; k < 3; k++) positions[i * 3 + k] = dv.getFloat32(v + k * 4, true);
    if (normals) for (let k = 0; k < 3; k++) normals[i * 3 + k] = dv.getFloat32(v + layout.normal + k * 4, true);
    if (uvs) { uvs[i * 2] = dv.getFloat32(v + layout.uv, true); uvs[i * 2 + 1] = dv.getFloat32(v + layout.uv + 4, true); }
    if (colors) {
      // D3DCOLOR is stored as B, G, R, A bytes.
      const c = v + layout.diffuse;
      colors[i * 4] = bytes[c + 2] / 255; colors[i * 4 + 1] = bytes[c + 1] / 255;
      colors[i * 4 + 2] = bytes[c] / 255; colors[i * 4 + 3] = bytes[c + 3] / 255;
    }
  }
  const after = v0 + stride * count;
  const indexCount = dv.getUint32(after + 1, true);
  const indices = new Uint16Array(indexCount);
  for (let i = 0; i < indexCount; i++) indices[i] = dv.getUint16(after + 5 + i * 2, true);
  return { format, stride, count, positions, normals, uvs, colors, indices };
}

// Byte offsets inside a vertex for "BFRVertexPNDT0T1"-style format names:
// P position(12) N normal(12) D diffuse(4) Tn uv(8) T3n uvw(12) T3Dn auxiliary vector(12).
function vertexLayout(format) {
  const f = format.replace(/^BFRVertex/, '');
  const out = { normal: -1, diffuse: -1, uv: -1 };
  let off = 0, i = 0;
  if (f[i] === 'P') { off += 12; i++; }
  if (f[i] === 'N') { out.normal = off; off += 12; i++; }
  if (f[i] === 'D' && !/\d/.test(f[i + 1] ?? '')) { out.diffuse = off; off += 4; i++; }
  for (const m of f.slice(i).matchAll(/T(3D|3)?(\d)/g)) {
    if (m[1] === '3D') { off += 12; continue; }
    if (out.uv < 0) out.uv = off;
    off += m[1] === '3' ? 12 : 8;
  }
  return out;
}

function parseMeshBlock(dv, o, hasSkin, str, matrix) {
  const c = o + 1;
  const count = dv.getUint32(c + 4, true);
  const subMeshes = [];
  for (let k = 0; k < count; k++) {
    const q = c + 8 + k * 36;
    subMeshes.push({
      indexStart: dv.getUint32(q, true),
      indexCount: dv.getUint32(q + 4, true),
      vertexStart: dv.getUint32(q + 8, true),
      vertexCount: dv.getUint32(q + 12, true),
    });
  }
  const block = { meshDataId: dv.getUint32(c, true), subMeshes, skin: null };
  if (hasSkin) {
    let q = c + 8 + count * 36;
    const boneCount = dv.getUint32(q, true), vertexCount = dv.getUint32(q + 4, true);
    q += 8;
    const bones = [];
    for (let i = 0; i < boneCount; i++) {
      bones.push({ id: dv.getUint8(q), parentId: dv.getUint8(q + 1), name: str(q + 3, 64), local: matrix(q + 67) });
      q += 131;
    }
    const boneIndex = new Float32Array(vertexCount * 4), boneWeight = new Float32Array(vertexCount * 4);
    for (let v = 0; v < vertexCount; v++) {
      const w = [dv.getFloat32(q + 4, true), dv.getFloat32(q + 8, true), dv.getFloat32(q + 12, true)];
      w.push(Math.max(0, 1 - w[0] - w[1] - w[2]));
      let total = 0;
      for (let k = 0; k < 4; k++) {
        const bi = dv.getUint8(q + k);
        const weight = bi === 255 ? 0 : w[k];
        boneIndex[v * 4 + k] = bi === 255 ? 0 : bi;
        boneWeight[v * 4 + k] = weight;
        total += weight;
      }
      if (total > 0) for (let k = 0; k < 4; k++) boneWeight[v * 4 + k] /= total;
      else boneWeight[v * 4] = 1;
      q += 16;
    }
    block.skin = { bones, boneIndex, boneWeight };
  }
  return block;
}

function parseHierarchy(dv, fileLength, start, str, matrix) {
  const nodes = [];
  const visited = new Set();
  const link = (v) => (v > 0 && v < fileLength ? v : null);
  function siblings(first, parent, parentIsLod, inheritedLod) {
    let offset = first, index = 0;
    while (offset !== null && !visited.has(offset)) {
      visited.add(offset);
      const type = dv.getUint32(offset + 4, true);
      const node = {
        name: str(offset + 17, 64),
        type,
        parent,
        lod: parentIsLod ? index : inheritedLod,
        local: matrix(offset + 81),
        mesh: null,
        materials: [], // one per sub-mesh
      };
      if (type === 3) {
        node.mesh = dv.getUint32(offset + 161, true);
        node.materials = Array.from({ length: dv.getUint32(offset + 165, true) }, (_, k) => str(offset + 169 + k * 128, 128));
      }
      if (type === 4) { node.mesh = dv.getUint32(offset + 185, true); node.materials = [str(offset + 189, 128)]; node.billboard = true; }
      const me = nodes.length;
      nodes.push(node);
      const child = link(dv.getInt32(offset + 8, true));
      const next = link(dv.getInt32(offset + 12, true));
      if (child !== null) siblings(child, me, type === 2, node.lod);
      offset = next;
      index++;
    }
  }
  siblings(start, -1, false, null);
  return nodes;
}

// Builds the engine model (see model.js) from a parsed BFB. `materials` maps material
// name -> { texture, alphaBlend, alphaTest, alphaThreshold, ... } resolved by the caller.
export function buildBFBModel(doc, materials = new Map()) {
  // Skeleton: skin bones (shared by name across meshes), then hierarchy nodes.
  const nodes = [];
  const byName = new Map();
  const addNode = (name, parent, local) => {
    const index = nodes.length;
    const m = local;
    const sx = Math.hypot(m[0], m[1], m[2]) || 1;
    nodes.push({
      name,
      parent,
      bind: local,
      translation: [m[12], m[13], m[14]],
      // Row-major 3x3 for column vectors, matching NIF node rotations.
      rotation: [m[0] / sx, m[4] / sx, m[8] / sx, m[1] / sx, m[5] / sx, m[9] / sx, m[2] / sx, m[6] / sx, m[10] / sx],
      scale: sx,
    });
    if (name && !byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), index);
    return index;
  };

  const skinBones = new Map(); // mesh block id -> { nodes: [nodeIndex], offsets: [inverse bind] }
  for (const [id, block] of doc.meshBlocks) {
    if (!block.skin) continue;
    const local = new Map(); // bone id -> node index
    const globals = [];
    const nodeIndices = [], offsets = [];
    for (const bone of block.skin.bones) {
      const parentNode = local.get(bone.parentId) ?? -1;
      let node = byName.get(bone.name.toLowerCase());
      if (node === undefined) node = addNode(bone.name, parentNode, bone.local);
      local.set(bone.id, node);
      const parentGlobal = globals[block.skin.bones.findIndex((b) => b.id === bone.parentId)];
      const global = parentGlobal ? mat4.multiply(parentGlobal, bone.local) : bone.local;
      globals.push(global);
      nodeIndices.push(node);
      offsets.push(mat4.invert(global));
    }
    skinBones.set(id, { nodes: nodeIndices, offsets });
  }

  const hierarchyNode = doc.hierarchy.map(() => -1);
  doc.hierarchy.forEach((h, i) => {
    const existing = byName.get(h.name.toLowerCase());
    hierarchyNode[i] = existing !== undefined && !h.mesh ? existing
      : addNode(h.name, h.parent >= 0 ? hierarchyNode[h.parent] : -1, h.local);
  });

  const bindWorld = [];
  nodes.forEach((n, i) => { bindWorld[i] = n.parent < 0 ? n.bind : mat4.multiply(bindWorld[n.parent], n.bind); });
  const skeleton = { nodes, byName, bindWorld, byBlock: new Map(), bindings: new WeakMap() };

  const meshes = [];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  doc.hierarchy.forEach((h, i) => {
    if (h.mesh === null || (h.lod !== null && h.lod !== 0)) return;
    const block = doc.meshBlocks.get(h.mesh);
    const data = block && doc.meshData.get(block.meshDataId);
    if (!data) return;
    // The skin table covers the block's vertices from its first sub-mesh on.
    const skinBase = block.subMeshes[0]?.vertexStart ?? 0;
    block.subMeshes.forEach((sub, k) => {
      const mesh = extractMesh(data, sub, block.skin, skinBase, skinBones.get(h.mesh), hierarchyNode[i], materials.get(h.materials[k]?.toLowerCase()));
      if (!mesh) return;
      if (h.billboard) mesh.billboard = true; // turned to face the camera when drawn
      mesh.materialName = h.materials[k]?.toLowerCase() ?? null; // for per-entity texture swaps
      meshes.push(mesh);
      const world = mesh.skin ? mat4.identity() : bindWorld[mesh.node];
      for (let v = 0; v < mesh.positions.length; v += 3) {
        const pt = mat4.transformPoint(world, mesh.positions.subarray(v, v + 3));
        for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], pt[a]); max[a] = Math.max(max[a], pt[a]); }
      }
    });
  });
  return { meshes, skeleton, bounds: { min, max } };
}

function extractMesh(data, block, blockSkin, skinBase, skin, node, material) {
  const { vertexStart: vs, vertexCount: vc } = block;
  const keep = new Int32Array(vc).fill(-1);
  let kept = 0;
  // Some shipped streams contain uninitialized 0xff spans (NaN); drop those vertices.
  for (let i = 0; i < vc; i++) {
    const g = vs + i;
    const ok = [data.positions[g * 3], data.positions[g * 3 + 1], data.positions[g * 3 + 2]].every(Number.isFinite);
    if (ok) keep[i] = kept++;
  }
  const indices = [];
  for (let i = 0; i + 2 < block.indexCount; i += 3) {
    const a = keep[data.indices[block.indexStart + i]], b = keep[data.indices[block.indexStart + i + 1]], c = keep[data.indices[block.indexStart + i + 2]];
    if (a >= 0 && b >= 0 && c >= 0) indices.push(a, b, c);
  }
  if (!indices.length) return null;
  const copy = (src, n) => {
    if (!src) return null;
    const out = new Float32Array(kept * n);
    for (let i = 0; i < vc; i++) if (keep[i] >= 0) for (let k = 0; k < n; k++) {
      const v = src[(vs + i) * n + k];
      out[keep[i] * n + k] = Number.isFinite(v) ? v : 0;
    }
    return out;
  };
  let skinOut = null;
  if (skin && blockSkin) {
    const bi = new Float32Array(kept * 4), bw = new Float32Array(kept * 4);
    const base = vs - skinBase;
    for (let i = 0; i < vc; i++) if (keep[i] >= 0) for (let k = 0; k < 4; k++) {
      bi[keep[i] * 4 + k] = blockSkin.boneIndex[(base + i) * 4 + k] ?? 0;
      bw[keep[i] * 4 + k] = blockSkin.boneWeight[(base + i) * 4 + k] ?? (k ? 0 : 1);
    }
    skinOut = { bones: skin.nodes, offsets: skin.offsets, boneIndex: bi, boneWeight: bw };
  }
  return {
    name: '',
    node,
    skin: skinOut,
    positions: copy(data.positions, 3),
    normals: copy(data.normals, 3) ?? new Float32Array(kept * 3).map((_, i) => (i % 3 === 2 ? 1 : 0)),
    uvs: copy(data.uvs, 2),
    colors: material?.vertexColors ? copy(data.colors, 4) : null,
    indices: kept > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
    texture: material?.texture ?? null,
    textureWrap: true,
    material: {
      // With vertex colours as the material source, the colour comes from the vertices instead.
      diffuse: material?.vertexColors && data.colors ? [1, 1, 1] : material?.diffuse ?? [1, 1, 1],
      ambient: material?.vertexColors && data.colors ? [1, 1, 1] : material?.ambient ?? [1, 1, 1],
      emissive: material?.emissive ?? [0, 0, 0],
      alpha: material?.alpha ?? 1,
    },
    alphaBlend: material?.alphaBlend ?? false,
    alphaTest: material?.alphaTest ?? false,
    alphaThreshold: material?.alphaThreshold ?? 0.5,
    doubleSided: material?.doubleSided ?? false,
  };
}

// The render states an effect file (effects/<fx>.fx) sets in its first pass, as bfmat-style
// parameter values: materials naming that effect inherit them unless they set their own (e.g.
// foliage cards get alpha testing from Base_fres_wind.fx).
export function parseEffectStates(fxText) {
  const pass = /\bpass\s+\w+\s*\{([\s\S]*?)\}/.exec(fxText.replace(/\/\/[^\n]*/g, ''))?.[1] ?? '';
  const out = {};
  for (const m of pass.matchAll(/(\w+)\s*=\s*([^;]+);/g)) {
    const key = m[1].toLowerCase(), raw = m[2].trim();
    if (/^(alphatestenable|alphablendenable|zwriteenable)$/.test(key)) out[key] = raw.toLowerCase();
    else if (key === 'alpharef') out[key] = String(Number(raw));
    else if (key === 'cullmode') out[key] = /none/i.test(raw) ? '1' : raw;
  }
  return out;
}

// Parses a .bfmat (XML) into the few properties the current renderer uses. effectStates: the
// defaults of the material's effect (parseEffectStates), keyed by lowercase parameter name.
export function parseBFMat(text, effectStates = {}) {
  const param = (name) => new RegExp(`<param name="${name}"[^>]*>([^<]*)</param>`, 'i').exec(text)?.[1]?.trim() ?? effectStates[name.toLowerCase()];
  const ref = Number(param('AlphaRef') ?? 128);
  const color = (name, fallback) => {
    const v = param(name)?.split(/[,\s]+/).filter(Boolean).map(Number);
    return v && v.length >= 3 && v.every(Number.isFinite) ? v : fallback;
  };
  const diffuse = color('MaterialDiffuse', [1, 1, 1, 1]);
  return {
    texture: param('Texture0') ?? null,
    diffuse: diffuse.slice(0, 3),
    ambient: color('MaterialAmbient', [1, 1, 1, 1]).slice(0, 3),
    emissive: color('MaterialEmissive', [0, 0, 0, 1]).slice(0, 3),
    alpha: diffuse[3] ?? 1,
    // D3D material source 1 (D3DMCS_COLOR1): diffuse/ambient come from the vertex colour stream.
    vertexColors: param('DiffuseMaterialSource') === '1' || param('AmbientMaterialSource') === '1',
    alphaBlend: param('AlphaBlendEnable') === 'true',
    alphaTest: param('AlphaTestEnable') === 'true',
    alphaThreshold: (Number.isFinite(ref) ? ref : 128) / 255,
    doubleSided: param('CullMode') === '1',
  };
}
