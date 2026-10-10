// Old-style Gamebryo particle effects (NiParticles + NiParticleSystemController), used by the
// emoticons above animals, guests and staff (world/particlesystems/emoticons/*.nif) and by small
// effects such as dust and splashes. Everything comes from the file: emit start/stop and rate,
// lifetime, speed and spread, size, grow/fade, spin, colour keys, the material's animated alpha
// and colour, the texture and its blend mode. Particles are drawn as camera-facing quads.
import { parseNif } from './nif.js';
import { link } from './renderer.js';

const VS = `#version 300 es
in vec3 aPos; in vec2 aUV; in vec4 aColor;
uniform mat4 uViewProj;
out vec2 vUV; out vec4 vColor;
void main() { vUV = aUV; vColor = aColor; gl_Position = uViewProj * vec4(aPos, 1.0); }`;
const FS = `#version 300 es
precision mediump float;
in vec2 vUV; in vec4 vColor;
uniform sampler2D uTex; uniform float uAlphaRef;
out vec4 outColor;
void main() { vec4 c = texture(uTex, vUV) * vColor; if (c.a <= uAlphaRef) discard; outColor = c; }`;

// NiAlphaProperty blend factors -> GL.
const BLEND = (gl) => [gl.ONE, gl.ZERO, gl.SRC_COLOR, gl.ONE_MINUS_SRC_COLOR, gl.DST_COLOR, gl.ONE_MINUS_DST_COLOR,
  gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.DST_ALPHA, gl.ONE_MINUS_DST_ALPHA, gl.SRC_ALPHA_SATURATE];

// Value of a key group at time t (linear, or Hermite for quadratic keys).
function sample(group, t, fallback) {
  const keys = group?.keys;
  if (!keys?.length) return fallback;
  if (t <= keys[0].time) return keys[0].value;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (t > b.time) continue;
    const f = (t - a.time) / Math.max(b.time - a.time, 1e-6);
    const mix = (va, vb, ta, tb) => {
      if (group.interpolation !== 2) return va + (vb - va) * f;
      const f2 = f * f, f3 = f2 * f;
      return (2 * f3 - 3 * f2 + 1) * va + (f3 - 2 * f2 + f) * ta + (-2 * f3 + 3 * f2) * vb + (f3 - f2) * tb;
    };
    if (Array.isArray(a.value)) return a.value.map((v, k) => mix(v, b.value[k], a.forward?.[k] ?? 0, b.backward?.[k] ?? 0));
    return mix(a.value, b.value, a.forward ?? 0, b.backward ?? 0);
  }
  return keys.at(-1).value;
}

// Parses an effect file into particle systems (nothing GPU-side yet).
export function parseEffect(bytes) {
  const nif = parseNif(bytes);
  const blocks = nif.blocks ?? [];
  const get = (i) => (i >= 0 ? blocks[i] : null);
  // Node world positions; children of billboard nodes are laid out in screen space with y up.
  const parent = new Map();
  for (const b of blocks) for (const c of b.children ?? []) if (c >= 0) parent.set(c, b.index);
  const worldPos = (i) => {
    let p = [0, 0, 0];
    for (let n = i; n !== undefined && n >= 0; n = parent.get(n)) {
      const b = blocks[n];
      if (!b?.translation) continue;
      const underBillboard = (() => { for (let q = parent.get(n); q !== undefined; q = parent.get(q)) if (blocks[q]?.type === 'NiBillboardNode') return true; return false; })();
      const [x, y, z] = b.translation;
      p = underBillboard ? [p[0] + x, p[1] - z, p[2] + y] : [p[0] + x, p[1] + y, p[2] + z];
    }
    return p;
  };
  const systems = [];
  for (const b of blocks) {
    if (b.type !== 'NiParticles') continue;
    let ctl = get(b.controller);
    while (ctl && ctl.type !== 'NiParticleSystemController') ctl = get(ctl.nextController);
    if (!ctl) continue;
    const props = (b.properties ?? []).map(get).filter(Boolean);
    const texProp = props.find((p) => p.type === 'NiTexturingProperty');
    const texture = get(texProp?.base?.source ?? -1)?.fileName ?? null;
    const alpha = props.find((p) => p.type === 'NiAlphaProperty');
    const material = props.find((p) => p.type === 'NiMaterialProperty');
    const vertexColor = props.find((p) => p.type === 'NiVertexColorProperty');
    const matCtl = { alpha: null, colors: {} };
    for (let c = get(material?.controller ?? -1); c; c = get(c.nextController)) {
      if (c.type === 'NiAlphaController') matCtl.alpha = { ctl: c, keys: get(c.data)?.data };
      if (c.type === 'NiMaterialColorController') matCtl.colors[(c.flags >> 4) & 7] = { ctl: c, keys: get(c.data)?.data };
    }
    const mods = { grow: 0, fade: 0, spin: 0, colors: null };
    for (let m = get(ctl.particleExtra); m; m = get(m.nextModifier)) {
      if (m.type === 'NiParticleGrowFade') { mods.grow = m.grow; mods.fade = m.fade; }
      if (m.type === 'NiParticleRotation') { mods.spin = m.rotationSpeed; mods.randomAngle = Boolean(m.randomInitialAxis); }
      if (m.type === 'NiParticleColorModifier') mods.colors = get(m.colorData)?.data ?? null;
      if (m.type === 'NiGravity') mods.gravity = m;
    }
    const flags = alpha?.flags ?? 0;
    systems.push({
      texture,
      emitter: worldPos(ctl.emitter),
      ctl,
      maxParticles: Math.max(1, ctl.particles?.length ?? 8),
      blend: flags & 1 ? { src: (flags >> 1) & 15, dst: (flags >> 5) & 15 } : null,
      alphaTest: flags & 512 ? (alpha.threshold ?? 0) / 255 : 0,
      material: { alpha: material?.alpha ?? 1, emissive: material?.emissive ?? [1, 1, 1], diffuse: material?.diffuse ?? [1, 1, 1], ambient: material?.ambient ?? [1, 1, 1] },
      matCtl,
      vertexColors: (vertexColor?.vertexMode ?? 0) > 0,
      mods,
    });
  }
  return { systems, complete: nif.complete, error: nif.error };
}

const rand = (a) => (Math.random() * 2 - 1) * a;

// One playing copy of an effect at a point (e.g. above an animal's head).
export class EffectInstance {
  constructor(effect, { lifetime = Infinity } = {}) {
    this.effect = effect;
    this.time = 0;
    this.lifetime = lifetime;
    this.systems = effect.systems.map(() => ({ particles: [], emitted: 0 }));
  }

  get done() { return this.time >= this.lifetime; }

  update(dt) {
    this.time += dt;
    this.effect.systems.forEach((sys, k) => {
      const st = this.systems[k], c = sys.ctl, t = this.time;
      for (const p of st.particles) {
        p.age += dt;
        p.pos[0] += p.vel[0] * dt; p.pos[1] += p.vel[1] * dt; p.pos[2] += p.vel[2] * dt;
        if (sys.mods.gravity) p.vel[2] -= (sys.mods.gravity.force ?? 0) * dt;
      }
      st.particles = st.particles.filter((p) => p.age < p.life);
      // Emission between emitStartTime and emitStopTime at emitRate per second.
      if (t >= c.emitStartTime && t - dt <= c.emitStopTime) {
        const from = Math.max(c.emitStartTime, t - dt), to = Math.min(c.emitStopTime, t);
        st.emitted += Math.max(0, to - from) * c.emitRate;
        if (st.emitted < 1 && st.particles.length === 0 && st.first === undefined) { st.emitted = 1; st.first = true; }
        while (st.emitted >= 1 && st.particles.length < sys.maxParticles) {
          st.emitted -= 1;
          const dec = c.verticalDirection + rand(c.verticalAngle), planar = c.horizontalDirection + rand(c.horizontalAngle);
          const speed = c.speed + rand(c.speedRandom);
          st.particles.push({
            age: 0,
            life: c.lifetime + rand(c.lifetimeRandom),
            pos: sys.emitter.map((v, i) => v + rand(c.startRandom[i] ?? 0)),
            vel: [Math.sin(dec) * Math.cos(planar) * speed, Math.sin(dec) * Math.sin(planar) * speed, Math.cos(dec) * speed],
            // Upright (emoticon faces) unless the system turns its particles to random angles.
            angle: sys.mods.randomAngle ? Math.random() * Math.PI * 2 : 0,
          });
        }
        if (st.particles.length >= sys.maxParticles) st.emitted = Math.min(st.emitted, 1);
      }
    });
  }
}

export class ParticleRenderer {
  constructor(gl) {
    this.gl = gl;
    this.program = link(gl, VS, FS);
    this.u = { viewProj: gl.getUniformLocation(this.program, 'uViewProj'), tex: gl.getUniformLocation(this.program, 'uTex'), alphaRef: gl.getUniformLocation(this.program, 'uAlphaRef') };
    this.vao = gl.createVertexArray();
    this.buffer = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const stride = 9 * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 20);
    gl.bindVertexArray(null);
    this.data = new Float32Array(9 * 6 * 64);
  }

  // items: [{ instance, origin: [x, y, z], scale, textures: Map(fileName -> WebGLTexture) }]
  // eye/target give the camera's facing for the quads.
  draw(items, viewProj, right, up) {
    const gl = this.gl;
    if (!items.length) return;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.u.viewProj, false, viewProj);
    gl.uniform1i(this.u.tex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    const blend = BLEND(gl);
    for (const it of items) {
      const inst = it.instance, t = inst.time, s = it.scale ?? 1;
      inst.effect.systems.forEach((sys, k) => {
        const parts = inst.systems[k].particles;
        const tex = it.textures.get(sys.texture);
        if (!parts.length || !tex) return;
        // Material: animated alpha and colours (Gamebryo lighting: emissive + ambient + diffuse, capped).
        const m = sys.material, mc = sys.matCtl;
        const alpha = mc.alpha ? sample(mc.alpha.keys, Math.min(t, mc.alpha.ctl.stopTime), m.alpha) : m.alpha;
        const amb = mc.colors[0] ? sample(mc.colors[0].keys, t, m.ambient) : m.ambient;
        const dif = mc.colors[1] ? sample(mc.colors[1].keys, t, m.diffuse) : m.diffuse;
        const emi = mc.colors[3] ? sample(mc.colors[3].keys, t, m.emissive) : m.emissive;
        const base = [0, 1, 2].map((i) => Math.min(1, emi[i] + 0.35 * amb[i] + 0.55 * dif[i]));
        if (sys.blend) gl.blendFunc(blend[sys.blend.src] ?? gl.SRC_ALPHA, blend[sys.blend.dst] ?? gl.ONE_MINUS_SRC_ALPHA);
        else gl.blendFunc(gl.ONE, gl.ZERO);
        gl.uniform1f(this.u.alphaRef, sys.alphaTest || 0.003);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        const need = parts.length * 6 * 9;
        if (this.data.length < need) this.data = new Float32Array(need * 2);
        let o = 0;
        for (const p of parts) {
          // Size: grows in over `grow` seconds and shrinks over the last `fade` seconds.
          let size = sys.ctl.size * s;
          if (sys.mods.grow > 0 && p.age < sys.mods.grow) size *= p.age / sys.mods.grow;
          if (sys.mods.fade > 0 && p.life - p.age < sys.mods.fade) size *= Math.max(0, (p.life - p.age) / sys.mods.fade);
          const col = sys.mods.colors ? sample(sys.mods.colors, p.age / Math.max(p.life, 1e-6), [1, 1, 1, 1]) : [1, 1, 1, 1];
          const rgba = [base[0] * col[0], base[1] * col[1], base[2] * col[2], alpha * col[3]];
          const ang = p.angle + sys.mods.spin * p.age, c = Math.cos(ang) * size, sn = Math.sin(ang) * size;
          const ax = [right[0] * c + up[0] * sn, right[1] * c + up[1] * sn, right[2] * c + up[2] * sn];
          const ay = [up[0] * c - right[0] * sn, up[1] * c - right[1] * sn, up[2] * c - right[2] * sn];
          const center = [it.origin[0] + p.pos[0] * s, it.origin[1] + p.pos[1] * s, it.origin[2] + p.pos[2] * s];
          const corner = (sx, sy, u, v) => {
            this.data.set([center[0] + ax[0] * sx + ay[0] * sy, center[1] + ax[1] * sx + ay[1] * sy, center[2] + ax[2] * sx + ay[2] * sy, u, v, ...rgba], o);
            o += 9;
          };
          corner(-1, -1, 0, 1); corner(1, -1, 1, 1); corner(1, 1, 1, 0);
          corner(-1, -1, 0, 1); corner(1, 1, 1, 0); corner(-1, 1, 0, 0);
        }
        gl.bufferData(gl.ARRAY_BUFFER, this.data.subarray(0, o), gl.STREAM_DRAW);
        gl.drawArrays(gl.TRIANGLES, 0, o / 9);
      });
    }
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }
}
