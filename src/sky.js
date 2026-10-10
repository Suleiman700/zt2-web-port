// The sky dome (world/environments/sky/<biome>_sky.xml, BFColorInterpolateSkyLayer): one sphere
// model per time of day (night, sunrise, midmorning, noon, afternoon, sunset) sharing the same
// vertices; the sky's colour is their vertex colours interpolated by the clock's time of day.
// Drawn first, centred on the camera, without depth.
import { parseBFB } from './bfb.js';
import { link } from './renderer.js';

const VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aColorA;
layout(location=2) in vec4 aColorB;
uniform mat4 uViewProj; // camera rotation and projection only
uniform float uMix;
out vec3 vColor;
void main() {
  vColor = mix(aColorA.rgb, aColorB.rgb, uMix);
  vec4 p = uViewProj * vec4(aPos, 1.0);
  gl_Position = p.xyww; // on the far plane, never clipped by the near plane
}`;
const FS = `#version 300 es
precision mediump float;
in vec3 vColor;
out vec4 outColor;
void main() { outColor = vec4(vColor, 1.0); }`;

export class Sky {
  constructor(gl) {
    this.gl = gl;
    this.program = link(gl, VS, FS);
    this.loc = { viewProj: gl.getUniformLocation(this.program, 'uViewProj'), mix: gl.getUniformLocation(this.program, 'uMix') };
    this.keys = []; // { t, colors: WebGLBuffer }
    this.vao = null;
    this.count = 0;
  }

  // skyXml: text of the biome's sky layers file.
  async load(fs, skyXml) {
    const layer = /<BFColorInterpolateSkyLayer[\s\S]*?<\/BFColorInterpolateSkyLayer>/.exec(skyXml)?.[0];
    if (!layer) return false;
    const models = [...(/<interpModels([^>]*)>/.exec(layer)?.[1] ?? '').matchAll(/\bmode(?:l)?(\d+)="([^"]+)"/g)].map((m) => [Number(m[1]), m[2]]);
    const times = new Map([...(/<interpTimes([^>]*)>/.exec(layer)?.[1] ?? '').matchAll(/\bt(\d+)="([\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]));
    const gl = this.gl;
    const keys = [];
    let positions = null, indices = null;
    for (const [n, name] of models.sort((a, b) => a[0] - b[0])) {
      const path = /\.(bfb|nif)$/i.test(name) ? name : `${name}.bfb`;
      if (!fs.has(path) || !times.has(n)) continue;
      const doc = parseBFB(await fs.read(path));
      const data = [...doc.meshData.values()][0];
      if (!data?.colors) continue;
      if (!positions) { positions = data.positions; indices = data.indices; }
      if (data.count * 3 !== positions.length) continue; // every key must share the vertices
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data.colors, gl.STATIC_DRAW);
      keys.push({ t: times.get(n), colors: buffer });
    }
    if (!keys.length) return false;
    // The cycle wraps: the last key (t = 1) repeats the first when the file leaves it out.
    if (keys.at(-1).t < 1) keys.push({ t: 1, colors: keys[0].colors });
    this.keys = keys;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const pos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.count = indices.length;
    return true;
  }

  // The sun body (first ZTSunLayer): position nodes in sunpositions.xml's model, and per time of
  // day a node, a scale and a colour. loadModel(path) -> { gpu, model } (Assets.model).
  async loadSun(fs, skyXml, loadModel) {
    const layer = /<ZTSunLayer\b([^>]*)>([\s\S]*?)<\/ZTSunLayer>/.exec(skyXml);
    if (!layer) return false;
    const list = (tag, prefix) => [...(new RegExp(`<${tag}([^>]*)>`).exec(layer[2])?.[1] ?? '').matchAll(new RegExp(`\\b${prefix}(\\d+)="([^"]+)"`, 'g'))]
      .sort((a, b) => a[1] - b[1]).map((m) => m[2]);
    const times = list('interpTimes', 't').map(Number), scales = list('interpScales', 's').map(Number);
    const nodes = list('interpNodes', 'n'), colors = list('interpColors', 'c').map((c) => c.trim().split(/\s+/).map((v) => Number(v) / 255));
    const xmlModel = async (xmlPath) => {
      if (!xmlPath || !fs.has(xmlPath)) return null;
      const file = /modelfile="([^"]+)"/.exec(new TextDecoder().decode(await fs.read(xmlPath)))?.[1]?.replace(/\\/g, '/');
      return file && [file, `${file}.bfb`, `${file}.nif`].find((p) => fs.has(p));
    };
    const positionsPath = await xmlModel(/sunPositionModel="([^"]+)"/.exec(layer[1])?.[1]);
    const bodyPath = await xmlModel(/<sunModels[^>]*model1="([^"]+)"/.exec(layer[2])?.[1]);
    if (!positionsPath || !bodyPath || !times.length) return false;
    const positions = (await loadModel(positionsPath)).model.skeleton;
    const keys = times.map((t, i) => {
      const n = positions.byName.get(nodes[i]?.toLowerCase());
      const w = n !== undefined ? positions.bindWorld[n] : null;
      return { t, scale: scales[i] ?? 1, color: colors[i] ?? [1, 1, 1], pos: w ? [w[12], w[13], w[14]] : null };
    }).filter((k) => k.pos);
    this.sun = { keys, gpu: (await loadModel(bodyPath)).gpu };
    return true;
  }

  // World matrix (in sky space, around the eye) and colour of the sun at time t, or null.
  sunAt(t) {
    const keys = this.sun?.keys;
    if (!keys?.length) return null;
    let i = keys.findIndex((k) => k.t > t);
    if (i <= 0) i = keys.length - 1;
    const a = keys[i - 1] ?? keys[0], b = keys[i];
    const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    const mix = (x, y) => x.map((v, k) => v + (y[k] - v) * f);
    const p = mix(a.pos, b.pos), s = a.scale + (b.scale - a.scale) * f;
    // Face the eye: the quad's normal is its -Y axis, so +Y points away from the eye.
    const len = Math.hypot(...p) || 1, y = p.map((v) => v / len);
    let x = [y[1], -y[0], 0];
    const xl = Math.hypot(...x) || 1;
    x = x.map((v) => v / xl);
    const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    const matrix = new Float32Array([...x.map((v) => v * s), 0, ...y.map((v) => v * s), 0, ...z.map((v) => v * s), 0, ...p, 1]);
    return { matrix, color: mix(a.color, b.color), gpu: this.sun.gpu };
  }

  draw(rotationViewProj, t) {
    if (!this.vao) return;
    const gl = this.gl, keys = this.keys;
    let i = keys.findIndex((k) => k.t > t);
    if (i <= 0) i = keys.length - 1;
    const a = keys[i - 1] ?? keys[0], b = keys[i];
    const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    for (const [loc, buffer] of [[1, a.colors], [2, b.colors]]) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 0, 0);
    }
    gl.uniformMatrix4fv(this.loc.viewProj, false, rotationViewProj);
    gl.uniform1f(this.loc.mix, f);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_SHORT, 0);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
  }
}
