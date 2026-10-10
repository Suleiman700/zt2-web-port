// Zoo guests (Phase 5): who they are and how they arrive.
//  - Guest types come from entities/units/guests/ai/*.xml: the body actor (BFActorComponent of
//    mainObj), the head model (headObj, attached to the body's Link_Head node) and the clothes,
//    skin and hair textures picked at random per guest (BFSharedRandomTextureInfo: one weighted
//    group from each replacement set). Variants inherit what they leave out from the types above
//    them (Guest_Young_M_01 takes its body from Guest_Young_M).
//  - Arrivals follow AI/guestMgr.xml: at most MaxGuestsBase + MaxGuestsPerStar per fame star,
//    a try every MinDelaySecs..MaxDelaySecs while the zoo is open, at the front gate.
import { parseXml } from './xml.js';

const kids = (el, name) => (el?.children ?? []).filter((c) => c.name === name);
const kid = (el, name) => kids(el, name)[0] ?? null;
const findAll = (el, name, out = []) => { for (const c of el?.children ?? []) { if (c.name === name) out.push(c); findAll(c, name, out); } return out; };
const path = (p) => (p ? p.replace(/\\/g, '/') : null);

// The deepest chain of names under <types> (entity, actor, people, Guest, Guest_Adult, ...).
function typeChain(types) {
  const chain = [];
  for (let el = types; el?.children?.length; el = el.children[0]) chain.push(el.children[0].name);
  return chain;
}

function parseGuestFile(text) {
  const root = parseXml(text);
  const binder = root.name === 'BFTypedBinder' ? root : findAll(root, 'BFTypedBinder')[0];
  if (!binder) return null;
  const named = (n) => findAll(binder, 'BFNamedBinder').find((b) => b.attrs.binderName?.toLowerCase() === n);
  const main = named('mainobj'), head = named('headobj');
  const attach = findAll(binder, 'parentObj').find((p) => p.attrs.child?.toLowerCase() === 'headobj')?.attrs.attachnode ?? null;
  const sets = [];
  for (const info of findAll(binder, 'BFSharedRandomTextureInfo')) {
    for (const set of kids(info, 'replacementSet')) {
      const groups = kids(set, 'group').map((g) => ({
        weight: Number(g.attrs.weight ?? 1),
        items: kids(g, 'item').map((i) => ({ material: i.attrs.material.toLowerCase(), image: path(i.attrs.image), layer: /^decal/i.test(i.attrs.layer ?? '') ? 'decal' : 'base' })),
      })).filter((g) => g.items.length);
      if (groups.length) sets.push(groups);
    }
  }
  const cash = findAll(binder, 'ZTTransaction').find((t) => t.attrs.name === 'setInitialCash')?.attrs;
  const icon = findAll(binder, 'UIToggleButton').find((b) => b.attrs.template === 'adopt');
  return {
    id: binder.attrs.binderType,
    abstract: binder.attrs.abstract === 'true',
    cash: cash ? [Number(cash.minCost ?? 0), Number(cash.maxCost ?? cash.minCost ?? 0)] : null,
    icon: path(findAll(icon, 'default')[0]?.attrs.image),
    types: typeChain(kid(binder, 'types')),
    actor: path(findAll(main, 'BFActorComponent')[0]?.attrs.actorfile),
    scale: Number(findAll(main, 'BFActorComponent')[0]?.attrs.scale ?? 1),
    head: path(findAll(head, 'BFSimpleLODComponent')[0]?.attrs.modelfile ?? findAll(head, 'BFSceneGraphComponent')[0]?.attrs.modelfile),
    attach,
    sets,
  };
}

// Everyday guests (numbered variants such as Guest_Adult_M_01, Guest_Young_F_02); special ones
// (photographer, rock star, caveman, scientists...) come with scenarios and shows.
export async function loadGuestTypes(fs) {
  const files = fs.list((k) => /^entities\/units\/guests\/ai\/[^/]+\.xml$/i.test(k));
  const parsed = (await Promise.all(files.map((p) => fs.read(p).then((b) => {
    const g = parseGuestFile(new TextDecoder('latin1').decode(b));
    if (g) g.file = p;
    return g;
  }).catch(() => null)))).filter(Boolean);
  const byId = new Map(parsed.map((g) => [g.id.toLowerCase(), g]));
  const out = [];
  for (const g of parsed) {
    if (g.abstract || !/_\d+[a-z]?(_large)?$/i.test(g.id)) continue;
    // Inherit from the types above (most specific first).
    const chain = [g, ...g.types.slice(0, -1).reverse().map((t) => byId.get(t.toLowerCase())).filter(Boolean)];
    const pick = (k) => chain.find((c) => c[k])?.[k] ?? null;
    const t = { id: g.id, types: g.types, actor: pick('actor'), scale: chain.find((c) => c.actor)?.scale ?? 1, head: pick('head'), attach: pick('attach') ?? 'Link_Head', sets: chain.find((c) => c.sets.length)?.sets ?? [],
      cash: pick('cash') ?? [400, 600], icon: pick('icon') };
    t.adult = g.types.some((x) => /^guest_adult$/i.test(x));
    t.male = g.types.some((x) => /_m$/i.test(x));
    if (t.actor) out.push(t);
  }
  // Type name -> file, for the AI data (guest files are not named after their types).
  out.files = new Map(parsed.map((g) => [g.id.toLowerCase(), g.file]));
  return out;
}

// One weighted group from each replacement set: [{ material, layer ('base' or 'decal'), image }].
// A material can take a base texture (skin) and a decal over it (the shirt).
export function pickLook(type, random = Math.random) {
  const look = [];
  for (const set of type.sets) {
    const total = set.reduce((s, g) => s + g.weight, 0);
    let r = random() * total;
    const group = set.find((g) => (r -= g.weight) < 0) ?? set.at(-1);
    look.push(...group.items);
  }
  return look;
}

// Arrival rules from AI/guestMgr.xml.
export async function loadGuestConfig(fs) {
  const text = new TextDecoder('latin1').decode(await fs.read('ai/guestmgr.xml'));
  const a = parseXml(text);
  const mgr = a.name === 'ZTAIGuestMgr' ? a : findAll(a, 'ZTAIGuestMgr')[0];
  const n = (k, d) => Number(mgr?.attrs[k] ?? d);
  return {
    on: mgr?.attrs.On !== 'false',
    maxBase: n('MaxGuestsBase', 30), maxPerStar: n('MaxGuestsPerStar', 20),
    minDelay: n('MinDelaySecs', 1), maxDelay: n('MaxDelaySecs', 6),
    minRate: n('MinSpawnRate', 0.15), ratePerStar: n('ZooFamePercentRateIncreasePerStar', 10) / 100,
    adultAdmission: n('NormalAdultAdmission', 24), childAdmission: n('NormalChildAdmission', 12),
    displaceY: n('DisplacementY', -100) / 100,
  };
}

// A guest's name (s_GenerateName="person"): a first and a last name from the lists of
// lang/<language>/peoplenames.xml ("personname:Guest_Adult_M"), joined by the list's delimiter.
export function guestName(loc, type, random = Math.random) {
  const id = [...type.types].reverse().map((t) => `personname:${t}`).find((k) => loc.has(k));
  const raw = id ? loc.raw(id) : null;
  if (!raw) return type.adult ? 'Guest' : 'Child';
  const list = (tag) => [...(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(raw)?.[1] ?? '').matchAll(/<name>([^<]*)<\/name>/g)].map((m) => m[1].trim()).filter(Boolean);
  const one = (l) => l[Math.floor(random() * l.length)] ?? '';
  return [one(list('first')), one(list('last'))].filter(Boolean).join(' ');
}
