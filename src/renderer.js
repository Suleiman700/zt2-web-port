// WebGL2 renderer. Z is up, matching the game's coordinate system.
// Models are uploaded once (uploadModel) and drawn many times with a per-instance matrix.
import { mat4 } from './math.js';
import { uvTransformAt } from './model.js';

const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec2 aUV;
layout(location=3) in vec4 aColor;
layout(location=4) in vec4 aBoneIndex;
layout(location=5) in vec4 aBoneWeight;
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform bool uSkinned;
uniform highp sampler2D uBoneTex; // 4 texels (matrix columns) per bone row
uniform vec4 uUVTransform; // u offset, v offset, u tiling, v tiling (scrolling textures)
mat4 bone(float i) {
  int row = int(i);
  return mat4(texelFetch(uBoneTex, ivec2(0, row), 0), texelFetch(uBoneTex, ivec2(1, row), 0),
              texelFetch(uBoneTex, ivec2(2, row), 0), texelFetch(uBoneTex, ivec2(3, row), 0));
}
out vec3 vNormal;
out vec2 vUV;
out vec4 vColor;
out vec3 vWorld;
void main() {
  mat4 m = uModel;
  if (uSkinned) {
    m = m * (bone(aBoneIndex.x) * aBoneWeight.x + bone(aBoneIndex.y) * aBoneWeight.y +
             bone(aBoneIndex.z) * aBoneWeight.z + bone(aBoneIndex.w) * aBoneWeight.w);
  }
  vec4 world = m * vec4(aPos, 1.0);
  vWorld = world.xyz;
  vNormal = mat3(m) * aNormal;
  vUV = aUV * uUVTransform.zw + uUVTransform.xy;
  vColor = aColor;
  gl_Position = uViewProj * world;
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec2 vUV;
in vec4 vColor;
in vec3 vWorld;
uniform sampler2D uTex;
uniform bool uHasTex;
uniform sampler2D uDecal; // a decal layer over the base texture (a guest's shirt over the skin)
uniform bool uHasDecal;
uniform vec3 uDiffuse, uAmbient, uEmissive;
uniform float uAlpha, uAlphaThreshold;
uniform bool uAlphaTest;
uniform vec3 uAmbientLight;
uniform vec3 uLightDir[3];   // towards each light: sun, side, back (world/lights objectLights)
uniform vec3 uLightColor[3]; // diffuse colour * intensity
uniform vec4 uTint;
uniform float uGrid; // tile size for grid lines, 0 = off
out vec4 outColor;
void main() {
  vec4 base = uHasTex ? texture(uTex, vUV) : vec4(1.0);
  if (uHasDecal) { vec4 d = texture(uDecal, vUV); base.rgb = mix(base.rgb, d.rgb, d.a); }
  base *= vColor;
  float a = base.a * uAlpha;
  if (uAlphaTest && a < uAlphaThreshold) discard;
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  // Direct3D fixed-function style: emissive + ambient + sum of directional lights, clamped, then
  // modulated by the texture (emissive is part of the vertex lighting, not added afterwards).
  vec3 light = uEmissive + uAmbient * uAmbientLight;
  for (int i = 0; i < 3; i++) light += uDiffuse * uLightColor[i] * max(dot(n, uLightDir[i]), 0.0);
  vec3 color = base.rgb * clamp(light, 0.0, 1.0);
  if (uGrid > 0.0) {
    vec2 g = abs(fract(vWorld.xy / uGrid + 0.5) - 0.5) * uGrid;
    float line = 1.0 - smoothstep(0.0, 0.06, min(g.x, g.y));
    color = mix(color, vec3(1.0), line * 0.35);
  }
  outColor = vec4(color, a) * uTint;
}`;

// Bones per skinned mesh; ZT2 models use at most 85 (Indian peafowl).
const MAX_BONES = 128;
const UNIFORMS = ['uViewProj', 'uModel', 'uSkinned', 'uBoneTex', 'uTex', 'uHasTex', 'uDecal', 'uHasDecal', 'uDiffuse', 'uAmbient', 'uEmissive', 'uAlpha',
  'uAlphaThreshold', 'uAlphaTest', 'uAmbientLight', 'uLightDir', 'uLightColor', 'uTint', 'uGrid', 'uUVTransform'];
const NO_UV_TRANSFORM = [0, 0, 1, 1];
const NO_TINT = [1, 1, 1, 1];
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const boneData = new Float32Array(MAX_BONES * 16);

export class Renderer {
  constructor(canvas) {
    // Opaque canvas: otherwise partly transparent pixels let the page behind show through.
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.canvas = canvas;
    this.time = 0; // seconds, for texture animations; advanced by the caller each frame
    this.program = link(gl, VS, FS);
    this.boneTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.boneTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 4, MAX_BONES, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.u = {};
    for (const name of UNIFORMS) this.u[name] = gl.getUniformLocation(this.program, name);
    // Defaults until a map's lights are loaded (setLights); close to the original's midday.
    this.lighting = {
      ambient: [0.42, 0.44, 0.52],
      lights: [
        { color: [0.78, 0.73, 0.65], direction: normalize([0.0, -0.3, 1.0]) },
        { color: [0.18, 0.18, 0.25], direction: normalize([-0.65, 0.41, 0.64]) },
        { color: [0.24, 0.24, 0.34], direction: normalize([0.43, 0.62, 0.66]) },
      ],
    };
  }

  // Resizes the canvas to its display size and clears it. Returns the aspect ratio.
  begin(clearColor = [0.55, 0.68, 0.78]) {
    const { gl, canvas } = this;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr)), h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clearColor(clearColor[0], clearColor[1], clearColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    return w / h;
  }

  // `textures` maps texture file name -> WebGLTexture (or null if missing).
  uploadModel(model, textures) {
    const gl = this.gl;
    const meshes = model.meshes.map((mesh) => {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const buffers = [attrib(gl, 0, mesh.positions, 3), attrib(gl, 1, mesh.normals, 3)];
      if (mesh.uvs) buffers.push(attrib(gl, 2, mesh.uvs, 2));
      else { gl.disableVertexAttribArray(2); gl.vertexAttrib2f(2, 0, 0); }
      if (mesh.colors) buffers.push(attrib(gl, 3, mesh.colors, 4));
      else { gl.disableVertexAttribArray(3); gl.vertexAttrib4f(3, 1, 1, 1, 1); }
      const skin = mesh.skin && mesh.skin.bones.length <= MAX_BONES ? mesh.skin : null;
      if (skin) buffers.push(attrib(gl, 4, skin.boneIndex, 4), attrib(gl, 5, skin.boneWeight, 4));
      const ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      buffers.push(ib);
      gl.bindVertexArray(null);
      return {
        vao, buffers,
        node: mesh.node ?? null,
        skin: skin ? { bones: skin.bones, offsets: skin.offsets } : null,
        tex: mesh.texture ? textures.get(mesh.texture) ?? null : null,
        materialName: mesh.materialName ?? null,
        count: mesh.indices.length,
        indexType: mesh.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
        material: mesh.material,
        alphaBlend: mesh.alphaBlend,
        alphaTest: mesh.alphaTest,
        alphaThreshold: mesh.alphaThreshold,
        grid: mesh.grid ?? 0,
        uvAnim: mesh.uvAnim ?? null,
        billboard: !!mesh.billboard,
      };
    });
    const { min, max } = model.bounds;
    const valid = isFinite(min[0]);
    const center = valid ? [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] : [0, 0, 0];
    const radius = valid ? Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 : 0;
    return { meshes, bounds: model.bounds, center, radius, bindWorld: model.skeleton?.bindWorld ?? null };
  }

  deleteModel(gpu) {
    const gl = this.gl;
    for (const m of gpu.meshes) {
      gl.deleteVertexArray(m.vao);
      for (const b of m.buffers) gl.deleteBuffer(b);
    }
  }

  createTexture(image, wrap = true) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, image.width, image.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, image.data);
    // Prefer the file's own mip levels (they keep alpha-tested detail); generate them otherwise.
    const mips = image.mips;
    const complete = mips && mips.length > 1 && mips.at(-1).width === 1 && mips.at(-1).height === 1;
    if (complete) {
      for (let i = 1; i < mips.length; i++) gl.texImage2D(gl.TEXTURE_2D, i, gl.RGBA, mips[i].width, mips[i].height, 0, gl.RGBA, gl.UNSIGNED_BYTE, mips[i].data);
    } else {
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const mode = wrap ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, mode);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, mode);
    return t;
  }

  // items: [{ model: gpuModel, matrix: Float32Array(16), pose?: node world matrices, tint?: [r,g,b,a],
  //   textures?: Map(material name -> { base?: WebGLTexture, decal?: WebGLTexture }) }]
  draw(items, viewProj) {
    const { gl, u } = this;
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE); // winding order of ZT2 models not yet verified; draw both sides
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(u.uViewProj, false, viewProj);
    gl.uniform3fv(u.uAmbientLight, this.lighting.ambient);
    gl.uniform3fv(u.uLightDir, this.lighting.lights.flatMap((l) => l.direction));
    gl.uniform3fv(u.uLightColor, this.lighting.lights.flatMap((l) => l.color));
    gl.uniform1i(u.uTex, 0);
    gl.uniform1i(u.uBoneTex, 1);
    gl.uniform1i(u.uDecal, 2);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.boneTex);
    gl.activeTexture(gl.TEXTURE0);

    // Opaque first, then blended meshes (and tinted ghosts) without depth writes.
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    for (const it of items) {
      if (it.tint && it.tint[3] < 1) continue;
      for (const m of it.model.meshes) if (!m.alphaBlend) this.drawMesh(m, it);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    for (const it of items) {
      const ghost = it.tint && it.tint[3] < 1;
      for (const m of it.model.meshes) if (m.alphaBlend || ghost) this.drawMesh(m, it);
    }
    gl.depthMask(true);
  }

  drawMesh(m, it) {
    const { gl, u } = this;
    const nodes = it.pose ?? it.model.bindWorld;
    if (m.skin) {
      const n = m.skin.bones.length;
      for (let i = 0; i < n; i++) boneData.set(mat4.multiply(nodes[m.skin.bones[i]], m.skin.offsets[i]), i * 16);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.boneTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 4, n, gl.RGBA, gl.FLOAT, boneData, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(u.uSkinned, 1);
      gl.uniformMatrix4fv(u.uModel, false, it.matrix);
    } else {
      gl.uniform1i(u.uSkinned, 0);
      const world = nodes && m.node !== null ? mat4.multiply(it.matrix, nodes[m.node]) : it.matrix;
      gl.uniformMatrix4fv(u.uModel, false, m.billboard && this.eye ? faceCamera(world, this.eye) : world);
    }
    gl.uniform4fv(u.uTint, it.tint ?? NO_TINT);
    gl.uniform1f(u.uGrid, m.grid);
    gl.uniform4fv(u.uUVTransform, m.uvAnim ? uvTransformAt(m.uvAnim, this.time) : NO_UV_TRANSFORM);
    // it.textures: per-entity layers by material name, { base, decal } (a guest's skin and clothes).
    const layers = m.materialName ? it.textures?.get(m.materialName) : null;
    const tex = layers?.base || m.tex;
    gl.uniform1i(u.uHasTex, tex ? 1 : 0);
    if (tex) gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(u.uHasDecal, layers?.decal ? 1 : 0);
    if (layers?.decal) { gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, layers.decal); gl.activeTexture(gl.TEXTURE0); }
    gl.uniform3fv(u.uDiffuse, m.material.diffuse);
    gl.uniform3fv(u.uAmbient, m.material.ambient);
    gl.uniform3fv(u.uEmissive, m.material.emissive);
    gl.uniform1f(u.uAlpha, m.material.alpha);
    gl.uniform1i(u.uAlphaTest, m.alphaTest || m.alphaBlend ? 1 : 0);
    gl.uniform1f(u.uAlphaThreshold, m.alphaTest ? Math.max(m.alphaThreshold, 0.01) : 0.01);
    gl.bindVertexArray(m.vao);
    gl.drawElements(gl.TRIANGLES, m.count, m.indexType, 0);
    gl.bindVertexArray(null);
  }
}

function normalize(v) { const l = Math.hypot(...v); return v.map((x) => x / l); }

function attrib(gl, loc, data, size) {
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  return b;
}

export function link(gl, vs, fs) {
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

// Billboard nodes (BFB type 4, e.g. droppings): the quad stands in the node's X/Z plane and is
// turned about the vertical axis so it faces the camera, keeping the node's position and scale.
function faceCamera(world, eye) {
  const ox = world[12], oy = world[13];
  const scale = Math.hypot(world[0], world[1], world[2]);
  const a = Math.atan2(eye[0] - ox, -(eye[1] - oy));
  const c = Math.cos(a) * scale, s = Math.sin(a) * scale;
  const out = new Float32Array(world);
  out.set([c, s, 0, 0, -s, c, 0, 0, 0, 0, scale, 0], 0);
  return out;
}
