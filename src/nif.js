// Parser for NetImmerse/Gamebryo NIF files, version 10.0.1.0 (the only version Zoo Tycoon 2 uses).
// Field layouts follow the NifTools nif.xml specification for this version.
// This version stores no block sizes, so every block type that appears must be parsed exactly.
// If an unsupported block is hit, parsing stops and the blocks read so far are returned.

const td = new TextDecoder('latin1');

class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.p = 0;
  }
  u8() { return this.b[this.p++]; }
  bool() { return this.b[this.p++] !== 0; }
  u16() { const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
  i16() { const v = this.dv.getInt16(this.p, true); this.p += 2; return v; }
  u32() { const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  i32() { const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.p, true); this.p += 4; return v; }
  ref() { return this.i32(); }
  str() {
    const n = this.u32();
    if (n > 0x100000) throw new Error(`string length ${n} at ${this.p - 4}`);
    const s = td.decode(this.b.subarray(this.p, this.p + n));
    this.p += n;
    return s;
  }
  line() {
    let e = this.p;
    while (this.b[e] !== 0x0a) e++;
    const s = td.decode(this.b.subarray(this.p, e));
    this.p = e + 1;
    return s;
  }
  f32s(n) { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = this.f32(); return a; }
  u16s(n) { const a = new Uint16Array(n); for (let i = 0; i < n; i++) a[i] = this.u16(); return a; }
  refs(n) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = this.ref(); return a; }
  refList() { return this.refs(this.u32()); }
  vec3() { return [this.f32(), this.f32(), this.f32()]; }
  mat33() { return Array.from(this.f32s(9)); }
  skip(n) { this.p += n; }
}

// --- shared base layouts -------------------------------------------------------------

function objectNET(r, o) {
  o.name = r.str();
  o.extraData = r.refList();
  o.controller = r.ref();
}

function avObject(r, o) {
  objectNET(r, o);
  o.flags = r.u16();
  o.translation = r.vec3();
  o.rotation = r.mat33(); // row-major 3x3
  o.scale = r.f32();
  o.properties = r.refList();
  o.collisionData = r.ref();
}

function node(r, o) {
  avObject(r, o);
  o.children = r.refList();
  o.effects = r.refList();
}

function property(r, o) {
  objectNET(r, o);
  o.flags = r.u16();
}

function timeController(r, o) {
  o.nextController = r.ref();
  o.flags = r.u16();
  o.frequency = r.f32();
  o.phase = r.f32();
  o.startTime = r.f32();
  o.stopTime = r.f32();
  o.target = r.ref();
}

function geometry(r, o) {
  avObject(r, o);
  o.data = r.ref();
  o.skinInstance = r.ref();
  o.hasShader = r.bool();
  if (o.hasShader) { o.shaderName = r.str(); o.shaderUnknown = r.i32(); }
}

function geometryData(r, o) {
  const n = o.numVertices = r.u16();
  o.vertices = r.bool() ? r.f32s(n * 3) : null;
  o.dataFlags = r.u16();
  o.normals = r.bool() ? r.f32s(n * 3) : null;
  o.center = r.vec3();
  o.radius = r.f32();
  o.colors = r.bool() ? r.f32s(n * 4) : null;
  const uvSets = o.dataFlags & 63;
  o.uvSets = [];
  for (let i = 0; i < uvSets; i++) o.uvSets.push(r.f32s(n * 2));
  o.consistencyFlags = r.u16();
}

function texDesc(r) {
  return {
    source: r.ref(),
    clampMode: r.u32(),
    filterMode: r.u32(),
    uvSet: r.u32(),
    ps2L: r.i16(),
    ps2K: r.i16(),
  };
}

// Key groups used by animation data. `read` reads one value.
function keyGroup(r, read) {
  const num = r.u32();
  const g = { interpolation: 0, keys: [] };
  if (num === 0) return g;
  g.interpolation = r.u32();
  for (let i = 0; i < num; i++) {
    const k = { time: r.f32(), value: read(r) };
    if (g.interpolation === 2) { k.forward = read(r); k.backward = read(r); }
    else if (g.interpolation === 3) { k.tbc = r.vec3(); }
    g.keys.push(k);
  }
  return g;
}
const readFloat = (r) => r.f32();
const readVec3 = (r) => r.vec3();
const readColor4 = (r) => [r.f32(), r.f32(), r.f32(), r.f32()];
const readByte = (r) => r.u8();

// --- block parsers ---------------------------------------------------------------------

const extraData = (r, o) => { o.name = r.str(); };

function boundingVolume(r) {
  const type = r.u32();
  switch (type) {
    case 0: return { type: 'sphere', center: r.vec3(), radius: r.f32() };
    case 1: return { type: 'box', center: r.vec3(), axes: [r.vec3(), r.vec3(), r.vec3()], extents: r.vec3() };
    case 2: return { type: 'capsule', center: r.vec3(), axis: r.vec3(), extent: r.f32(), radius: r.f32() };
    case 4: { const n = r.u32(); const list = []; for (let i = 0; i < n; i++) list.push(boundingVolume(r)); return { type: 'union', list }; }
    case 5: return { type: 'halfspace', normal: r.vec3(), center: r.vec3() };
    default: throw new Error(`unknown bounding volume type ${type}`);
  }
}

// NiDynamicEffect adds no fields in this version.
function light(r, o) {
  avObject(r, o);
  o.dimmer = r.f32();
  o.ambient = r.vec3();
  o.diffuse = r.vec3();
  o.specular = r.vec3();
}

const PARSERS = {
  NiNode: node,
  NiBillboardNode: node,
  NiLODNode(r, o) {
    node(r, o);
    o.switchIndex = r.u32();
    o.lodCenter = r.vec3();
    const n = r.u32();
    o.lodLevels = [];
    for (let i = 0; i < n; i++) o.lodLevels.push({ near: r.f32(), far: r.f32() });
  },

  NiCollisionData(r, o) {
    o.target = r.ref();
    o.propagationMode = r.u32();
    o.useABV = r.u8();
    if (o.useABV) o.boundingVolume = boundingVolume(r);
  },
  NiAmbientLight: light,
  NiDirectionalLight: light,
  NiPointLight(r, o) { light(r, o); o.attenuation = r.vec3(); },
  NiTextureEffect(r, o) {
    avObject(r, o);
    o.projectionMatrix = r.mat33();
    o.projectionTranslation = r.vec3();
    o.filtering = r.u32();
    o.clamping = r.u32();
    o.textureType = r.u32();
    o.coordinateGeneration = r.u32();
    o.sourceTexture = r.ref();
    o.clippingPlane = r.u8();
    o.unknownVector = r.vec3();
    o.unknownFloat = r.f32();
    o.ps2L = r.i16();
    o.ps2K = r.i16();
  },

  NiTriShape: geometry,
  NiTriStrips: geometry,

  // Old-style particle systems (emoticons above animals, guests and staff).
  NiParticles: geometry,
  NiParticlesData(r, o) {
    geometryData(r, o);
    o.particleRadius = r.f32();
    o.numActive = r.u16();
    o.sizes = r.bool() ? r.f32s(o.numVertices) : null;
    o.rotations = r.bool() ? r.f32s(o.numVertices * 4) : null;
  },
  NiParticleSystemController(r, o) {
    timeController(r, o);
    o.speed = r.f32();
    o.speedRandom = r.f32();
    o.verticalDirection = r.f32();
    o.verticalAngle = r.f32();
    o.horizontalDirection = r.f32();
    o.horizontalAngle = r.f32();
    o.normal = r.vec3();
    o.color = [r.f32(), r.f32(), r.f32(), r.f32()];
    o.size = r.f32();
    o.emitStartTime = r.f32();
    o.emitStopTime = r.f32();
    o.unknownByte = r.u8();
    o.emitRate = r.f32();
    o.lifetime = r.f32();
    o.lifetimeRandom = r.f32();
    o.emitFlags = r.u16();
    o.startRandom = r.vec3();
    o.emitter = r.ref();
    o.unknownShort2 = r.u16();
    o.unknownFloat13 = r.f32();
    o.unknownInt1 = r.u32();
    o.unknownInt2 = r.u32();
    o.unknownShort3 = r.u16();
    const n = r.u16();
    o.numValid = r.u16();
    o.particles = [];
    for (let i = 0; i < n; i++) {
      o.particles.push({ velocity: r.vec3(), rotationAxis: r.vec3(), age: r.f32(), lifeSpan: r.f32(), lastUpdate: r.f32(), generation: r.u16(), code: r.u16() });
    }
    o.unknownLink = r.ref();
    o.particleExtra = r.ref(); // first NiParticleModifier
    o.unknownLink2 = r.ref();
    o.trailer = r.u8();
  },
  NiParticleRotation(r, o) {
    o.nextModifier = r.ref(); o.controller = r.ref();
    o.randomInitialAxis = r.u8();
    o.initialAxis = r.vec3();
    o.rotationSpeed = r.f32();
  },
  NiParticleGrowFade(r, o) { o.nextModifier = r.ref(); o.controller = r.ref(); o.grow = r.f32(); o.fade = r.f32(); },
  NiParticleColorModifier(r, o) { o.nextModifier = r.ref(); o.controller = r.ref(); o.colorData = r.ref(); },
  NiTriShapeData(r, o) {
    geometryData(r, o);
    o.numTriangles = r.u16();
    o.numTrianglePoints = r.u32();
    o.triangles = r.u16s(o.numTrianglePoints);
    const groups = r.u16();
    for (let i = 0; i < groups; i++) r.u16s(r.u16());
  },
  NiTriStripsData(r, o) {
    geometryData(r, o);
    o.numTriangles = r.u16();
    const lengths = r.u16s(r.u16());
    o.strips = Array.from(lengths, (len) => r.u16s(len));
  },

  NiZBufferProperty(r, o) { property(r, o); o.function = r.u32(); },
  NiVertexColorProperty(r, o) { property(r, o); o.vertexMode = r.u32(); o.lightingMode = r.u32(); },
  NiAlphaProperty(r, o) { property(r, o); o.threshold = r.u8(); },
  NiSpecularProperty: property,
  NiWireframeProperty: property,
  NiDitherProperty: property,
  NiShadeProperty: property,
  NiMaterialProperty(r, o) {
    property(r, o);
    o.ambient = r.vec3();
    o.diffuse = r.vec3();
    o.specular = r.vec3();
    o.emissive = r.vec3();
    o.glossiness = r.f32();
    o.alpha = r.f32();
  },
  NiStencilProperty(r, o) {
    property(r, o);
    o.enabled = r.u8();
    o.function = r.u32();
    o.ref = r.u32();
    o.mask = r.u32();
    o.failAction = r.u32();
    o.zFailAction = r.u32();
    o.passAction = r.u32();
    o.drawMode = r.u32(); // 0/1 = cull back faces, 2 = cull front, 3 = draw both
  },
  NiTexturingProperty(r, o) {
    property(r, o);
    o.applyMode = r.u32();
    o.textureCount = r.u32();
    const slot = () => (r.bool() ? texDesc(r) : null);
    o.base = slot();
    o.dark = slot();
    o.detail = slot();
    o.gloss = slot();
    o.glow = slot();
    o.bump = slot();
    if (o.bump) { o.bumpLumaScale = r.f32(); o.bumpLumaOffset = r.f32(); o.bumpMatrix = r.f32s(4); }
    o.decals = [];
    for (let i = 7; i <= o.textureCount; i++) o.decals.push(slot());
    const nShader = r.u32();
    o.shaderTextures = [];
    for (let i = 0; i < nShader; i++) {
      const t = slot();
      if (t) t.mapId = r.u32();
      o.shaderTextures.push(t);
    }
  },
  NiSourceTexture(r, o) {
    objectNET(r, o);
    o.useExternal = r.u8();
    if (o.useExternal) o.fileName = r.str();
    else { o.unknownByte = r.u8(); o.pixelData = r.ref(); }
    o.pixelLayout = r.u32();
    o.useMipmaps = r.u32();
    o.alphaFormat = r.u32();
    o.isStatic = r.u8();
  },

  NiStringExtraData(r, o) { extraData(r, o); o.value = r.str(); },
  NiIntegerExtraData(r, o) { extraData(r, o); o.value = r.u32(); },
  NiBooleanExtraData(r, o) { extraData(r, o); o.value = r.u8(); },
  NiTextKeyExtraData(r, o) {
    extraData(r, o);
    const n = r.u32();
    o.keys = [];
    for (let i = 0; i < n; i++) o.keys.push({ time: r.f32(), value: r.str() });
  },

  NiSkinInstance(r, o) {
    o.data = r.ref();
    o.skeletonRoot = r.ref();
    o.bones = r.refList();
  },
  NiSkinData(r, o) {
    o.rotation = r.mat33();
    o.translation = r.vec3();
    o.scale = r.f32();
    const numBones = r.u32();
    o.skinPartition = r.ref();
    o.hasVertexWeights = r.u8();
    o.bones = [];
    for (let i = 0; i < numBones; i++) {
      const b = { rotation: r.mat33(), translation: r.vec3(), scale: r.f32() };
      b.boundCenter = r.vec3();
      b.boundRadius = r.f32();
      const nv = r.u16();
      b.weights = [];
      if (o.hasVertexWeights) for (let j = 0; j < nv; j++) b.weights.push([r.u16(), r.f32()]);
      o.bones.push(b);
    }
  },
  NiSkinPartition(r, o) {
    const n = r.u32();
    o.partitions = [];
    for (let i = 0; i < n; i++) {
      const numVerts = r.u16(), numTris = r.u16(), numBones = r.u16(), numStrips = r.u16(), wpv = r.u16();
      const p = { numVerts, numTris, numBones, wpv };
      p.bones = r.u16s(numBones);
      p.vertexMap = r.u16s(numVerts);
      p.weights = r.f32s(numVerts * wpv);
      const lens = r.u16s(numStrips);
      if (numStrips) p.strips = Array.from(lens, (len) => r.u16s(len));
      else p.triangles = r.u16s(numTris * 3);
      p.hasBoneIndices = r.u8();
      if (p.hasBoneIndices) { p.boneIndices = r.b.slice(r.p, r.p + numVerts * wpv); r.skip(numVerts * wpv); }
      o.partitions.push(p);
    }
  },

  NiKeyframeController(r, o) { timeController(r, o); o.data = r.ref(); },
  NiAlphaController(r, o) { timeController(r, o); o.data = r.ref(); },
  NiVisController(r, o) { timeController(r, o); o.data = r.ref(); },
  NiUVController(r, o) { timeController(r, o); o.unknownShort = r.u16(); o.data = r.ref(); },
  NiMaterialColorController(r, o) { timeController(r, o); o.data = r.ref(); },
  NiBoneLODController(r, o) {
    timeController(r, o);
    o.unknownInt1 = r.u32();
    const numGroups = r.u32();
    o.unknownInt2 = r.u32();
    o.nodeGroups = [];
    for (let i = 0; i < numGroups; i++) o.nodeGroups.push(r.refList());
    o.shapeGroups = [];
    for (let i = r.u32(); i > 0; i--) {
      const pairs = [];
      for (let j = r.u32(); j > 0; j--) pairs.push({ shape: r.ref(), skinInstance: r.ref() });
      o.shapeGroups.push(pairs);
    }
    o.shapeGroups2 = r.refList();
  },
  NiKeyframeData(r, o) {
    const numRot = r.u32();
    o.rotationType = 0;
    o.rotationKeys = [];
    if (numRot > 0) {
      o.rotationType = r.u32();
      if (o.rotationType === 4) {
        r.f32(); // unknown float, present before 10.1.0.0
        o.xyzRotations = [keyGroup(r, readFloat), keyGroup(r, readFloat), keyGroup(r, readFloat)];
      } else {
        for (let i = 0; i < numRot; i++) {
          const k = { time: r.f32(), value: [r.f32(), r.f32(), r.f32(), r.f32()] }; // w, x, y, z
          if (o.rotationType === 3) k.tbc = r.vec3();
          o.rotationKeys.push(k);
        }
      }
    }
    o.translations = keyGroup(r, readVec3);
    o.scales = keyGroup(r, readFloat);
  },
  NiFloatData(r, o) { o.data = keyGroup(r, readFloat); },
  NiPosData(r, o) { o.data = keyGroup(r, readVec3); },
  NiColorData(r, o) { o.data = keyGroup(r, readColor4); },
  NiUVData(r, o) { o.groups = [0, 1, 2, 3].map(() => keyGroup(r, readFloat)); },
  NiVisData(r, o) {
    const n = r.u32();
    o.keys = [];
    for (let i = 0; i < n; i++) o.keys.push({ time: r.f32(), value: r.u8() });
  },
};

export const SUPPORTED_BLOCKS = new Set(Object.keys(PARSERS));

export function parseNif(bytes) {
  const r = new Reader(bytes);
  const header = r.line();
  if (!header.startsWith('NetImmerse File Format')) throw new Error('Not a NIF file');
  const version = r.u32();
  if (version !== 0x0a000100) throw new Error(`Unsupported NIF version 0x${version.toString(16)}`);
  const numBlocks = r.u32();
  const types = [];
  for (let i = r.u16(); i > 0; i--) types.push(r.str());
  const typeIndex = r.u16s(numBlocks);
  r.u32(); // unknown header int

  const blocks = [];
  let error = null;
  for (let i = 0; i < numBlocks; i++) {
    const type = types[typeIndex[i] & 0x7fff];
    const parser = PARSERS[type];
    if (!parser) { error = `Unsupported block ${type} (#${i})`; break; }
    const start = r.p;
    try {
      r.u32(); // per-block marker, always 0 in ZT2 files
      const o = { type, index: i, _start: start };
      parser(r, o);
      blocks.push(o);
    } catch (e) {
      error = `Failed in ${type} (#${i}) at offset ${start}: ${e.message}`;
      break;
    }
  }

  let roots = [];
  let complete = false;
  if (!error) {
    const numRoots = r.u32();
    roots = Array.from(r.refs(numRoots));
    complete = r.p === bytes.length;
    if (!complete) error = `Footer mismatch: ended at ${r.p}, file is ${bytes.length} bytes`;
  }
  return { types, typeIndex, numBlocks, blocks, roots: roots.length ? roots : [0], complete, error };
}
