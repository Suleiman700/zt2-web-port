// The original AI data: entity attributes and needs along the type chain
// (entities/**/ai/<Type>.xml), task templates (AI/Tasks/**/*.tsk) and behavior sets
// (AI/Tasks/**/*.beh). Field meanings follow the game's own names; see docs in the code.
import { parseXml, child, findAll } from './xml.js';

const decoder = new TextDecoder('latin1');

// Attribute values by prefix: b_ boolean, f_ number, p_ vector, others as text.
export function attrValue(name, raw) {
  if (raw === undefined || raw === null) return raw;
  if (/^b_/i.test(name)) return raw === 'true' || raw === '1';
  if (/^f_/i.test(name)) return Number(raw);
  if (/^p_/i.test(name)) return raw.trim().split(/\s+/).map(Number);
  return raw;
}

// "LE 29" -> { op: 'LE', value: 29 }; "true" -> { op: 'E', value: true }; "25" -> { op: 'E', value: 25 }.
export function parseCondition(raw) {
  const m = /^\s*(GE|LE|NE|G|L|E)\s+(.+?)\s*$/i.exec(raw);
  const v = m ? m[2] : raw.trim();
  const value = v === 'true' ? true : v === 'false' ? false : Number.isFinite(Number(v)) && v !== '' ? Number(v) : v;
  return { op: (m?.[1] ?? 'E').toUpperCase(), value };
}

export function testCondition(cond, actual) {
  const { op, value } = cond;
  const a = typeof value === 'boolean' && typeof actual !== 'boolean' ? Boolean(actual) : actual;
  switch (op) {
    case 'GE': return a >= value;
    case 'LE': return a <= value;
    case 'G': return a > value;
    case 'L': return a < value;
    case 'NE': return a !== value;
    default: return a === value || (typeof value === 'number' && Number(a) === value);
  }
}

// <Subjects> / <Targets>: entity types or b_ flags (any of them, or all for *_AND) and qualifier groups.
function parseMatchGroup(el) {
  if (!el) return null;
  const group = { all: /_AND$/i.test(el.name), types: [], qualifiers: [] };
  for (const c of el.children) {
    if (/^Qualifiers(_AND)?$/i.test(c.name)) {
      group.qualifiers.push({ all: /_AND$/i.test(c.name), conditions: Object.entries(c.attrs).map(([k, v]) => [k, parseCondition(v)]) });
    } else {
      group.types.push(c.name.toLowerCase());
    }
  }
  return group;
}

// <BFAIToken Name GiveTo (subject | target | a type) Payload (subject | target) Timeout Timein
// Chance Radius OnlyOne RetainOnFailure/>. Timeout -1 never runs out; Timein delays the token
// (e.g. a pregnancy's t_Pregnant becomes usable 428 s after it is given).
export function parseTokens(list) {
  return (list?.children ?? []).filter((t) => t.attrs.Name).map((t) => ({
    name: t.attrs.Name.toLowerCase(),
    giveTo: (t.attrs.GiveTo ?? 'subject').toLowerCase(),
    payload: t.attrs.Payload?.toLowerCase() ?? null,
    timeout: Number(t.attrs.Timeout ?? 5),
    timein: Number(t.attrs.Timein ?? 0),
    chance: Number(t.attrs.Chance ?? t.attrs.chance ?? 100),
    radius: Number(t.attrs.Radius ?? 0),
    onlyOne: t.attrs.OnlyOne === 'true',
    retainOnFailure: t.attrs.RetainOnFailure === 'true',
  }));
}

// Values in need maps: a number, rand(min,max,step) (a new random value each time) or
// price_effect(cheap,moderate,expensive) (guests: by the price the stand charges).
export function numValue(raw) {
  const s = String(raw ?? '').trim();
  const m = /^(rand|price_effect)\(([^)]*)\)$/i.exec(s);
  if (!m) return Number(s);
  const args = m[2].split(',').map(Number);
  return m[1].toLowerCase() === 'rand' ? { rand: [args[0], args[1] ?? args[0], args[2] || 0] } : { price: args };
}
// A need-map value as a number now. priceLevel: 0 cheap, 1 moderate, 2 expensive.
export function resolveValue(v, priceLevel = 1, mean = false) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return resolveValue(numValue(v), priceLevel, mean);
  if (v?.rand) {
    const [min, max, step] = v.rand;
    if (mean) return (min + max) / 2;
    const x = min + Math.random() * (max - min);
    return step ? Math.round(x / step) * step : x;
  }
  if (v?.price) return v.price[Math.max(0, Math.min(v.price.length - 1, priceLevel))] ?? 0;
  return 0;
}
const floatMap = (el) => Object.fromEntries(Object.entries(child(el, 'BFAIAttributeFloatMap')?.attrs ?? {}).map(([k, v]) => [k, numValue(v)]));

function parseTask(el, file) {
  const create = child(el, 'BFAICreateData');
  const evalData = child(el, 'BFAIEvalData');
  const completion = child(el, 'BFAICompletionData');
  const failure = child(el, 'BFAIFailureData');
  const num = (v, d) => (v === undefined ? d : Number(v));
  return {
    name: el.attrs.Name,
    id: el.attrs.UniqueID ?? `${file}:${el.attrs.Name}`,
    file,
    priority: num(el.attrs.Priority, 0),
    delayMin: num(el.attrs.TaskDelayMin, 0),
    delayMax: num(el.attrs.TaskDelayMax, num(el.attrs.TaskDelayMin, 0)),
    reserveTag: el.attrs.reserveTag ?? null,
    sensorTag: el.attrs.sensorTag ?? null,
    subjects: parseMatchGroup(child(create, 'Subjects') ?? child(create, 'Subjects_AND')),
    targets: parseMatchGroup(child(create, 'Targets') ?? child(create, 'Targets_AND')),
    tokens: (child(create, 'Objects')?.children ?? []).map((c) => c.name.toLowerCase()),
    eval: {
      fixedScore: evalData?.attrs.fixedScore !== undefined ? Number(evalData.attrs.fixedScore) : null,
      // Guests: LeaveZoo is chosen once the guest's departure points run out.
      leaveZoo: evalData?.attrs.leaveZoo === 'true',
      needPointsGood: num(evalData?.attrs.needPointsGood, 0),
      needPointsBad: num(evalData?.attrs.needPointsBad, 0),
      deltas: floatMap(evalData),
      // Score multiplier by the biome under the target (e.g. savannah 1.0, grassland .5).
      biomeMap: child(evalData, 'BFAIBiomeMap') ? Object.fromEntries(Object.entries(child(evalData, 'BFAIBiomeMap').attrs).map(([k, v]) => [k.toLowerCase(), Number(v)])) : null,
    },
    exec: child(el, 'BFBehExecTask'),
    completion: {
      deltas: floatMap(completion),
      subject: Object.fromEntries(Object.entries(child(completion, 'BFAISubjectData')?.attrs ?? {}).map(([k, v]) => [k, attrValue(k, v)])),
      // Numbers (need changes such as health="5", f_ attributes) are amounts; flags and text are set.
      target: Object.fromEntries(Object.entries(child(completion, 'BFAITargetData')?.attrs ?? {}).map(([k, v]) => [k, /^f_/i.test(k) || (!/^[bsp]_/i.test(k) && /^\s*-?[\d.]+\s*$/.test(v)) ? Number(v) : attrValue(k, v)])),
      tokens: parseTokens(child(completion, 'BFAITokenList')),
      exec: child(completion, 'BFBehExecTask'),
      invalidateTarget: completion?.attrs.invalidateTarget === 'true',
    },
    failure: child(failure, 'BFBehExecTask'),
  };
}

export class AIData {
  constructor(fs) {
    this.fs = fs;
    this.tasks = [];              // all task templates
    this.tasksBySubject = new Map(); // subject type or flag (lowercase) -> [task]
    this.behaviorSets = new Map();   // set name (lowercase) -> [{ subjects: Set, behaviors: element }]
    this.entityFiles = new Map();    // type name (lowercase) -> entity xml path
    this.entityCache = new Map();
    for (const p of fs.list((k) => /^entities\/.*\/ai\/[^/]+\.xml$/.test(k))) {
      const base = p.split('/').at(-1).replace(/\.xml$/i, '').toLowerCase();
      if (!this.entityFiles.has(base)) this.entityFiles.set(base, p);
    }
  }

  // Loads every task and behavior file (about 30 MB of XML; done once, in the background).
  async loadAll(onProgress) {
    const files = this.fs.list((k) => k.startsWith('ai/') && /\.(tsk|beh)$/.test(k));
    // A few reads at a time: one at a time would wait a frame per file, hundreds at once would
    // queue every other file the game needs (interface, models) behind them.
    const texts = new Array(files.length);
    let next = 0, done = 0;
    const worker = async () => {
      while (next < files.length) {
        const n = next++;
        texts[n] = await this.fs.read(files[n]);
        if (++done % 64 === 0) onProgress?.(done, files.length);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    files.forEach((path, n) => {
      const root = parseXml(decoder.decode(texts[n]));
      const file = path.split('/').at(-1).replace(/\.\w+$/, '').toLowerCase();
      if (path.endsWith('.tsk')) {
        for (const el of findAll(root, 'BFAITaskTemplate')) {
          const task = parseTask(el, file);
          this.tasks.push(task);
          for (const t of task.subjects?.types ?? []) {
            if (!this.tasksBySubject.has(t)) this.tasksBySubject.set(t, []);
            this.tasksBySubject.get(t).push(task);
          }
        }
      } else {
        for (const set of root.children) {
          const subjects = new Set((child(set, 'subjects')?.children ?? []).map((c) => c.name.toLowerCase()));
          const behaviors = child(set, 'behaviors');
          if (!behaviors) continue;
          const key = set.name.toLowerCase();
          if (!this.behaviorSets.has(key)) this.behaviorSets.set(key, []);
          this.behaviorSets.get(key).push({ subjects, behaviors, file });
        }
      }
    });
  }

  // Behavior set `name` for an actor: the variant whose subjects include the most specific type.
  behaviorSet(name, typesMostSpecificFirst) {
    const list = this.behaviorSets.get(name.toLowerCase());
    if (!list) return null;
    for (const t of typesMostSpecificFirst) {
      const hit = list.find((s) => s.subjects.has(t));
      if (hit) return hit.behaviors;
    }
    return list.find((s) => !s.subjects.size)?.behaviors ?? null;
  }

  // Merged AI definition of an entity type: { types (root first), attrs, needAdjusts, stateVars }.
  async entity(typeName) {
    const key = typeName.toLowerCase();
    if (this.entityCache.has(key)) return this.entityCache.get(key);
    const promise = (async () => {
      const own = await this.readEntityFile(key);
      if (!own) return null;
      const out = { types: own.types, attrs: {}, needAdjusts: {}, stateVars: new Map(), containers: [], biome: null, swim: null, transactions: {} };
      for (const t of own.types) {
        const f = t.toLowerCase() === key ? own : await this.readEntityFile(t.toLowerCase());
        if (!f) continue;
        Object.assign(out.attrs, f.attrs);
        Object.assign(out.needAdjusts, f.needAdjusts);
        for (const [name, v] of f.stateVars) out.stateVars.set(name, { ...out.stateVars.get(name), ...v });
        if (f.containers.length) out.containers = f.containers;
        if (f.biome) out.biome = f.biome;
        if (f.swim) out.swim = f.swim;
        Object.assign(out.transactions, f.transactions);
      }
      return out;
    })();
    this.entityCache.set(key, promise);
    return promise;
  }

  async readEntityFile(key) {
    const path = this.entityFiles.get(key);
    if (!path) return null;
    const root = parseXml(decoder.decode(await this.fs.read(path)));
    const typeNames = [];
    const walkTypes = (el) => { for (const c of el.children) { typeNames.push(c.name); walkTypes(c); } };
    if (child(root, 'types')) walkTypes(child(root, 'types'));
    const attrs = {};
    for (const tag of ['BFAIEntityDataShared', 'BFAIEntityDataInstance']) {
      for (const el of findAll(root, tag)) for (const [k, v] of Object.entries(el.attrs)) if (!(k in attrs)) attrs[k] = attrValue(k, v);
    }
    // Swimmers (BFSwimComponent): start swimming where the water is waterInDistance deep.
    const swimEl = findAll(root, 'BFSwimComponent')[0];
    const swim = swimEl ? { inDepth: Number(swimEl.attrs.waterInDistance ?? 0.5), outDepth: Number(swimEl.attrs.waterOutDistance ?? 0.1) } : null;
    const needAdjusts = {};
    for (const el of findAll(root, 'BFAINeedAdjusts')) for (const [k, v] of Object.entries(el.attrs)) needAdjusts[k] = Number(v);
    const stateVars = new Map();
    for (const el of findAll(root, 'BFAIStateVar')) {
      const v = {};
      for (const [k, raw] of Object.entries(el.attrs)) if (k !== 'Name' && raw !== '') v[k] = k === 'Advanced' ? raw === 'true' : Number(raw);
      stateVars.set(el.attrs.Name, v);
    }
    // Container slots (food dishes, troughs, shelters): behavior sets to enter, use and leave,
    // under the named binder that tasks reserve (reserveTag, e.g. "Eat").
    const containers = [];
    for (const binder of findAll(root, 'BFNamedBinder')) {
      for (const slot of findAll(binder, 'BFGEntityContainerSlot')) {
        const sets = [slot.attrs.enterBehSet, slot.attrs.useBehSet, slot.attrs.exitBehSet].filter(Boolean);
        if (sets.length) containers.push({ binder: (binder.attrs.binderName ?? '').toLowerCase(), node: slot.attrs.targetNode ?? null, sets });
      }
    }
    // Biome data: a species' sensitivity per biome (-10..10), or the biome a plant or rock belongs to.
    const bd = findAll(root, 'BFGBiomeData')[0];
    const biome = bd ? {
      location: bd.attrs.location ?? null,
      sensitivity: Object.fromEntries(bd.children.filter((c) => c.attrs.sensitivity !== undefined).map((c) => [c.name.toLowerCase(), Number(c.attrs.sensitivity)])),
      members: bd.children.filter((c) => c.attrs.sensitivity === undefined).map((c) => c.name.toLowerCase()),
    } : null;
    // Money the object takes or gives (ZTEconomyComponent): name -> { cost, choices, index, category }.
    // Stands sell at one of three prices (costChoice "6 12 18", costIndex 1 = moderate).
    const transactions = {};
    for (const t of findAll(root, 'ZTTransaction')) {
      if (!t.attrs.name) continue;
      transactions[t.attrs.name.toLowerCase()] = {
        cost: Number(t.attrs.cost ?? 0), choices: t.attrs.costChoice ? t.attrs.costChoice.trim().split(/\s+/).map(Number) : null,
        index: Number(t.attrs.costIndex ?? 1), category: t.attrs.category ?? null, type: t.attrs.type ?? null,
      };
    }
    return { types: [...typeNames, root.attrs.binderType ?? key].filter((t, i, a) => a.indexOf(t) === i), attrs, needAdjusts, stateVars, containers, biome, swim, transactions };
  }
}

