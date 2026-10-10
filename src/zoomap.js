// Starting zoo of a map: maps/<set>/<name>.zt2 is an XML save (BFContext) holding everything the
// map starts with: the front gate, the zoo wall, parking and entrance paths with their curbs,
// plants and rocks, plus the zoo status (money, fame, open/closed) and the camera.
//
// World coordinates are the terrain's (x, y in metres, z up). Fences (ZTFenceEntity) start at a
// tile corner and run one 3 m tile in direction (cos r, -sin r). Each path triangle is its own
// entity placed 0.75 m from its tile's centre towards the triangle's outer edge.

const attr = (s, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(s)?.[1];
const num = (s, name) => Number(attr(s, name));
const xyz = (s) => [num(s, 'x'), num(s, 'y'), num(s, 'z')];

export function parseZooMap(text) {
  const head = /<ZTMapData\b[^>]*>/.exec(text)?.[0] ?? '';
  const status = /<ZTStatus\b[^>]*>/.exec(text)?.[0] ?? '';
  const world = /<ZTWorldMgr\b[^>]*>/.exec(text)?.[0] ?? '';
  const camPos = /<camPos\b[^>]*>/.exec(text)?.[0];
  const cash = /<ZTEconomyComponent\b[^>]*category="generalEconomyComponent"[\s\S]*?<BFGEconomyData\b[^>]*>/.exec(text)?.[0];

  const map = {
    name: attr(head, 'name'),
    biome: attr(head, 'biome'),
    size: attr(head, 'size'),
    terrainFile: attr(world, 'terrFile'),
    environment: attr(world, 'environment'),
    zooOpen: attr(status, 'zoo_is_open') === 'true',
    fame: Number(attr(status, 'zoo_fame') ?? 0),
    halfStars: Number(attr(status, 'num_halfstars') ?? 0),
    cash: cash ? Number(attr(/<BFGEconomyData\b[^>]*>/.exec(cash)[0], 'cash')) : null,
    camera: camPos ? { pos: xyz(camPos), yaw: num(world, 'camYaw'), pitch: num(world, 'camPitch') } : null,
    entities: [], paths: [], fences: [],
  };

  for (const m of text.matchAll(/<ZTFenceEntity\b[^>]*>/g)) {
    const [x, y] = attr(m[0], 'position').split(/\s+/).map(Number);
    const r = num(m[0], 'rotation');
    const dx = Math.round(Math.cos(r)), dy = Math.round(-Math.sin(r));
    map.fences.push({ type: attr(m[0], 'ZTFenceType'), a: [x, y], b: [x + 3 * dx, y + 3 * dy], protected: attr(m[0], 'isProtected') === 'true' });
  }

  // Top-level entities: each <BFGEntity ...> up to the next one.
  const starts = [...text.matchAll(/<BFGEntity version=[^>]*>/g)];
  for (let i = 0; i < starts.length; i++) {
    const open = starts[i][0];
    const body = text.slice(starts[i].index + open.length, starts[i + 1]?.index ?? text.length);
    const type = /binderUniqueName="([^"/]+)\/BFBinderRoot"/.exec(open)?.[1];
    const phys = /<BFPhysObj\b[\s\S]*?<\/BFPhysObj>/.exec(body)?.[0];
    if (!type || !phys) continue;
    const pos = xyz(/<position\b[^>]*>/.exec(phys)[0]);
    const path = /<ZTPath\b[^>]*>/.exec(body)?.[0];
    if (path) {
      map.paths.push({ type, texture: attr(path, 'texture'), curb: attr(path, 'curb'), pos });
      continue;
    }
    const row0 = xyz(/<row0\b[^>]*>/.exec(phys)?.[0] ?? '<row0 x="1" y="0" z="0">');
    const yaw = Math.atan2(row0[1], row0[0]);
    const scale = Number(/\bscale="([^"]*)"/.exec(phys)?.[1] ?? 1);
    const variant = Number(attr(phys, 'Variant') ?? -1);
    map.entities.push({ type, pos, yaw, scale, variant, protected: attr(open, 'isProtected') === 'true', name: attr(body, 's_name') });
  }
  return map;
}

// Path triangle entity -> tile and direction bit (N=1 +y, E=2 +x, S=4 -y, W=8 -x).
export function pathTriangle(pos) {
  const tx = Math.floor(pos[0] / 3), ty = Math.floor(pos[1] / 3);
  const dx = pos[0] - (tx * 3 + 1.5), dy = pos[1] - (ty * 3 + 1.5);
  const bit = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 2 : 8) : (dy > 0 ? 1 : 4);
  return { tx, ty, bit };
}
