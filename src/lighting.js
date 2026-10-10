// The original world lighting (world/lights/<Biome>Lights.xml): per time of day, an ambient
// colour plus sun, side and back directional lights, separately for terrain and for objects.
// Applied like Direct3D fixed-function lighting: ambient + sum(diffuse * intensity * N.L), clamped.

const SECTIONS = ['terrainLights', 'objectLights'];
const LIGHTS = ['sunlight', 'sidelight', 'backlight'];

const vec = (s) => (s ?? '0 0 0').trim().split(/\s+/).map(Number);

export function parseLights(xml) {
  const s = xml.replace(/\s+/g, ' ');
  const out = {};
  for (const section of SECTIONS) {
    const body = new RegExp(`<${section}>(.*?)</${section}>`).exec(s)?.[1];
    if (!body) continue;
    const tods = [...(/<tods>(.*?)<\/tods>/.exec(body)?.[1] ?? '').matchAll(/<(\w+) t="([\d.]+)" ambient="([^"]+)"/g)]
      .map((m) => ({ name: m[1], t: Number(m[2]), ambient: vec(m[3]) }));
    const lights = LIGHTS.map((name) => {
      const lb = new RegExp(`<${name}>(.*?)</${name}>`).exec(body)?.[1] ?? '';
      const keys = {};
      for (const m of lb.matchAll(/<(\w+) diffuse="([^"]+)"[^>]*direction="([^"]+)" intensity="([\d.]+)"/g)) {
        keys[m[1]] = { diffuse: vec(m[2]), direction: vec(m[3]), intensity: Number(m[4]) };
      }
      return keys;
    });
    out[section] = { tods, lights };
  }
  return out;
}

// Light values for a section at time of day t (0..1, 0.5 = midday), interpolated between keys.
export function lightsAt(parsed, section, t) {
  const sec = parsed?.[section];
  if (!sec || !sec.tods.length) return null;
  const tods = sec.tods;
  let i = tods.findIndex((k) => k.t > t);
  if (i <= 0) i = tods.length - 1;
  const a = tods[i - 1] ?? tods[0], b = tods[i] ?? tods[0];
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  const mix = (x, y) => x.map((v, k) => v + (y[k] - v) * f);
  const lights = sec.lights.map((keys) => {
    const ka = keys[a.name], kb = keys[b.name] ?? ka;
    if (!ka) return { color: [0, 0, 0], direction: [0, 0, -1] };
    const color = mix(ka.diffuse.map((c) => c * ka.intensity), kb.diffuse.map((c) => c * kb.intensity));
    const d = mix(ka.direction, kb.direction);
    const l = Math.hypot(...d) || 1;
    // Stored as the direction light travels; shaders want the direction towards the light.
    return { color, direction: d.map((v) => -v / l) };
  });
  return { ambient: mix(a.ambient, b.ambient), lights };
}

// Environment file of a map without a save to name it: guessed from the map's name.
export function guessEnvironment(mapName) {
  const prefixes = ['alpine', 'boreal', 'desert', 'grassland', 'savannah', 'scrub', 'temperate', 'tundra', 'wetland', 'rainforest',
    'coastal', 'pelagic', 'reef', 'benthic', 'city', 'polar', 'jungle', 'mangrove', 'river', 'rockies'];
  const envNames = { boreal: 'borealforest', temperate: 'temperateforest', wetland: 'wetlands', rainforest: 'tropicalrainforest',
    jungle: 'tropicalrainforest', mangrove: 'wetlands', polar: 'tundra', rockies: 'alpine', river: 'grassland', city: 'grassland' };
  const prefix = prefixes.find((p) => mapName.toLowerCase().startsWith(p)) ?? 'grassland';
  return `world/environments/env1${envNames[prefix] ?? prefix}.xml`;
}

// A map's world environment (world/environments/env1<biome>.xml): its lights, sky layers, fog
// and skirt models. Returns { lights, skyXml, fogXml, skirts: [path] }.
export async function loadEnvironment(fs, envPath) {
  const text = async (path) => (path && fs.has(path) ? new TextDecoder().decode(await fs.read(path)) : null);
  const env = (await text(envPath)) ?? '';
  const attr = (re) => re.exec(env)?.[1]?.replace(/\\/g, '/') ?? null;
  const lightsPath = attr(/lights="([^"]+)"/);
  const lights = parseLights((await text(lightsPath)) ?? (await text('world/lights/GrasslandLights.xml')));
  const skirtsTag = /<skirtModels([^>]*)>/.exec(env)?.[1] ?? '';
  return {
    lights,
    skyXml: await text(attr(/<skylayers\s+file="([^"]+)"/)),
    fogXml: await text(attr(/<fog\s+file="([^"]+)"/)),
    skirts: [...skirtsTag.matchAll(/skirt\d+="([^"]+)"/g)].map((m) => m[1].replace(/\\/g, '/')),
  };
}
