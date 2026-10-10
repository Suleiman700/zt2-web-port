// Loads game files: opening archives (picked by the player, or from orgfiles/ in local mode),
// and cached GPU models, textures and UI icons.
import { ZipArchive, GameFS, normalizePath } from './zip.js';
import { parseNif } from './nif.js';
import { decodeDDS } from './dds.js';
import { buildModel } from './model.js';
import { parseBF } from './bf.js';
import { isBFB, parseBFB, buildBFBModel, parseBFMat, parseEffectStates } from './bfb.js';
import { GAME_FILES_MODE, LOCAL_GAME_FILES_PATH } from './config.js';

// True when this build loads the original files from the project's orgfiles/ folder.
export const usesLocalGameFiles = () => GAME_FILES_MODE === 'local';

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Inflates as much of a (possibly truncated) raw deflate stream as it can.
async function inflateRawPartial(bytes) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const parts = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.length;
    }
  } catch { /* the input was cut short on purpose */ }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function fileSource(file) {
  return {
    size: file.size,
    read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
  };
}

function httpSource(url, size) {
  return {
    size,
    read: async (offset, length) => {
      const res = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

// Opens archives from <input type=file> Files (production), or from orgfiles/ (local mode).
export async function openGameFS(files, onStatus = () => {}) {
  let archives;
  if (files) {
    archives = [...files].filter((f) => f.name.toLowerCase().endsWith('.z2f')).map((f) => ({ name: f.name, source: fileSource(f) }));
  } else {
    const res = await fetch(LOCAL_GAME_FILES_PATH, { cache: 'no-store' });
    const names = res.ok ? await res.json() : [];
    if (!names.length) throw new Error(`No game files found in ${LOCAL_GAME_FILES_PATH} (copy the .z2f files there)`);
    archives = [];
    for (const name of names) {
      const url = `${LOCAL_GAME_FILES_PATH}${name}`;
      const head = await fetch(url, { method: 'HEAD' });
      archives.push({ name, source: httpSource(url, Number(head.headers.get('Content-Length'))) });
    }
  }
  // Load in name order so expansion archives (higher numbers) override the base game.
  archives.sort((a, b) => a.name.localeCompare(b.name));
  const fs = new GameFS();
  fs.inflatePartial = inflateRawPartial;
  for (const a of archives) {
    onStatus(`Reading ${a.name}…`);
    fs.add(await ZipArchive.open(a.name, a.source, inflateRaw));
  }
  return fs;
}

export class Assets {
  constructor(fs, renderer) {
    this.fs = fs;
    this.renderer = renderer;
    this.models = new Map();   // path -> Promise<{ gpu, nif, model }>
    this.textures = new Map(); // resolved path + wrap -> Promise<WebGLTexture|null>
    this.icons = new Map();    // path -> Promise<dataURL|null>
    this.actors = new Map();   // .bfm path -> Promise<Map(animName lowercase -> .bf path)>
    this.animations = new Map(); // .bf path -> Promise<parsed animation|null>
    this.textureByBasename = new Map();
    for (const p of fs.list((k) => k.endsWith('.dds') || k.endsWith('.tga'))) {
      const base = basename(p);
      // Prefer full-resolution textures over the "low" detail copies.
      if (!this.textureByBasename.has(base) || this.textureByBasename.get(base).includes('/low/')) {
        this.textureByBasename.set(base, normalizePath(p));
      }
    }
  }

  model(path) {
    const key = normalizePath(path);
    if (!this.models.has(key)) this.models.set(key, this._loadModel(key));
    return this.models.get(key);
  }

  async _loadModel(path) {
    const bytes = await this.fs.read(path);
    const dir = path.split('/').slice(0, -1).join('/');
    let nif, model;
    if (isBFB(bytes)) {
      const doc = parseBFB(bytes);
      model = buildBFBModel(doc, await this._bfbMaterials(dir, doc));
      nif = { complete: true, error: null, format: 'bfb' };
    } else {
      nif = parseNif(bytes);
      model = buildModel(nif);
    }
    // Textures load in parallel: each sequential wait would cost at least a frame.
    const textures = new Map();
    const missing = [];
    const pending = new Map();
    for (const mesh of model.meshes) {
      if (!mesh.texture || pending.has(mesh.texture)) continue;
      const resolved = this.resolveTexture(dir, mesh.texture);
      pending.set(mesh.texture, resolved ? this.texture(resolved, mesh.textureWrap) : null);
    }
    for (const [name, promise] of pending) {
      const tex = await promise;
      if (!tex) missing.push(name);
      textures.set(name, tex);
    }
    return { gpu: this.renderer.uploadModel(model, textures), nif, model, missing };
  }

  // Default render states of an effect (effects/<name>.fx), cached.
  effectStates(name) {
    if (!name) return {};
    const key = name.toLowerCase();
    this.effects ??= new Map();
    if (!this.effects.has(key)) {
      const path = `effects/${key}.fx`;
      this.effects.set(key, this.fs.has(path) ? this.fs.read(path).then((b) => parseEffectStates(new TextDecoder().decode(b))).catch(() => ({})) : Promise.resolve({}));
    }
    return this.effects.get(key);
  }

  // Loads <model dir>/Materials/<name>.bfmat for every material the BFB references.
  async _bfbMaterials(dir, doc) {
    const names = [...new Set(doc.hierarchy.flatMap((n) => n.materials).filter(Boolean).map((n) => n.toLowerCase()))];
    const loaded = await Promise.all(names.map(async (name) => {
      const path = `${dir}/materials/${/\.bfmat$/i.test(name) ? name : `${name}.bfmat`}`;
      if (!this.fs.has(path)) return null;
      const text = new TextDecoder().decode(await this.fs.read(path));
      const mat = parseBFMat(text, await this.effectStates(/<material[^>]*\sfx="([^"]+)"/.exec(text)?.[1]));
      if (mat.texture && !/\.\w+$/.test(mat.texture)) mat.texture += '.dds';
      return mat;
    }));
    return new Map(names.map((name, i) => [name, loaded[i]]));
  }

  texture(path, wrap = true) {
    const key = `${normalizePath(path)}|${wrap}`;
    if (!this.textures.has(key)) {
      this.textures.set(key, this.fs.read(path)
        .then((bytes) => this.renderer.createTexture(decodeDDS(bytes, true), wrap))
        .catch((err) => { console.warn(`Texture ${path}: ${err.message}`); return null; }));
    }
    return this.textures.get(key);
  }

  resolveTexture(dir, name) {
    const clean = normalizePath(name);
    for (const candidate of [`${dir}/${clean}`, `${dir}/${basename(clean)}`]) if (this.fs.has(candidate)) return candidate;
    return this.textureByBasename.get(basename(clean)) ?? null;
  }

  // Animation list of an actor (.bfm): animName -> .bf path.
  actor(path) {
    const key = normalizePath(path);
    if (!this.actors.has(key)) {
      this.actors.set(key, this.fs.read(key).then((bytes) => {
        const s = new TextDecoder().decode(bytes);
        const anims = new Map();
        for (const m of s.matchAll(/anim="([^"]+)"\s+animName="([^"]+)"/g)) anims.set(m[2].toLowerCase(), m[1]);
        return anims;
      }).catch(() => new Map()));
    }
    return this.actors.get(key);
  }

  animation(path) {
    const key = normalizePath(path);
    if (!this.animations.has(key)) {
      this.animations.set(key, this.fs.read(key).then(parseBF).catch((err) => { console.warn(`Animation ${path}: ${err.message}`); return null; }));
    }
    return this.animations.get(key);
  }

  // One sprite of a UI image sheet (a layout's BFRect, in pixels) as a data URL.
  sprite(path, x, y, w, h) {
    const key = `${normalizePath(path)}|${x},${y},${w},${h}`;
    if (!this.icons.has(key)) {
      this.icons.set(key, this.fs.read(path).then((bytes) => {
        const img = decodeDDS(bytes);
        const full = document.createElement('canvas');
        full.width = img.width;
        full.height = img.height;
        full.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer), img.width, img.height), 0, 0);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(full, x, y, w, h, 0, 0, w, h);
        return canvas.toDataURL();
      }).catch(() => null));
    }
    return this.icons.get(key);
  }

  // Decodes a DDS icon into a data URL for use in <img>. Build-menu icons are 2x2 sprite
  // sheets (normal, highlighted, pressed, disabled); only their first frame is used.
  icon(path, sheet = true) {
    const key = `${normalizePath(path)}|${sheet}`;
    if (!this.icons.has(key)) {
      this.icons.set(key, this.fs.read(path).then((bytes) => {
        const img = decodeDDS(bytes);
        const full = document.createElement('canvas');
        full.width = img.width;
        full.height = img.height;
        full.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer), img.width, img.height), 0, 0);
        const canvas = document.createElement('canvas');
        canvas.width = sheet ? img.width / 2 : img.width;
        canvas.height = sheet ? img.height / 2 : img.height;
        canvas.getContext('2d').drawImage(full, 0, 0);
        return canvas.toDataURL();
      }).catch(() => null));
    }
    return this.icons.get(key);
  }
}

export function basename(p) { return p.toLowerCase().replace(/\\/g, '/').split('/').at(-1); }
