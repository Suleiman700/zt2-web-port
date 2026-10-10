// Builds the placeable-object catalog from the game's entity definitions
// (entities/**/ai/*.xml) and English display names (lang/1033/*.xml).

const td = new TextDecoder('utf-8');
const text = (bytes) => td.decode(bytes).replace(/^﻿/, '');

// Top-level groups shown in the build menu, keyed by the entity's type path.
function groupFor(types) {
  const t = types.map((s) => s.toLowerCase());
  if (t.includes('animal')) return 'Animals';
  if (t.includes('fence') || t.includes('fences') || t.includes('barrier')) return 'Fences';
  if (t.includes('path') || t.includes('paths')) return 'Paths';
  if (t.includes('foliage') || t.includes('plant') || t.includes('tree')) return 'Plants';
  if (t.includes('rock') || t.includes('rocks')) return 'Rocks';
  if (t.includes('shelters')) return 'Animal care'; // animal shelters (caves, shade structures, burrows)
  if (t.includes('building') || t.includes('buildings') || t.includes('shelter') || t.includes('concession')) return 'Buildings';
  if (t.includes('enrichment') || t.includes('food') || t.includes('toy')) return 'Animal care';
  if (t.includes('scenery') || t.includes('fountain') || t.includes('bench')) return 'Scenery';
  return null; // staff, guests, effects and internal objects are not placeable from this menu
}

export async function buildCatalog(fs, onProgress) {
  // Display names.
  const names = new Map();
  for (const p of fs.list((k) => k.startsWith('lang/1033/') && k.endsWith('.xml'))) {
    const s = text(await fs.read(p));
    for (const m of s.matchAll(/_locID="entityname:([^"]+)"\s*>([^<]+)<\/LOC_STRING>/g)) {
      names.set(m[1].toLowerCase(), m[2].trim());
    }
  }

  // Entity definitions.
  const defs = new Map();
  const paths = fs.list((k) => k.startsWith('entities/') && k.includes('/ai/') && k.endsWith('.xml'));
  for (let i = 0; i < paths.length; i++) {
    if (onProgress && i % 200 === 0) onProgress(i, paths.length);
    const s = text(await fs.read(paths[i]));
    const id = /<BFTypedBinder[^>]*binderType="([^"]+)"/.exec(s)?.[1];
    if (!id) continue;
    const typesBlock = /<types>([\s\S]*?)<\/types>/.exec(s)?.[1] ?? '';
    const types = [...typesBlock.matchAll(/<(\w+)\s*\/?>/g)].map((m) => m[1]);
    defs.set(id.toLowerCase(), {
      id,
      file: paths[i],
      // Display-name key from the entity's help info, e.g. ids="entityname:desert" for desertpath_et.
      nameKey: /ids="entityname:([^"]+)"/.exec(s)?.[1]?.toLowerCase() ?? null,
      abstract: /<BFTypedBinder[^>]*abstract="true"/.test(s),
      types,
      // The build-menu icon lives in the "adopt" (or "fence") toggle button; other UIAspects are map icons.
      icon: /<UIToggleButton template="(?:adopt|fence)">\s*<UIAspect>\s*<default image="([^"]+)"/.exec(s)?.[1] ?? null,
      // Fences: piece models per named binder (posts at tile corners, straight and diagonal segments).
      fenceParts: {
        post: binderModel(s, 'start_post'),
        straight: binderModel(s, 'fence90'),
        diagonal: binderModel(s, 'fence45'),
      },
      gate: /<ZTFence[^>]*\sgate="([^"]+)"/.exec(s)?.[1] ?? null,
      // Gates: the animated door (actor with Bip01_open / Bip01_close animations).
      gateActor: binderModel(s, 'gate_animation', 'actorfile'),
      // Paths: ground texture and the curb (a fence-like edge) placed along their borders.
      pathTexture: /<ZTPath[^>]*\stexture="([^"]+)"/.exec(s)?.[1] ?? null,
      pathCurb: /<ZTPath[^>]*\scurb="([^"]+)"/.exec(s)?.[1] ?? null,
      pathIcon: /<UIToggleButton template="path">\s*<UIAspect>\s*<default image="([^"]+)"/.exec(s)?.[1] ?? null,
      fenceHeight: Number(/f_Height="([\d.]+)"/.exec(s)?.[1] ?? NaN),
      placement: parsePlacement(s),
      theme: /s_Theme="([^"]+)"/.exec(s)?.[1] ?? null,
      parts: parseParts(s),
      partStates: parsePartStates(s),
      fadeStates: parseFadeStates(s),
      model: /(?:modelfile|actorfile)="([^"]+)"/i.exec(s)?.[1] ?? null,
      scale: Number(/<(?:BFActorComponent|BFSceneGraphComponent|BFSimpleLODComponent)[^>]*\sscale="([\d.]+)"/.exec(s)?.[1] ?? NaN),
      cost: Number(/<ZTEconomyComponent[^>]*\scost="([\d.]+)"/.exec(s)?.[1] ?? NaN),
      // Recycling refund when removed, as a percentage of the price ("destroy" credit, costType %parent).
      refund: Number(/<ZTTransaction name="destroy" cost="([\d.]+)" costType="%parent"/.exec(s)?.[1] ?? NaN),
      upkeep: Number(/<ZTTransaction name="upkeep" cost="([\d.]+)" period="monthly"/.exec(s)?.[1] ?? NaN),
    });
  }

  // Entities inherit missing fields from the binders named by their type path
  // (e.g. FoxFennec_Adult_M <- FoxFennec_Adult <- FoxFennec).
  const inherit = (d, field, valid) => {
    if (valid(d[field])) return d[field];
    for (let i = d.types.length - 2; i >= 0; i--) {
      const parent = defs.get(d.types[i].toLowerCase());
      if (parent && valid(parent[field])) return parent[field];
    }
    return d[field];
  };
  // Placement rules merge along the type chain: parents first, the entity's own values last.
  const mergedPlacement = (d) => {
    const chain = d.types.slice(0, -1).map((t) => defs.get(t.toLowerCase())).filter(Boolean);
    const out = { attrs: {}, cfootprint: null, dfootprint: null, stomp: {} };
    for (const p of [...chain.map((c) => c.placement), d.placement]) {
      if (!p) continue;
      Object.assign(out.attrs, p.attrs);
      if (p.cfootprint) out.cfootprint = p.cfootprint;
      if (p.dfootprint) out.dfootprint = p.dfootprint;
      for (const [type, action] of Object.entries(p.stomp)) out.stomp[type] = action;
    }
    return out;
  };
  for (const d of defs.values()) d.mergedPlacement = mergedPlacement(d);
  for (const d of defs.values()) d.theme = inherit(d, 'theme', Boolean);
  // Model parts merge the same way (by binder name; the entity's own definition wins).
  for (const d of defs.values()) {
    const chain = d.types.slice(0, -1).map((t) => defs.get(t.toLowerCase())).filter(Boolean);
    const merged = new Map();
    for (const p of [...chain.map((c) => c.parts), d.parts]) for (const part of p) merged.set(part.name.toLowerCase(), { ...merged.get(part.name.toLowerCase()), ...part });
    d.mergedParts = [...merged.values()];
  }
  for (const d of defs.values()) {
    for (const part of ['post', 'straight', 'diagonal']) {
      d.fenceParts[part] = inherit({ types: d.types, v: d.fenceParts[part] }, 'v', Boolean)
        ?? d.types.slice(0, -1).reverse().map((t) => defs.get(t.toLowerCase())?.fenceParts[part]).find(Boolean) ?? null;
    }
    d.icon = inherit(d, 'icon', Boolean);
    // The object's own model is its mainObj part; other model files in the XML belong to parts
    // (e.g. the gift shop's sign comes before the building).
    d.model = d.mergedParts.find((p) => p.name.toLowerCase() === 'mainobj' && p.file)?.file ?? inherit(d, 'model', Boolean);
    d.scale = inherit(d, 'scale', (v) => !Number.isNaN(v));
    d.cost = inherit(d, 'cost', (v) => !Number.isNaN(v));
    d.refund = inherit(d, 'refund', (v) => !Number.isNaN(v));
    d.partStates = inherit(d, 'partStates', Boolean);
    d.fadeStates = inherit(d, 'fadeStates', Boolean);
    d.upkeep = inherit(d, 'upkeep', (v) => !Number.isNaN(v));
  }

  // Model paths may omit the extension (BFR models): prefer the .bfb, else the .nif.
  const resolveModel = (path) => {
    if (!path) return null;
    const p = /\.(nif|bfm|bfb)$/i.test(path) ? path : (fs.has(`${path}.bfb`) ? `${path}.bfb` : `${path}.nif`);
    return fs.has(p) ? p : null;
  };

  const displayName = (d) => names.get(d.nameKey) ?? names.get(d.id.toLowerCase()) ?? splitCamel(d.id);

  const items = [];
  for (const d of defs.values()) {
    if (d.abstract) continue;
    const lower = d.types.map((t) => t.toLowerCase());
    // Paths have no model: a ground texture plus curbs along their edges.
    if (lower.includes('path') && d.pathTexture && fs.has(d.pathTexture)) {
      if (/_broken$/i.test(d.id)) continue;
      items.push({
        id: d.id, name: displayName(d), group: 'Paths', types: d.types,
        icon: d.pathIcon ?? d.icon, model: null, actor: null, scale: 1, cost: Number.isNaN(d.cost) ? 0 : d.cost, isAnimal: false,
        path: { texture: d.pathTexture, curb: d.pathCurb },
      });
      continue;
    }
    // Curbs are fence-like pieces the path tool places; they have no menu icon.
    if (lower.includes('curb')) {
      const parts = { post: resolveModel(d.fenceParts.post), straight: resolveModel(d.fenceParts.straight), diagonal: resolveModel(d.fenceParts.diagonal) };
      if (parts.straight && !/_broken$/i.test(d.id)) {
        items.push({
          id: d.id, name: d.id, group: 'Curbs', hidden: true, types: d.types, icon: null, model: parts.straight, actor: null,
          scale: 1, cost: 0, isAnimal: false, fence: { ...parts, gate: null, height: 0.2 },
        });
      }
      continue;
    }
    // Broken fences (what a fence becomes when an animal smashes it): hidden, not buildable.
    if (lower.includes('fence') && /_broken$/i.test(d.id)) {
      const parts = { post: resolveModel(d.fenceParts.post), straight: resolveModel(d.fenceParts.straight), diagonal: resolveModel(d.fenceParts.diagonal) };
      if (parts.straight) {
        items.push({
          id: d.id, name: displayName(d), group: 'Fences', hidden: true, broken: true, types: d.types, icon: null,
          model: parts.straight, actor: null, scale: 1, cost: 0, isAnimal: false,
          fence: { ...parts, gate: null, height: Number.isNaN(d.fenceHeight) ? 2 : d.fenceHeight },
        });
      }
      continue;
    }
    if (!d.model || !d.icon) continue;
    const group = groupFor(d.types);
    if (!group) continue;
    if (group === 'Fences') {
      if (/_broken$/i.test(d.id)) continue;
      // Gates replace a fence segment (the Gate tool), so they are kept but hidden from the menu.
      if (d.types.map((t) => t.toLowerCase()).includes('gate')) {
        const parts = { post: resolveModel(d.fenceParts.post), straight: resolveModel(d.fenceParts.straight), diagonal: resolveModel(d.fenceParts.diagonal) };
        if (!parts.straight || !d.gateActor || !fs.has(d.gateActor)) continue;
        items.push({
          id: d.id, name: displayName(d), group: 'Gates', hidden: true, types: d.types,
          icon: d.icon, model: parts.straight, actor: null, scale: 1, cost: Number.isNaN(d.cost) ? 0 : d.cost, isAnimal: false,
          fence: { ...parts, gate: null, height: 2 }, gateActor: d.gateActor,
        });
        continue;
      }
      const parts = { post: resolveModel(d.fenceParts.post), straight: resolveModel(d.fenceParts.straight), diagonal: resolveModel(d.fenceParts.diagonal) };
      if (!parts.straight) continue;
      items.push({
        id: d.id, name: displayName(d), group, types: d.types, icon: d.icon, hidden: lower.includes('zooboundary') || undefined,
        model: parts.straight, actor: null, scale: 1, cost: Number.isNaN(d.cost) ? 0 : d.cost, isAnimal: false,
        fence: { ...parts, gate: d.gate, height: Number.isNaN(d.fenceHeight) ? 2 : d.fenceHeight },
      });
      continue;
    }
    let model = d.model;
    let actor = null; // .bfm actor file: model plus its animation list
    // Expansion foliage names its model without an extension: prefer the .bfb, else the .nif.
    if (!/\.(nif|bfm|bfb)$/i.test(model)) model += fs.has(`${model}.bfb`) ? '.bfb' : '.nif';
    if (/\.bfm$/i.test(model)) {
      if (!fs.has(model)) continue;
      actor = model;
      model = /modelname="([^"]+)"/.exec(text(await fs.read(model)))?.[1] ?? null;
    }
    // Some entities name a .nif that only ships as .bfb (or the other way round).
    if (model && !fs.has(model)) model = [model.replace(/\.nif$/i, '.bfb'), model.replace(/\.bfb$/i, '.nif')].find((p) => fs.has(p)) ?? model;
    if (!model || !fs.has(model)) continue;
    items.push({
      id: d.id,
      name: displayName(d),
      // The front gate comes with the map; it is not in the build menu.
      hidden: lower.includes('entrance') || undefined,
      group,
      types: d.types,
      icon: d.icon,
      model,
      actor,
      scale: Number.isNaN(d.scale) ? 1 : d.scale,
      cost: Number.isNaN(d.cost) ? 0 : d.cost,
      isAnimal: group === 'Animals',
      placement: placementRules(d.mergedPlacement),
      theme: d.theme,
      // Extra model parts attached to the main object (vendors, signs, ...).
      parts: d.mergedParts
        // Linked parts, plus fade-state parts (shown by food level) that sit on the main model.
        .filter((p) => p.file && p.name.toLowerCase() !== 'mainobj' && (p.parent || d.fadeStates?.states.some((f) => f.part === p.name.toLowerCase())))
        .map((p) => ({ ...p, file: /\.bfm$/i.test(p.file) ? (fs.has(p.file) ? p.file : null) : resolveModel(p.file) }))
        .filter((p) => p.file),
      partStates: d.partStates,
      fadeStates: d.fadeStates,
    });
  }
  // Economy: removal refund (fraction of the price; 80% for most objects, none for animals, which
  // have no "destroy" credit) and monthly upkeep.
  for (const item of items) {
    const d = defs.get(item.id.toLowerCase());
    item.refund = Number.isNaN(d?.refund ?? NaN) ? 0 : d.refund / 100;
    item.upkeep = Number.isNaN(d?.upkeep ?? NaN) ? 0 : d.upkeep;
  }
  // One build-menu entry per animal species (types: ... Species / Species_Adult / Species_Adult_M);
  // placing it picks a random adult of either sex, like adopting in the game.
  const out = [];
  const species = new Map();
  const seen = new Set();
  for (const item of items) {
    if (item.isAnimal) {
      const sp = item.types.at(-3);
      if (!/_adult_[mf]$/i.test(item.id) || !sp) continue;
      if (!species.has(sp)) {
        const entry = { ...item, id: sp, name: names.get(sp.toLowerCase()) ?? splitCamel(sp), variants: [] };
        species.set(sp, entry);
        out.push(entry);
      }
      species.get(sp).variants.push({ id: item.id, model: item.model, actor: item.actor, scale: item.scale });
      continue;
    }
    const key = `${item.name}|${item.model}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  // Theme versions share a name in the original (e.g. five "Cheesecake Cart"s); tell them apart.
  const THEMES = { default: 'Classic', safari: 'Safari', jungle: 'Jungle', desert: 'Desert', extinct: 'Extinct', endangered: 'Endangered' };
  const counts = new Map();
  for (const i of out) counts.set(`${i.group}|${i.name}`, (counts.get(`${i.group}|${i.name}`) ?? 0) + 1);
  for (const i of out) {
    if (counts.get(`${i.group}|${i.name}`) > 1 && i.theme) i.name = `${i.name} (${THEMES[i.theme.toLowerCase()] ?? i.theme})`;
  }
  out.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  // Entity type -> its file, for the AI data: many files are not named after their type
  // (Playground_BouncyRide_Lion_df.xml holds Lion_df).
  out.typeFiles = new Map([...defs].map(([k, d]) => [k, d.file]));
  return out;
}

// "GazelleThomsons" -> "Gazelle Thomsons"
// ZTPlacementData: attributes, footprints (metres) and stompData (what happens to other
// entity types under the object: delete, prevent placement, or allow).
function parsePlacement(s) {
  const m = /<ZTPlacementData([^>]*?)(\/>|>([\s\S]*?)<\/ZTPlacementData>)/.exec(s);
  if (!m) return null;
  const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
  const body = m[3] ?? '';
  const footprint = (tag) => {
    const f = new RegExp(`<${tag}\\s+width="([\\d.]+)"\\s+height="([\\d.]+)"`).exec(body);
    return f ? [Number(f[1]), Number(f[2])] : null;
  };
  const stomp = {};
  const stompBody = /<stompData>([\s\S]*?)<\/stompData>/.exec(body)?.[1] ?? '';
  for (const action of ['delete', 'prevent', 'allow']) {
    const inner = new RegExp(`<${action}>([\\s\\S]*?)</${action}>`).exec(stompBody)?.[1] ?? '';
    for (const t of inner.matchAll(/<(\w+)\s*\/>/g)) stomp[t[1].toLowerCase()] = action;
  }
  return { attrs, cfootprint: footprint('cfootprint'), dfootprint: footprint('dfootprint'), stomp };
}

const truthy = (v) => v === 'true' || v === '1' || v === 'yes';

// The rules the sandbox applies (see sandbox placement): booleans default as in the original.
function placementRules(p) {
  const a = p.attrs;
  return {
    gridSnap: truthy(a.gridSnap),
    autoFootprint: a.autoFootprint === undefined ? !p.cfootprint : truthy(a.autoFootprint),
    cfootprint: p.cfootprint,
    dfootprint: p.dfootprint ?? p.cfootprint,
    terrainFlatten: truthy(a.terrainFlatten),
    randomRotate: truthy(a.randomRotate),
    waterPlacement: truthy(a.waterPlacement),
    landPlacement: a.landPlacement === undefined ? true : truthy(a.landPlacement),
    minimumDepth: a.minimumDepth ? Number(a.minimumDepth) : 0,
    // Grid-snapped objects may not cover paths unless their stompData allows paths.
    blockedByPaths: truthy(a.gridSnap) && p.stomp.path !== 'allow' && p.stomp.entity !== 'allow',
  };
}

// Model parts: every named binder with a model or actor, plus where it attaches
// (<physObjParenting><parentObj parent child attachnode postype rottype/>).
function parseParts(s) {
  const parenting = new Map();
  for (const m of s.matchAll(/<parentObj\s([^>]*)\/>/g)) {
    const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    if (a.child) parenting.set(a.child.toLowerCase(), a);
  }
  const parts = [];
  for (const m of s.matchAll(/<BFNamedBinder[^>]*binderName="([^"]+)"[^>]*>([\s\S]*?)<\/BFNamedBinder>/g)) {
    const file = /<(?:BFSceneGraphComponent|BFSimpleLODComponent|BFActorComponent)[^>]*(?:modelfile|actorfile)="([^"]+)"/i.exec(m[2])?.[1];
    const link = parenting.get(m[1].toLowerCase());
    if (!file && !link) continue;
    const part = { name: m[1] };
    if (file) part.file = file;
    if (link) Object.assign(part, { parent: link.parent, attachNode: link.attachnode ?? null, posType: link.postype ?? 'use', rotType: link.rottype ?? 'use' });
    parts.push(part);
  }
  // Attachments declared here for parts whose model a more specific entity supplies
  // (e.g. the Umbrella of snack carts: linked in snackcart_cheesecake, modelled in each theme).
  for (const [child, link] of parenting) {
    if (parts.some((p) => p.name.toLowerCase() === child)) continue;
    parts.push({ name: link.child, parent: link.parent, attachNode: link.attachnode ?? null, posType: link.postype ?? 'use', rotType: link.rottype ?? 'use' });
  }
  return parts;
}

// Parts that stand for states of the object (BFGPhysAnimController): only the current state's part
// is shown, e.g. a shop's idle/used sign, or a bat cave's bats that come out every 45-60 seconds.
// Returns { defaultState, states: [{ name, child, minPeriod, maxPeriod }] } or null.
function parsePartStates(s) {
  const m = /<BFGPhysAnimController\b([^>]*)>\s*<stateList>([\s\S]*?)<\/stateList>/.exec(s);
  if (!m) return null;
  const states = [...m[2].matchAll(/<(\w+)\s([^>]*?)\/>/g)].map((x) => {
    const a = Object.fromEntries([...x[2].matchAll(/(\w+)="([^"]*)"/g)].map((y) => [y[1], y[2]]));
    return { name: x[1], child: a.child ?? null, minPeriod: Number(a.minPeriod ?? NaN), maxPeriod: Number(a.maxPeriod ?? NaN) };
  });
  return { defaultState: /defaultState="([^"]+)"/.exec(m[1])?.[1] ?? states[0]?.name, states };
}

// Parts shown by the value of an attribute (BFAIFadeController), e.g. a carcass or food pile:
// full / twothird / onethird / empty by f_FoodLevel. Returns { attr, states: [{ part, min, max }] }.
function parseFadeStates(s) {
  const m = /<BFAIFadeController\b([^>]*)>\s*<stateList>([\s\S]*?)<\/stateList>/.exec(s);
  if (!m) return null;
  const states = [...m[2].matchAll(/<(\w+)\s([^>]*?)\/>/g)].map((x) => {
    const a = Object.fromEntries([...x[2].matchAll(/(\w+)="([^"]*)"/g)].map((y) => [y[1], y[2]]));
    return { part: (a.physObj ?? x[1]).toLowerCase(), min: Number(a.minRange ?? -Infinity), max: Number(a.maxRange ?? Infinity) };
  });
  return { attr: /attribName="([^"]+)"/.exec(m[1])?.[1] ?? 'f_FoodLevel', states };
}

// Model file of a named sub-binder, e.g. <BFNamedBinder binderName="fence90"> ... modelfile="...".
function binderModel(s, name, attribute = 'modelfile') {
  const at = s.indexOf(`binderName="${name}"`);
  if (at < 0) return null;
  const end = s.indexOf('</BFNamedBinder>', at);
  return new RegExp(`${attribute}="([^"]+)"`, 'i').exec(s.slice(at, end < 0 ? undefined : end))?.[1] ?? null;
}

function splitCamel(s) { return s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' '); }
