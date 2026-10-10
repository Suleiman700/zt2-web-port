// Carries out animal minds (animalmind.js) in the zoo: finds task targets inside the exhibit,
// walks animals along found paths, plays the named animations from the actor's list.
// `world` gives access to the game: { entities, exhibits, isWater, passable(e) -> (cx, cy) -> bool,
// heightAt, hour, assets, findPath }.
import { AnimalMind } from './animalmind.js';

const SPEED_SCALE = { slow: 0.7, medium: 1, stalk: 0.6, fast: 1, evade: 1 };

// Starts the AI for an animal entity once the AI data has loaded.
export async function attachMind(e, aiData, assets) {
  const def = await aiData.entity(e.variant ?? e.id);
  if (!def) return;
  e.mind = new AnimalMind(aiData, def);
  const variant = e.item.variants?.find((v) => v.id === e.variant);
  const actor = e.actor ?? variant?.actor; // spawned young carry their own actor file
  e.animPaths = actor ? await assets.actor(actor) : new Map();
}

// AI types and instance attributes of an object, for targeting (food level, fence strength...).
export async function attachObjectAI(e, aiData) {
  const def = await aiData.entity(e.variant ?? e.id);
  if (!def) return;
  e.ai = { types: new Set(def.types.map((t) => t.toLowerCase())), attrs: { ...def.attrs }, containers: def.containers, biomes: def.biome?.members ?? [], location: def.biome?.location ?? null, transactions: def.transactions ?? {} };
  for (const [k, v] of Object.entries(def.attrs)) if (/^b_/i.test(k) && v === true) e.ai.types.add(k.toLowerCase());
}

function targetValue(e, name) {
  const attrs = e.mind?.attrs ?? e.ai?.attrs ?? {};
  if (name in attrs) return attrs[name];
  const k = Object.keys(attrs).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? attrs[k] : 0;
}

const isType = (e, type) => (e.mind ? e.mind.isA(type) : e.ai?.types.has(type)) ?? false;

// Family ties, kept on the entity as uids: { mate, mother, father, children: [] } (the game's
// BFAI relationships: "mate" set by scripts/setmates, "child" by BFBehSpawn spawnRelation).
export const relations = (e) => (e.rel ??= { mate: null, mother: null, father: null, children: [] });
const alive = (uid, world) => (uid === null || uid === undefined ? null : world.byUid(uid));
const isAdult = (o) => Boolean(o.mind?.attrs.b_Adult);
function related(a, b) {
  const ra = relations(a), rb = relations(b);
  return ra.mother === b.uid || ra.father === b.uid || rb.mother === a.uid || rb.father === a.uid
    || (ra.mother !== null && ra.mother === rb.mother);
}
// APPROX (engine rule, not in the data): an adult of the species that is not a parent, child or
// sibling of the animal.
const canMate = (e, o) => isAdult(o) && !related(e, o);

// isRelation="child": the target is one of the animal's young.
function isRelation(e, o, kind) {
  const r = relations(e);
  if (kind === 'child') return r.children.includes(o.uid);
  if (kind === 'mate') return r.mate === o.uid;
  if (kind === 'parent') return r.mother === o.uid || r.father === o.uid;
  return false;
}

// The game's Lua scripts used by tasks, as decoded from scripts/*.bin.
const SCRIPTS = {
  // canreproduce.bin: "failure" while pregnant (t_Pregnant or t_Pregnant1) or while any of her
  // children is not yet an adult (b_Adult), else "complete".
  canreproduce(e, target, world) {
    if (e.mind.tokens.has('t_pregnant') || e.mind.tokens.has('t_pregnant1')) return 'failure';
    const young = relations(e).children.map((uid) => alive(uid, world)).some((c) => c && !isAdult(c));
    return young ? 'failure' : 'complete';
  },
  // setmates.bin: clears both animals' old mates and makes them each other's mate.
  setmates(e, target, world) {
    const o = target?.entity;
    if (!o?.mind) return 'error';
    for (const a of [e, o]) {
      const old = alive(relations(a).mate, world);
      if (old) relations(old).mate = null;
      relations(a).mate = null;
    }
    relations(e).mate = o.uid;
    relations(o).mate = e.uid;
    return 'complete';
  },
};

// Possible targets of a task for an animal: [{ pos, entity?, distance }].
function findTargets(e, task, world) {
  const group = task.targets;
  if (!group) return [];
  const conditions = group.qualifiers.flatMap((q) => q.conditions);
  const sight = conditions.find(([k]) => k === 'inSight')?.[1].value ?? Infinity;
  const inHabitat = conditions.some(([k, c]) => k === 'inHabitat' && c.value === true);
  const region = world.exhibits.regionAt(e.pos[0], e.pos[1]);
  const out = [];
  const near = (p) => Math.hypot(p[0] - e.pos[0], p[1] - e.pos[1]);

  // A token's payload: with <fromToken/> it is the target (e.g. the animal that invited a chase);
  // otherwise targets are looked for around it (t_EvaluateThreat: predators near the parent's young).
  const payload = task.tokens.map((t) => e.mind.tokenPayloads?.get(t)?.entity).find(Boolean) ?? null;
  if (group.types.includes('fromtoken')) {
    return payload && world.entities.includes(payload) ? [{ pos: payload.pos, entity: payload, distance: near(payload.pos) }] : [];
  }
  const origin = payload && world.entities.includes(payload) ? payload.pos : e.pos;
  const fromOrigin = (p) => Math.hypot(p[0] - origin[0], p[1] - origin[1]);
  for (const type of group.types) {
    if (type === 'self') { out.push({ pos: e.pos, entity: e, self: true, distance: 0 }); continue; }
    // Guests: a spot on a path (next to an exhibit when there is one) within sight.
    if (type === 'path') { const p = world.pathSpot?.(e, sight); if (p) out.push({ ...p, distance: near(p.pos) }); continue; }
    if (type === 'elevatedpath') continue;
    if (['ground_cover', 'dirt', 'biome', 'land'].includes(type)) {
      const p = world.exhibits.randomPoint(region);
      if (p && !world.isWater(p[0], p[1]) && near(p) <= sight) out.push({ pos: p, distance: near(p) });
      continue;
    }
    if (type === 'water') {
      // Water in the exhibit at least waterDepth deep (polar bears: GE 2 to go swimming).
      const minDepth = conditions.find(([k]) => k === 'waterDepth')?.[1].value ?? 0.3;
      for (let k = 0; k < 24; k++) {
        const p = world.exhibits.randomPoint(region);
        if (p && world.isWater(p[0], p[1]) && world.waterDepthAt(p[0], p[1]) >= minDepth && near(p) <= sight) { out.push({ pos: p, distance: near(p) }); break; }
      }
      continue;
    }
    if (type === 'shore') {
      for (let k = 0; k < 12; k++) {
        const p = world.exhibits.randomPoint(region);
        if (!p || world.isWater(p[0], p[1]) || near(p) > sight) continue;
        const wet = [[1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5]].find(([dx, dy]) => world.isWater(p[0] + dx, p[1] + dy));
        if (wet) { out.push({ pos: p, face: [p[0] + wet[0], p[1] + wet[1]], distance: near(p) }); break; }
      }
      continue;
    }
    if (type === 'shade') {
      const trees = world.entities.filter((o) => o.ai?.types.has('tree') && world.exhibits.regionAt(o.pos[0], o.pos[1]) === region);
      const tree = trees[Math.floor(Math.random() * trees.length)];
      if (tree) out.push({ pos: [tree.pos[0] + 1, tree.pos[1] + 1], entity: null, distance: near(tree.pos) });
      continue;
    }
  }
  const entityTypes = group.types.filter((t) => !AnimalMind.isTerrainTarget(t));
  if (entityTypes.length) {
    // Fences count only along the animal's own exhibit (and not once broken).
    const fences = (world.fences ?? []).filter((f) => f.ai && !f.broken && world.fenceSides(f).includes(region));
    for (const o of [...world.entities, ...fences]) {
      if (o === e || (!o.ai && !o.mind)) continue;
      // Objects with places to use (a reserveTag's container slots) take one user per place.
      if (task.reserveTag && world.isFull?.(o, task.reserveTag, e)) continue;
      const typeOk = group.all ? entityTypes.every((t) => isType(o, t)) : entityTypes.some((t) => isType(o, t));
      if (!typeOk) continue;
      const d = near(o.pos);
      if (fromOrigin(o.pos) > sight) continue;
      if (inHabitat && !o.fence && world.exhibits.regionAt(o.pos[0], o.pos[1]) !== region) continue;
      const ok = group.qualifiers.every((q) => {
        const test = ([k, c]) => {
          if (k === 'inSight' || k === 'inHabitat') return true;
          if (k === 'isFamily') return testConditionLoose(c, related(e, o));
          if (k === 'canMate') return testConditionLoose(c, canMate(e, o));
          if (k === 'sameSpecies') return testConditionLoose(c, Boolean(o.mind && o.mind.species === e.mind.species));
          if (k === 'isRelation') return isRelation(e, o, String(c.value).toLowerCase());
          if (k === 'hasMate') return testConditionLoose(c, Boolean(alive(relations(o).mate, world)));
          return testConditionLoose(c, targetValue(o, k));
        };
        return q.all ? q.conditions.every(test) : q.conditions.some(test);
      });
      if (ok) out.push({ pos: o.pos, entity: o, distance: d });
    }
  }
  return out;
}

function testConditionLoose(c, actual) {
  const { op, value } = c;
  const a = typeof value === 'boolean' ? Boolean(actual) : actual;
  switch (op) {
    case 'GE': return a >= value;
    case 'LE': return a <= value;
    case 'G': return a > value;
    case 'L': return a < value;
    case 'NE': return a !== value;
    default: return a === value || Number(a) === value;
  }
}

// One frame of an animal with a mind. Returns false if the caller should use simple wandering.
export function updateAnimalMind(e, dt, world) {
  const mind = e.mind;
  if (!mind) return false;
  mind.updateNeeds(dt);
  if (!dt) return true; // paused
  const ctx = {
    hour: world.hour,
    biomeAt: (p) => world.biomeAt(p[0], p[1]),
    inWater: world.isWater(e.pos[0], e.pos[1]),
    isSwimming: isSwimming(e, world),
    selfEntity: e,
    findTargets: (task) => findTargets(e, task, world),
    applyTargetData: (o, data) => {
      const attrs = o.mind?.attrs ?? o.ai?.attrs;
      if (!attrs) return;
      for (const [k, v] of Object.entries(data)) {
        // An animal's needs change by the amount (VerySick: health +5 on itself).
        if (o.mind && k in o.mind.needs && typeof v === 'number') o.mind.needs[k] = Math.max(0, Math.min(100, o.mind.needs[k] + v));
        else if (/^f_/i.test(k) && typeof v === 'number') attrs[k] = Math.max(0, Math.min(100, (attrs[k] ?? 0) + v));
        else attrs[k] = v;
      }
      o.mind?.updateTriggers();
    },
    containerSets: (target, tag) => {
      const list = target?.entity?.ai?.containers ?? [];
      return (list.find((c) => c.binder === tag?.toLowerCase()) ?? list[0])?.sets ?? [];
    },
    giveToken: (o, token, payload) => o.mind?.receiveToken(token, payload),
    spawn: (type, opts) => world.spawn(type, e, opts),
    broadcastToken: (type, radius, token, payload) => {
      for (const o of world.entities) {
        if (o !== e && o.mind?.isA(type) && (!radius || Math.hypot(o.pos[0] - e.pos[0], o.pos[1] - e.pos[1]) <= radius)) o.mind.receiveToken(token, payload);
      }
    },
    hasMate: Boolean(alive(relations(e).mate, world)),
    script: (file, fn, target) => {
      const run = SCRIPTS[String(fn).toLowerCase()];
      if (!run) return 'complete';
      return run(e, target, world);
    },
    message: (locID, target) => world.message?.(locID, e, target),
    emote: (name, scale) => world.emote?.(e, name, scale),
    // Guests: money, triggers (Adjust_ZooFame when leaving), thoughts, stand prices.
    economy: (name, target, attrs) => world.economy?.(e, name, target, attrs),
    trigger: (name, target) => world.trigger?.(e, name, target),
    thought: (locID, target, attrs) => world.thought?.(e, locID, target, attrs),
    priceLevel: (target) => world.priceLevel?.(target) ?? 1,
    viewScore: (target) => world.viewScore?.(e, target) ?? null,
  };
  // Another animal started a synchronized set with this one: drop the current action.
  if (mind.pendingSync && e.act) { e.act = null; e.route = null; e.idleWait = 0; }
  if (e.idleWait > 0) { e.idleWait -= dt; return true; }
  if (!e.act) {
    e.act = mind.nextAction(ctx);
    if (!e.act) { e.idleWait = 2; playIdle(e, world); return true; }
    e.act.time0 = e.act.time;
  }
  const act = e.act;
  const done = () => { e.act = null; e.route = null; e.wanderGoal = null; };
  switch (act.kind) {
    case 'move': {
      // A docking node of the target's model, when the behavior names one and the model has it.
      const nodeGoal = act.node && act.target?.entity ? world.nodeMatrix?.(act.target.entity, act.node) : null;
      const goal = nodeGoal ? [nodeGoal[12], nodeGoal[13], nodeGoal[14]] : act.target?.pos;
      if (!goal) { done(); break; }
      const dist = Math.hypot(goal[0] - e.pos[0], goal[1] - e.pos[1]);
      // How close is close enough: guests stop on the path beside a stand (world.reach).
      const reach = nodeGoal ? 0.4 : world.reach?.(e, act.target, act.near) ?? Math.max(act.near ?? 0.6, 1.2);
      if (dist <= Math.max(act.near ?? 0.6, 0.4)) { done(); break; }
      if (!e.route || e.routeGoal !== goal || (act.target.entity && Math.hypot(goal[0] - e.routeEnd[0], goal[1] - e.routeEnd[1]) > 2)) {
        // Stop just short of the target (its own cells are occupied).
        e.route = world.findPath(e.pos, goal, world.passable(e, goal), { maxNodes: 6000, nearGoal: reach });
        e.routeGoal = goal;
        e.routeEnd = [...goal];
        if (!e.route) { mind.fail(ctx); done(); e.idleWait = 1; break; }
      }
      if (walk(e, dt, act.speed, world)) { /* waypoint reached; walk() shifts the route */ }
      if (!e.route?.length) {
        if (nodeGoal) { e.pos[0] = goal[0]; e.pos[1] = goal[1]; } // settle on the docking spot
        done();
      }
      break;
    }
    case 'wander': {
      act.time -= dt;
      if (act.time <= 0) { done(); break; }
      if (!e.route?.length) {
        const region = world.exhibits.regionAt(e.pos[0], e.pos[1]);
        const p = world.exhibits.randomPoint(region);
        e.route = p ? world.findPath(e.pos, p, world.passable(e), { maxNodes: 4000 }) : null;
        if (!e.route) { playIdle(e, world); break; }
      }
      walk(e, dt, act.speed, world);
      break;
    }
    case 'anim': {
      if (!act.started) {
        act.started = true;
        e.clipName = null;
        act.clipReady = world.playOnce(e, act.name);
        act.left = act.time ?? null;
      }
      if (act.clipReady === false) { done(); break; } // not in this animal's list
      if (!act.playing) {
        // The clip may still be loading: start it once it has arrived.
        if (e.clipName === act.name.toLowerCase()) act.playing = true;
        else world.playOnce(e, act.name);
      }
      const clip = e.clip;
      if (act.left !== null) {
        act.left -= dt;
        if (act.left <= 0) done();
      } else if (clip && e.clipName === act.name.toLowerCase() && e.clipTime >= clip.duration - 1e-3) {
        done();
      } else if (act.wait === undefined) {
        act.wait = 8; // safety: clip still loading or missing
      } else if ((act.wait -= dt) <= 0) done();
      break;
    }
    case 'view': {
      // Guests watching animals (ZTBehViewAnimals): face the exhibit, look for a while.
      if (!act.started) { act.started = true; world.viewAnimals?.(e, act.target); }
      act.time -= dt;
      if (act.time <= 0) { done(); break; }
      if (!act.anim || (act.animLeft -= dt) <= 0) {
        act.anim = Math.random() < 0.6 ? 'Stand_Idle' : ['Stand_LookAround', 'Stand_Point', 'Stand_Applaud', 'Stand_CheckWatch'][Math.floor(Math.random() * 4)];
        act.animLeft = 3 + Math.random() * 3;
        if (!world.playLoop(e, act.anim)) world.playLoop(e, 'Stand_Idle');
      }
      break;
    }
    case 'face': {
      // The docking node's own facing (its local x axis, as the entity's yaw turns its x axis).
      const m = act.node && act.target?.entity ? world.nodeMatrix?.(act.target.entity, act.node) : null;
      if (m) { e.yaw = Math.atan2(m[1], m[0]); done(); break; }
      const p = act.target?.face ?? act.target?.pos;
      if (p) e.yaw = Math.atan2(p[1] - e.pos[1], p[0] - e.pos[0]) + Math.PI / 2;
      done();
      break;
    }
    case 'morph':
      world.morph?.(e, act.type, act);
      done();
      break;
    case 'morphTarget': {
      const o = act.target?.entity;
      if (o?.fence) world.breakFence?.(o, act.type);
      done();
      break;
    }
    case 'cross': {
      // Over (or under) the fence: to the same distance on its other side.
      const f = act.target?.entity;
      if (f?.fence) {
        const dx = f.wb[0] - f.wa[0], dy = f.wb[1] - f.wa[1], len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        const side = (e.pos[0] - f.pos[0]) * nx + (e.pos[1] - f.pos[1]) * ny;
        const along = (e.pos[0] - f.pos[0]) * dx / len + (e.pos[1] - f.pos[1]) * dy / len;
        const out = Math.max(1.5, Math.abs(side)) * (side >= 0 ? -1 : 1);
        e.pos[0] = f.pos[0] + dx / len * Math.max(-len / 2, Math.min(len / 2, along)) + nx * out;
        e.pos[1] = f.pos[1] + dy / len * Math.max(-len / 2, Math.min(len / 2, along)) + ny * out;
        e.pos[2] = world.heightAt(e.pos[0], e.pos[1]);
      }
      done();
      break;
    }
    case 'kill':
      world.kill?.(e);
      done();
      break;
    default: done();
  }
  return true;
}

// Moves along e.route; returns true when a waypoint was reached.
function walk(e, dt, speedName, world) {
  const next = e.route?.[0];
  if (!next) return false;
  const dx = next[0] - e.pos[0], dy = next[1] - e.pos[1];
  const dist = Math.hypot(dx, dy);
  if (dist < 0.15) { e.route.shift(); return true; }
  const fast = speedName === 'fast' || speedName === 'evade';
  const clipName = isSwimming(e, world) ? 'Swim_Ahead' : fast ? 'Run_Ahead' : 'Walk_Ahead';
  if (!world.playLoop(e, clipName)) world.playLoop(e, 'Walk_Ahead');
  const speed = ((fast ? e.runSpeed : e.walkSpeed) || (fast ? 3.5 : 1.2)) * (SPEED_SCALE[speedName] ?? 1);
  const desired = Math.atan2(dy, dx) + Math.PI / 2;
  const diff = ((desired - e.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  e.yaw += Math.sign(diff) * Math.min(Math.abs(diff), dt * (fast ? 4 : 2.5));
  if (Math.abs(diff) < 0.9) {
    const step = Math.min(dist, speed * dt);
    e.pos[0] += (dx / dist) * step;
    e.pos[1] += (dy / dist) * step;
    e.pos[2] = world.animalHeightAt(e, e.pos[0], e.pos[1]);
  }
  return false;
}

// Swimmers (BFSwimComponent) swim where the water is at least waterInDistance deep.
function isSwimming(e, world) {
  const swim = e.mind?.def.swim;
  return Boolean(swim && world.isWater(e.pos[0], e.pos[1]) && world.waterDepthAt(e.pos[0], e.pos[1]) >= swim.inDepth);
}

function playIdle(e, world) {
  if (isSwimming(e, world)) { if (world.playLoop(e, 'Swim_Idle') || world.playLoop(e, 'TreadWater_Idle')) return; }
  world.playLoop(e, 'Stand_Idle');
}

// The hidden needs the game sets from the exhibit itself: biome (how well the exhibit's terrain,
// plants and rocks suit the species), space (area for the number of animals) and environment.
// APPROX: the original formulas are in the engine, not the data. Here:
//  - biome: the exhibit's biome mix (terrain cells, plus each plant or rock of a biome) weighted
//    by the species' sensitivity (-10..10): all-favourite biome = 0, neutral = 50, worst = 100;
//  - space: needed area f_RequiredInitialSpace + f_RequiredAdditionalSpace per extra animal of
//    the species (square metres); 0 when met, rising to 100 at half of it;
//  - environment: the biome need, eased when the exhibit has plants and rocks.
// stats: { area, biomeWeights: { biome: weight }, plants, rocks, counts: Map(species -> n) }.
export function updateHabitatNeeds(e, stats) {
  const m = e.mind;
  if (!m || !stats) return;
  const sens = m.def.biome?.sensitivity ?? {};
  let total = 0, score = 0;
  for (const [b, w] of Object.entries(stats.biomeWeights)) { total += w; score += w * (sens[b] ?? 0); }
  const suit = total ? score / total : 0; // -10..10
  if ('biome' in m.needs) m.needs.biome = Math.max(0, Math.min(100, 50 - suit * 5));
  const initial = m.attrs.f_RequiredInitialSpace ?? 0, extra = m.attrs.f_RequiredAdditionalSpace ?? 0;
  const same = stats.counts.get(m.species) ?? 1;
  const required = initial + extra * Math.max(0, same - 1);
  if ('space' in m.needs) m.needs.space = required && stats.area < required ? Math.min(100, (1 - stats.area / required) * 200) : 0;
  if ('environment' in m.needs) {
    const cover = Math.min(1, (stats.plants + stats.rocks) / Math.max(1, stats.area / 100));
    m.needs.environment = Math.max(0, Math.min(100, m.needs.biome * (1 - 0.4 * cover)));
  }
  m.updateTriggers();
}
