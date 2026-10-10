// An animal's mind, run from the original AI data (aidata.js): needs that grow every adjust
// tick, task selection from the task templates, and a behavior player that turns the task's
// behavior primitives into actions for the game to carry out (move, animate, wander...).
//
// From the data: needs are deprivation levels 0..100 (tasks subtract), each grows by its
// BFAINeedAdjusts value per tick, a need counts for scoring between its TriggerThreshold and
// CessationThreshold, higher Priority wins before score, TaskDelayMin/Max are cooldowns.
// Not in the data and approximated here (marked APPROX): the tick length (3 s, as OpenZT2
// assumes from StateThinkerInterval="30"), how need points (happiness) accumulate, and
// needPointsGood/Bad in BFAIEvalData acting as minimum gates.
import { testCondition, parseTokens, attrValue, resolveValue } from './aidata.js';

const TICK = 3;                 // APPROX: seconds per need adjust and need-point update
const NEED_POINT_DELTA = 0.2;   // animal.xml f_NeedPointGoodDelta / f_NeedPointBadDelta
const SHOWN_NEEDS = ['hunger', 'thirst', 'rest', 'exercise', 'environment', 'privacy', 'hygiene', 'social', 'stimulation', 'health'];
const TERRAIN_TARGETS = new Set(['self', 'shore', 'ground_cover', 'dirt', 'shade', 'biome', 'land', 'water', 'path', 'elevatedpath']);

export class AnimalMind {
  // def: AIData.entity(variant) result.
  constructor(ai, def) {
    this.ai = ai;
    this.def = def;
    this.types = def.types.map((t) => t.toLowerCase());
    this.typesSpecificFirst = [...this.types].reverse();
    // Species: the type that has _Adult / _Young children (Lion for Lion_Adult_F).
    this.species = this.types.find((t) => this.types.includes(`${t}_adult`) || this.types.includes(`${t}_young`)) ?? this.types.at(-1);
    this.attrs = { ...def.attrs };
    this.needs = {};
    this.active = {}; // need -> triggered (counts for task scores)
    for (const [name, v] of def.stateVars) {
      const min = v.ValueMin ?? v.Value ?? 0, max = v.ValueMax ?? v.Value ?? min;
      this.needs[name] = min + Math.random() * (max - min);
      this.active[name] = false;
    }
    this.flags = new Set(Object.entries(this.attrs).filter(([k, val]) => /^b_/i.test(k) && val === true).map(([k]) => k.toLowerCase()));
    this.tokens = new Map();   // token name -> { left (s, Infinity for none), timein (s until usable), retain }
    this.cooldowns = new Map(); // task id -> seconds left
    this.tickTime = Math.random() * TICK;
    this.task = null;          // { template, target, gen, phase }
    this.action = null;        // current primitive action for the host
    this.status = null;        // ZTActionInfo locID of what the animal is doing
    this.lastView = null;      // last ZTBehViewEvent key (guest reactions, Phase 5)
    this.candidates = null;
  }

  get needPointsGood() { return this.attrs.f_needPointsGood ?? 0; }
  get needPointsBad() { return this.attrs.f_needPointsBad ?? 0; }

  isA(type) { return this.types.includes(type) || this.flags.has(type); }

  hasToken(name) { const t = this.tokens.get(name); return Boolean(t) && t.timein <= 0; }

  // Advances needs and timers by dt seconds of zoo time.
  updateNeeds(dt) {
    for (const [k, t] of this.cooldowns) { if (t - dt <= 0) this.cooldowns.delete(k); else this.cooldowns.set(k, t - dt); }
    for (const [k, t] of this.tokens) {
      if (t.timein > 0) { t.timein -= dt; continue; }
      if ((t.left -= dt) <= 0) this.tokens.delete(k);
    }
    this.tickTime -= dt;
    while (this.tickTime <= 0) {
      this.tickTime += TICK;
      for (const [need, rate] of Object.entries(this.def.needAdjusts)) {
        if (need in this.needs) this.needs[need] = clamp(this.needs[need] + rate, 0, 100);
      }
      this.updateTriggers();
      // APPROX: each shown need that is satisfied (below its trigger threshold, so not asking for
      // anything) adds good points, each at or above its pressing threshold adds bad points
      // (f_NeedPointGoodDelta/BadDelta .2 per need and update, kept within 0..100).
      let good = 0, bad = 0;
      for (const need of SHOWN_NEEDS) {
        const v = this.def.stateVars.get(need);
        if (!v || !(need in this.needs)) continue;
        if (v.PressingThreshold !== undefined && this.needs[need] >= v.PressingThreshold) bad++;
        else if (v.TriggerThreshold !== undefined && this.needs[need] < v.TriggerThreshold) good++;
      }
      this.attrs.f_needPointsGood = clamp(this.needPointsGood + NEED_POINT_DELTA * (good - bad), 0, 100);
      this.attrs.f_needPointsBad = clamp(this.needPointsBad + NEED_POINT_DELTA * (bad - good), 0, 100);
    }
  }

  updateTriggers() {
    for (const [need, v] of this.def.stateVars) {
      const value = this.needs[need];
      if (value === undefined) continue;
      // A zero trigger counts when the need never ceases (CessationThreshold below 0): a guest's
      // wish to see animals (viewanimals 0 / -100) is always there.
      if (!this.active[need] && v.TriggerThreshold !== undefined && value >= v.TriggerThreshold && (v.TriggerThreshold > 0 || (v.CessationThreshold ?? 0) < 0)) this.active[need] = true;
      else if (this.active[need] && value <= (v.CessationThreshold ?? 0)) this.active[need] = false;
    }
  }

  // Value of a subject qualifier for this animal (needs, attributes, time, location).
  value(name, ctx) {
    if (name in this.needs) return this.needs[name];
    switch (name) {
      case 'timeOfDay': case 'timeOfDayMin': case 'timeOfDayMax': return ctx.hour;
      case 'isSwimming': return ctx.isSwimming ?? false;
      case 'inWater': return ctx.inWater ?? false;
      case 'onLand': return !(ctx.inWater ?? false);
      case 'inWater_OR_onLand': return true;
      case 'needPointsGood': return this.needPointsGood;
      case 'needPointsBad': return this.needPointsBad;
      case 'hasMate': return ctx.hasMate ?? false;
      default: return this.attrs[name] ?? this.attrs[Object.keys(this.attrs).find((k) => k.toLowerCase() === name.toLowerCase())] ?? 0;
    }
  }

  subjectMatches(task, ctx) {
    const s = task.subjects;
    if (!s) return false;
    const typeOk = s.types.length === 0 || (s.all ? s.types.every((t) => this.isA(t)) : s.types.some((t) => this.isA(t)));
    if (!typeOk) return false;
    return s.qualifiers.every((q) => (q.all ? q.conditions.every : q.conditions.some).call(q.conditions, ([k, c]) => testCondition(c, this.value(k, ctx))));
  }

  // Score of a task for this animal (before distance), or -Infinity if it can not be chosen.
  score(task) {
    const e = task.eval;
    if (e.leaveZoo) return (this.attrs.f_departurePoints ?? this.attrs.f_DeparturePoints ?? 1) <= 0 ? 1e9 : -Infinity;
    if (e.needPointsGood && this.needPointsGood < e.needPointsGood) return -Infinity; // APPROX: gate
    if (e.needPointsBad && this.needPointsBad < e.needPointsBad) return -Infinity;
    if (e.fixedScore !== null) return e.fixedScore;
    let score = 0;
    for (const [need, raw] of Object.entries(e.deltas)) {
      const delta = resolveValue(raw, 1, true);
      if (delta < 0 && this.active[need]) score += -delta * (this.needs[need] ?? 0) / 100;
    }
    return score;
  }

  // Picks the next task. ctx.findTargets(task, mind) -> [{ pos, entity?, distance }].
  chooseTask(ctx) {
    if (!this.candidates) {
      const keys = [...this.types, ...this.flags];
      this.candidates = [...new Set(keys.flatMap((k) => this.ai.tasksBySubject.get(k) ?? []))];
    }
    let best = null;
    for (const task of this.candidates) {
      if (this.cooldowns.has(task.id)) continue;
      if (task.tokens.length && !task.tokens.every((t) => this.hasToken(t))) continue;
      const base = this.score(task);
      if (base === -Infinity || base <= 0 && task.eval.fixedScore === null) continue;
      if (best && task.priority < best.task.priority) continue;
      if (best && task.priority === best.task.priority && base < best.score) continue;
      if (!this.subjectMatches(task, ctx)) continue;
      const targets = ctx.findTargets(task, this);
      if (!targets.length) continue;
      // Nearer targets score a little higher: divide by ((max(dist, 1) - 1) / 1000 + 1).
      const target = targets[Math.floor(Math.random() * targets.length)];
      let score = base / ((Math.max(target.distance ?? 1, 1) - 1) / 1000 + 1);
      if (task.eval.biomeMap) score *= task.eval.biomeMap[ctx.biomeAt?.(target.pos)] ?? 0;
      if (score <= 0) continue;
      if (!best || task.priority > best.task.priority || score > best.score || (score === best.score && Math.random() < 0.5)) {
        best = { task, target, score };
      }
    }
    if (!best) return false;
    this.startTask(best.task, best.target, ctx);
    return true;
  }

  startTask(task, target, ctx) {
    this.task = { template: task, target, phase: 'exec' };
    (this.history ??= []).push(task.name);
    if (this.history.length > 12) this.history.shift();
    this.task.gen = this.run(task.exec, target, ctx);
    this.status = null;
  }

  // The next action for the host, advancing through the task's phases. Returns null when idle.
  nextAction(ctx) {
    // A behavior set another animal asked this one to play along with (BFBehSyncSet, e.g. Mate).
    if (this.pendingSync) {
      this.overlay = this.playSet(this.pendingSync.set, this.pendingSync.target, ctx);
      this.pendingSync = null;
    }
    if (this.overlay) {
      const step = this.overlay.next();
      if (!step.done) return step.value;
      this.overlay = null;
    }
    for (let guard = 0; guard < 200; guard++) {
      if (!this.task && !this.chooseTask(ctx)) return null;
      const step = this.task.gen.next();
      if (!step.done) return step.value;
      if (this.task.failed) this.fail(ctx);
      else if (this.task.phase === 'exec') this.complete(ctx);
      else this.finish();
    }
    return null;
  }

  // Another animal's BFBehSyncSet: drop what this one is doing for a moment and play the set.
  syncWith(set, target) { this.pendingSync = { set, target }; }

  // The main phase ran to its end: apply the completion data and play its behaviors.
  complete(ctx) {
    const { template: task, target } = this.task;
    const c = task.completion;
    this.consumeTokens(task, false);
    const price = ctx.priceLevel?.(target) ?? 1;
    for (const [need, raw] of Object.entries(c.deltas)) {
      if (need in this.needs) this.needs[need] = clamp(this.needs[need] + resolveValue(raw, price), 0, 100);
      // Counters in the same map (a guest's f_departurePoints -20 after eating) add up.
      else if (/^f_/i.test(need)) this.attrs[need] = (Number(this.attrs[need]) || 0) + resolveValue(raw, price);
    }
    // Subject data: needs change by the amount; numbers add to f_ attributes that count
    // something (f_DeparturePoints); other attributes are set.
    for (const [k, v] of Object.entries(c.subject)) {
      if (k in this.needs) this.needs[k] = clamp(this.needs[k] + resolveValue(v, price), 0, 100);
      else if (/^f_/i.test(k) && Number.isFinite(Number(v))) this.attrs[k] = (Number(this.attrs[k]) || 0) + Number(v);
      else this.attrs[k] = typeof v === 'string' && /^(rand|price_effect)\(/i.test(v) ? resolveValue(v, price) : v;
    }
    if (target?.entity && ctx.applyTargetData) ctx.applyTargetData(target.entity, c.target);
    this.sendTokens(c.tokens, target, ctx);
    this.updateTriggers();
    this.task.phase = 'completion';
    this.task.gen = this.run(c.exec, target, ctx);
  }

  // Ends the current task (after completion or on failure) and starts its cooldown.
  finish(failed = false) {
    if (!this.task) return;
    const t = this.task.template;
    const delay = t.delayMin + Math.random() * Math.max(0, t.delayMax - t.delayMin);
    if (delay > 0) this.cooldowns.set(t.id, delay);
    else if (failed) this.cooldowns.set(t.id, 5);
    this.task = null;
  }

  // The task could not be carried out (no path, a script said no): its failure behaviors play
  // (usually FailureSet) and it goes on cooldown. Tokens it needed are used up unless retained.
  fail(ctx) {
    if (!this.task) return;
    const task = this.task.template;
    this.consumeTokens(task, true);
    if (ctx && task.failure && this.task.phase === 'exec') {
      this.task.phase = 'failure';
      this.task.failed = false;
      this.task.gen = this.run(task.failure, this.task.target, ctx);
      this.cooldowns.set(task.id, Math.max(5, task.delayMin));
      return;
    }
    this.finish(true);
  }

  // A task that needed tokens (listed under <Objects>) uses them up when it ends.
  consumeTokens(task, failed) {
    for (const name of task.tokens) {
      if (failed && this.tokens.get(name)?.retain) continue;
      this.tokens.delete(name);
      this.tokenPayloads?.delete(name);
    }
  }

  // Behavior player: yields primitive actions from a behavior list element.
  * run(list, target, ctx) {
    if (!list) return;
    for (const b of list.children) {
      yield* this.behavior(b, target, ctx);
      if (this.task?.failed) return;
    }
  }

  * playSet(name, target, ctx) {
    if (/^usecontainer$/i.test(name)) {
      for (const set of ctx.containerSets?.(target, this.task?.template.reserveTag) ?? []) yield* this.playSet(set, target, ctx);
      return;
    }
    const set = this.ai.behaviorSet(name, this.typesSpecificFirst);
    if (set) yield* this.run(set, target, ctx);
  }

  * behavior(b, target, ctx) {
    const a = b.attrs;
    const speed = a.locoSpeed ?? 'medium';
    switch (b.name) {
      // Guests: queue at a stand (walk up to it; the line itself is not simulated yet).
      case 'BFBehDockQueue':
        yield { kind: 'move', target, speed, near: Number(a.hitRadius ?? 2.5) };
        break;
      case 'BFBehWaitQueue':
        yield { kind: 'anim', name: 'Stand_Idle', time: 1 + Math.random() * 2 };
        break;
      // Guests looking at animals: the view meter (viewMeterStart...) runs down while they watch.
      // APPROX: watching lasts viewMeter / 10 seconds; the scoring of the view is the host's.
      case 'ZTBehViewAnimals': {
        const meter = rand(Number(a.viewMeterStartMin ?? a.viewMeterStart ?? 200), Number(a.viewMeterStartMax ?? a.viewMeterStart ?? 200));
        yield { kind: 'view', target, time: meter / 10 };
        // How the view went picks one of the task's emote sets (VA_Path_Neg_10 .. VA_Path_Pos_10):
        // they carry the guest's reaction (animations, emoticon), happiness and departure points.
        const view = ctx.viewScore?.(target);
        const sets = (b.children.find((c) => /^emoteSets$/i.test(c.name))?.children ?? []).map((c) => ({ name: c.name, min: Number(c.attrs.min), max: Number(c.attrs.max) }));
        const pick = view && sets.find((s) => view.score >= s.min && view.score < s.max);
        if (pick) yield* this.playSet(pick.name, view.animal ? { pos: view.animal.pos, entity: view.animal } : target, ctx);
        break;
      }
      // Buying, admission and the like: the host moves the money; "failure" (no money, closed)
      // fails the task.
      case 'ZTBehEconomy':
        if (ctx.economy?.(a.transactionName, target, a) === 'failure' && this.task) this.task.failed = true;
        break;
      case 'BFBehSendTrigger':
        if (a.subjectTrigger) ctx.trigger?.(a.subjectTrigger, target);
        break;
      case 'BFBehMove': case 'BFBehPursuit':
        yield { kind: 'move', target, speed: b.name === 'BFBehPursuit' ? 'fast' : speed, near: Number(a.pathRadius ?? a.hitRadius ?? 0.5) };
        break;
      case 'ZTBehDockFence':
        // Up to the fence on this side. Jumping, climbing, flying or digging under it (the
        // task's name says which) takes the animal across once the next animation has played.
        yield { kind: 'move', target, speed, near: 1 };
        yield { kind: 'face', target };
        if (/jump|climb|under|fly|runthrough/i.test(this.task?.template.name ?? '')) this.crossFence = target;
        break;
      case 'BFBehDock': case 'BFBehDockRadial': case 'BFBehDockTAP': case 'BFBehDockNow': case 'ZTBehDockWater': case 'BFBehEnter':
        // targetNode: a docking spot in the target's model (Dock_Adult at the binoculars): go
        // there and take its facing.
        yield { kind: 'move', target, speed, near: Number(a.dockRadius ?? 0.6), node: a.targetNode ?? null };
        if (a.targetNode) yield { kind: 'face', target, node: a.targetNode };
        if (a.targetAnim) yield { kind: 'anim', name: a.targetAnim, time: 0.3 };
        break;
      case 'BFBehWander': {
        const time = a.playTime !== undefined ? Number(a.playTime) : rand(Number(a.minPlayTime ?? 5), Number(a.maxPlayTime ?? a.minPlayTime ?? 10));
        yield { kind: 'wander', time, speed, avoidWater: a.avoidWater === 'true' };
        break;
      }
      case 'BFBehEvasion':
        yield { kind: 'wander', time: Number(a.evasionTime ?? 5), speed: a.locoSpeed ?? 'medium', avoidWater: true };
        break;
      case 'BFBehAnimate': case 'BFBehAnimateTAP': case 'BFBehAttachObject':
        if (a.targetAnim) yield { kind: 'anim', name: a.targetAnim, time: a.playTime !== undefined ? Number(a.playTime) : null };
        // A bought item goes into the guest's inventory: tasks that list it under <Objects>
        // (eating the burger) can then run, and use it up.
        if (b.name === 'BFBehAttachObject' && a.detachAction === 'inventory' && a.attachEntity) this.receiveToken({ name: a.attachEntity.toLowerCase(), timeout: -1 });
        if (this.crossFence) { yield { kind: 'cross', target: this.crossFence }; this.crossFence = null; }
        break;
      case 'BFBehAnimateRandom': {
        const names = b.children.map((c) => c.attrs.targetAnim ?? c.name).filter(Boolean);
        const name = names.length ? names[Math.floor(Math.random() * names.length)] : a.targetAnim;
        if (name) yield { kind: 'anim', name, time: a.playTime !== undefined ? Number(a.playTime) : null };
        break;
      }
      case 'BFBehPlaySet':
        yield* this.playSet(a.behSet, target, ctx);
        break;
      case 'BFBehSyncSet':
        // Both play together: the target its targetBehSet, this animal its subjectBehSet.
        if (a.targetBehSet && target?.entity?.mind && target.entity !== ctx.selfEntity) target.entity.mind.syncWith(a.targetBehSet, { pos: ctx.selfEntity.pos, entity: ctx.selfEntity });
        if (a.subjectBehSet) yield* this.playSet(a.subjectBehSet, target, ctx);
        break;
      case 'BFBehRandomSet': {
        const sets = (b.children.find((c) => /^randomSets$/i.test(c.name))?.children ?? []).map((c) => [c.name, Number(c.attrs.weight ?? 1)]);
        if (!sets.length) break;
        const plays = Math.round(rand(Number(a.minPlays ?? 1), Number(a.maxPlays ?? a.minPlays ?? 1)));
        for (let i = 0; i < plays; i++) yield* this.playSet(weighted(sets), target, ctx);
        break;
      }
      case 'BFBehLocoSwitchSet': case 'BFBehAnimSwitchSet': {
        const pick = b.children.find((c) => /^(ground|stand|land)$/i.test(c.name)) ?? b.children[0];
        if (pick?.attrs.behSet) yield* this.playSet(pick.attrs.behSet, target, ctx);
        break;
      }
      case 'BFBehFaceTarget':
        yield { kind: 'face', target };
        break;
      case 'ZTBehFeedback': {
        const data = b.children[0]?.children ?? [];
        const action = data.find((c) => c.name === 'ZTActionInfo');
        if (action) this.status = action.attrs.locID;
        const message = data.find((c) => c.name === 'ZTMessageInfo');
        if (message) ctx.message?.(message.attrs.locID, target);
        const emote = data.find((c) => c.name === 'ZTEmoticonInfo');
        if (emote) ctx.emote?.(emote.attrs.emoticonName, Number(emote.attrs.emoticonScale ?? 1));
        const thought = data.find((c) => c.name === 'ZTThoughtInfo');
        if (thought) ctx.thought?.(thought.attrs.locID, target, thought.attrs);
        break;
      }
      case 'BFBehScript':
        // The game's Lua scripts (scripts/*.bin), carried out by the host; "failure" fails the task.
        if (ctx.script?.(a.file, a.function, target) === 'failure' && this.task) this.task.failed = true;
        break;
      case 'ZTBehMorph':
        // morphEntity="target": the target changes (a smashed fence becomes its s_Broken type).
        if (a.morphEntity === 'target') { yield { kind: 'morphTarget', target, type: a.morphTargetEntityType }; break; }
        // Young growing up: becomes the adult entity type, scaling up from initScale.
        yield { kind: 'morph', type: a.morphTargetEntityType, period: Number(a.morphPeriod ?? 0), initScale: a.morphScale === 'true' ? Number(a.initScale ?? 1) : 1 };
        break;
      case 'BFBehKill':
        if (a.killSubject === 'true') yield { kind: 'kill', fade: Number(a.fadeOutPeriod ?? 0) };
        break;
      case 'ZTBehViewEvent': {
        this.lastView = a.viewKey;
        const message = b.children[0]?.children.find((c) => c.name === 'ZTMessageInfo');
        if (message) ctx.message?.(message.attrs.locID, target);
        break;
      }
      case 'BFBehSpawn':
        // Droppings (Poop_BigCat), babies (spawnRelation="child"), dropped items.
        if (a.targetAnim) yield { kind: 'anim', name: a.targetAnim, time: null };
        if (a.spawnEntity) ctx.spawn?.(a.spawnEntity, { child: a.spawnRelation === 'child', offset: Number(a.randomPosOffset ?? 0), fade: Number(a.fadeInPeriod ?? 0) });
        break;
      case 'BFBehSetAttribute':
        // Needs change by the given amount (DeSicken: health -10); other attributes are set.
        for (const c of b.children) {
          const onTarget = c.name === 'BFAITargetData' && target?.entity && target.entity !== ctx.selfEntity;
          if (onTarget) { ctx.applyTargetData?.(target.entity, Object.fromEntries(Object.entries(c.attrs).map(([k, v]) => [k, attrValue(k, v)]))); continue; }
          for (const [k, v] of Object.entries(c.attrs)) {
            if (k in this.needs) this.needs[k] = clamp(this.needs[k] + Number(v), 0, 100);
            // Counters such as a guest's f_departurePoints (100 at arrival, -1 per idle task) add up.
            else if (/^f_/i.test(k) && Number.isFinite(Number(v))) this.attrs[k] = (Number(this.attrs[k]) || 0) + Number(v);
            else this.attrs[k] = attrValue(k, v);
          }
        }
        this.updateTriggers();
        break;
      case 'BFBehSendToken':
        this.sendTokens(parseTokens(b.children.find((c) => c.name === 'BFAITokenList')), target, ctx);
        break;
      default:
        // Primitives with no visible effect yet (head look, spawn, kill, script, morph...).
        break;
    }
  }

  // Tokens unlock tasks that list them under <Objects> (e.g. Sleep gives t_Stretch for 5 s, a
  // chase gives the chased animal t_ChasePlay with the chaser as payload, used as its target).
  sendTokens(tokens, target, ctx) {
    for (const t of tokens ?? []) {
      if (Math.random() * 100 >= t.chance) continue;
      const payload = t.payload === 'subject' ? { entity: ctx.selfEntity } : t.payload === 'target' ? target : null;
      if (t.giveTo === 'subject') this.receiveToken(t, payload);
      else if (t.giveTo === 'target') { if (target?.entity) ctx.giveToken?.(target.entity, t, payload ?? { entity: ctx.selfEntity }); }
      else ctx.broadcastToken?.(t.giveTo, t.radius, t, payload);
    }
  }

  // token: a parsed BFAIToken (or { name, timeout }).
  receiveToken(token, payload) {
    if (token.onlyOne && this.tokens.has(token.name)) return;
    this.tokens.set(token.name, { left: token.timeout < 0 ? Infinity : token.timeout, timein: token.timein ?? 0, retain: Boolean(token.retainOnFailure) });
    if (payload) (this.tokenPayloads ??= new Map()).set(token.name, payload);
  }

  static isTerrainTarget(type) { return TERRAIN_TARGETS.has(type); }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rand = (a, b) => a + Math.random() * Math.max(0, b - a);
function weighted(list) {
  const total = list.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [name, w] of list) { r -= w; if (r <= 0) return name; }
  return list.at(-1)[0];
}
