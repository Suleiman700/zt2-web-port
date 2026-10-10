// Biome definitions from Biomes/<name>.xml: ground/cover textures, brushes, draw order, water.

const attr = (s, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(s)?.[1] ?? null;

function brushes(s, tag) {
  const m = new RegExp(`<${tag}\\s([^>]*)/?>`).exec(s);
  if (!m) return null;
  return ['brush', 'brush1', 'brush2', 'brush3'].map((b) => attr(' ' + m[1], b));
}

export async function loadBiomes(fs) {
  const biomes = new Map();
  for (const path of fs.list((k) => /^biomes\/[^/]+\.xml$/.test(k))) {
    const s = new TextDecoder().decode(await fs.read(path)).replace(/^﻿/, '');
    const head = /<BFGBiome\s([^>]*)>/.exec(s)?.[1];
    if (!head) continue;
    const h = ' ' + head;
    const name = attr(h, 'name');
    const water = /<water\s([^>]*)>/.exec(s)?.[1];
    biomes.set(name.toLowerCase(), {
      name,
      ground: attr(h, 'groundTexture'),
      cover: attr(h, 'groundCoverTexture'),
      mixMask: attr(h, 'mixMask'),
      cliffs: ['cliffHoriz', 'cliffVert', 'cliffDiag1', 'cliffDiag2', 'cliffUnaligned'].map((k) => attr(h, k)),
      drawOrder: Number(attr(h, 'drawOrder') ?? 0),
      icon: attr(h, 'iconName'),
      groundBrushes: brushes(s, 'groundBrushes'),
      coverBrushes: brushes(s, 'groundCoverBrushes'),
      groundNoBlend: brushes(s, 'groundBrushesNoBlend'),
      coverNoBlend: brushes(s, 'groundCoverBrushesNoBlend'),
      water: water ? {
        shallowDepth: Number(attr(' ' + water, 'shallowDepth') ?? 1),
        deepDepth: Number(attr(' ' + water, 'deepDepth') ?? 6),
        vertexColorLow: (attr(' ' + water, 'vertexColorLow') ?? '200 230 240 150').split(/\s+/).map(Number),
        shore: attr(' ' + water, 'shoreTexture'),
        texture: /<texture name="([^"]+)"/.exec(s.slice(s.indexOf('<water')))?.[1] ?? null,
      } : null,
    });
  }
  return biomes;
}
