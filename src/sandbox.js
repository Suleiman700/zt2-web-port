// Sandbox mode: an original Zoo Tycoon 2 map where you can place objects and animals from the game's catalog.
import { openGameFS, usesLocalGameFiles, Assets } from './assets.js';
import { buildCatalog } from './catalog.js';
import { Renderer } from './renderer.js';
import { Camera, raySphere } from './camera.js';
import { TILE } from './terrain.js';
import { parseTerrainDat } from './mapterrain.js';
import { loadBiomes } from './biomes.js';
import { composeTerrainSurface } from './terrainsurface.js';
import { TerrainRenderer, buildWaterModel } from './terrainrender.js';
import { decodeDDS } from './dds.js';
import { TerrainEditor } from './terraintools.js';
import { loadEnvironment, guessEnvironment, lightsAt } from './lighting.js';
import { Sky } from './sky.js';
import { parseZooMap, pathTriangle } from './zoomap.js';
import { GameClock } from './clock.js';
import { ExhibitMap } from './exhibits.js';
import { findPath } from './pathfind.js';
import { AIData } from './aidata.js';
import { attachMind, attachObjectAI, updateAnimalMind, updateHabitatNeeds, relations } from './animals.js';
import { AnimalMind } from './animalmind.js';
import { Ledger, CATEGORY_NAMES } from './economy.js';
import { adjustZooFame, newFameState } from './fame.js';
import { loadValue, saveValue, deleteValue } from './storage.js';
import { nearestCorner, fenceLine, edgeKey, segmentMatrix, postMatrix, isDiagonal, cornerWorld } from './fences.js';
import { PathGrid, pathLine, tileAt, tileKey, triangleCount, TRI } from './paths.js';
import { footprintFor, placeFootprint, placementProblem, Occupancy } from './placement.js';
import { mat4 } from './math.js';
import { computePose, rootTravel } from './skeleton.js';
import { parseEffect, EffectInstance, ParticleRenderer } from './particles.js';
import { Loc } from './ui/loc.js';
import { openFrontEnd } from './menu.js';
import { openLoadDialog, openSaveDialog, openSellConfirm } from './savedialogs.js';
import { openZooStatus } from './zoostatus.js';
import { openWindow } from './windows.js';
import { openZoopedia } from './zoopedia.js';
import { parseXml } from './xml.js';
import { loadGuestTypes, loadGuestConfig, pickLook, guestName } from './guests.js';
import { mountShell } from './hud.js';
import { writeSave, readSave } from './saves.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const renderer = new Renderer(canvas);
const particleRenderer = new ParticleRenderer(renderer.gl);
const camera = new Camera();
camera.minPitch = 0.15;
camera.maxPitch = 1.45;
camera.minDistance = 4;
camera.maxDistance = 250;

const DEFAULT_MAP = 'grassland';
const START_MONEY = 75000;
const SAVE_PREFIX = 'zt2web.sandbox.v2.'; // + map name
const MAP_KEY = 'zt2web.sandbox.map';

let assets, catalog, catalogById;
let terrain = null, waterGpu = null; // terrain: TerrainRenderer
let mapName = DEFAULT_MAP;
let terrainLighting = null; // terrainLights at the current time of day
let mapLights = null;       // the map's parsed world lights (per time of day)
let sky = null;             // sky dome for the map's environment
let skirts = [];            // GPU models of the landscape around the map (environment skirtModels)
// Entities in the map saves sit 6 m above the terrain file's heights; our world uses the .dat
// heights. The skirt models' border is at height 0 and every map's edge is 7 m in its .dat, so
// the skirt is raised to the map's own edge height (skirtZ, read when the map loads).
let skirtMatrix = mat4.fromPosYawScale([0, 0, 7], 0, 1);
let clock = new GameClock();
const entities = [];
const fences = [];       // { uid, item, a: [i, j], b: [i, j], key } fence segments between tile corners
let fenceDrag = null;    // { start: corner } while drawing a fence
const paths = new PathGrid();
let curbs = [];          // curb segments derived from the paths: { a, b, item }
let pathDrag = null;     // { start: tile } while drawing a path
let pathPreview = null;  // { key, gpu } translucent preview of the dragged path
let terrainSurface = null;
const occupancy = new Occupancy();  // 1 m cells taken by placed objects
let waterCells = new Set();         // 0.75 m terrain cells under water
let waterLevels = new Map(); // water cell -> surface height
let footprintPreview = null;        // { key, gpu } footprint cells under the placement ghost
let nextUid = 1;
let money = START_MONEY;
let ledger = new Ledger();
// Zoo status (config/status.xml and economy_*.xml): open or closed, admission price for adults
// (children pay half: adult_admission 24, child_admission 12) and fame (0..100, 10 per half star).
const ZOO_DEFAULTS = { open: true, admission: 24, fame: 10 };
const ADMISSION_LEVELS = { cheap: 10, moderate: 25, expensive: 50 };
// APPROX: the Zoo Status price buttons (free, cheap, moderate, expensive) set the adult price to
// config/status.xml's levels.
const ADMISSION_BY_INDEX = [0, ADMISSION_LEVELS.cheap, ADMISSION_LEVELS.moderate, ADMISSION_LEVELS.expensive];
let zoo = { ...ZOO_DEFAULTS };

// All money changes go through these, so the monthly finances add up.
function pay(amount, category) {
  money = Math.round((money - amount) * 100) / 100;
  ledger.record(category, -amount);
  updateMoney();
}
function receive(amount, category) {
  money = Math.round((money + amount) * 100) / 100;
  ledger.record(category, amount);
  updateMoney();
}

// Value of an object (with its gate) and what removing it gives back.
const valueOf = (e) => (e.item.cost ?? 0) + (e.gate?.cost ?? 0);
const refundOf = (e) => e.item.cost * (e.item.refund ?? 0.8) + (e.gate ? e.gate.cost * (e.gate.refund ?? 0.8) : 0);
let tool = null;        // { item, yaw } while placing
let ghost = null;       // { pos, valid, gpu, scale, model }
let selected = null;
let showGrid = true;
let hoverPoint = null;
let editor = null;       // TerrainEditor for the loaded map
let terrainTool = null;  // { kind, radius, biome, cover, flattenHeight } while sculpting or painting
let painting = false;    // terrain tool held down
let strokeStart = false; // first frame of a terrain stroke
let paintBiomes = [];    // biomes the paint tool offers: { index, name, icon }
let waterTypes = [];     // water looks the water tool offers (the map's biomes, incl. marine)
let mapBiomeDefs = [];   // biome definition per map biome index
let waterTexture = null;
const TERRAIN_KEY = (map) => `terrain.${map}`;
let aiData = null;          // the original AI data (tasks, behaviors, needs), loaded in the background
let aiReady = false;
let actionTexts = new Map(); // animalactions:* -> English text (lang/1033/animal_actions.xml)
const messageTexts = new Map(); // zoomessages:*, animalthoughts:* -> English text (lang/1033)
let exhibits = null;      // ExhibitMap: fenced areas (rebuilt when fences or paths change)
let exhibitsDirty = true;
let mapStart = null;     // the map's starting zoo (maps/default/<name>.zt2) when there is no save

// ---------------------------------------------------------------------------------------
// Startup

$('files').addEventListener('change', (e) => start(e.target.files));
// Local builds load orgfiles/ straight away; production builds wait for the player's files.
if (usesLocalGameFiles()) start(null);
$('viewerLink').href = 'viewer.html' + location.search;

async function start(files) {
  $('picker').hidden = true;
  $('loading').hidden = false;
  try {
    const fs = await openGameFS(files, setLoading);
    assets = new Assets(fs, renderer);
    catalog = await buildCatalog(fs, (i, n) => setLoading(`Reading object catalog… ${Math.round((i / n) * 100)}%`));
    catalogById = new Map(catalog.map((c) => [c.id, c]));
    for (const c of catalog) if (!catalogById.has(c.id.toLowerCase())) catalogById.set(c.id.toLowerCase(), c);

    try { mapName = new URLSearchParams(location.search).get('map') || localStorage.getItem(MAP_KEY) || DEFAULT_MAP; } catch { /* storage unavailable */ }
    await loadMap(fs, mapName);
    aiData = new AIData(fs);
    for (const [type, file] of catalog.typeFiles ?? []) if (!aiData.entityFiles.has(type)) aiData.entityFiles.set(type, file);
    initGuests(fs).catch((err) => console.warn(`Guests: ${err.message}`));
    buildMenu();
    restore();
    // Development aid (?debug): live game state for the automated play-tester.
    if (new URLSearchParams(location.search).has('debug')) {
      window.zt2Debug = {
        entities, fences, paths, occupancy, assets, get exhibits() { return exhibits; },
        spawn: (type, parent, opts) => spawnEntity(type, parent, opts),
        get camera() { return camera; },
        get shell() { return shellUI; },
        select: (e) => select(e),
        info: () => selected && infoData(selected),
        get tool() { return tool; },
        guests,
        get zoo() { return zoo; },
        sights: () => guestSights(),
        speciesViews,
        zoopedia: (entry) => showZoopedia(entry),
        get terrainTool() { return terrainTool; },
        emote: (e, name) => showEmote(e, name),
        get terrain() { return terrain; },
        get skirts() { return skirts; },
        get mapName() { return mapName; },
        get clock() { return clock; },
        // Build without the mouse: a fence through tile corners (one tile per step), an animal at a point.
        build: {
          fence(id, corners) {
            const item = catalogById.get(id.toLowerCase());
            for (let k = 1; k < corners.length; k++) addFence(item, corners[k - 1], corners[k]);
            rebuildCurbs();
          },
          object(id, x, y, yaw = 0) {
            const item = catalogById.get(id.toLowerCase());
            return addEntity({ id: item.id, model: item.model, scale: item.scale, pos: [x, y, terrain.heightAt(x, y)], yaw }).uid;
          },
          // A round pond: water `depth` metres deep with the given radius.
          water(x, y, radius = 4, depth = 3) {
            const style = editor.data.biome[Math.floor(y / editor.data.cellSize) * editor.data.width + Math.floor(x / editor.data.cellSize)];
            editor.paintWater({ kind: 'water', radius, depth, style }, [x, y, terrain.heightAt(x, y)], true);
            editor.update(0);
            rebuildWater();
          },
          animal(id, x, y, variant) {
            const item = catalogById.get(id.toLowerCase());
            const v = item.variants?.find((x) => x.id.toLowerCase() === variant?.toLowerCase()) ?? pickVariant(item);
            return addEntity({ id: item.id, variant: v.id, model: v.model, scale: v.scale, pos: [x, y, terrain.heightAt(x, y)], yaw: 0 }).uid;
          },
        },
      };
    }
    // Development aid: ?cam=x,y,distance,pitch,yaw sets the camera (used for screenshot comparisons).
    const cam = new URLSearchParams(location.search).get('cam');
    if (cam) {
      const [x, y, d, p, yw] = cam.split(',').map(Number);
      camera.target = [x, y, terrain.heightAt(x, y)];
      camera.distance = d;
      if (Number.isFinite(p)) camera.pitch = p;
      if (Number.isFinite(yw)) camera.yaw = yw;
    }
    // Development aid: ?time=0..1 sets the time of day (0 = midnight, 0.5 = midday).
    const time = Number.parseFloat(new URLSearchParams(location.search).get('time'));
    if (Number.isFinite(time)) { clock.t = ((time % 1) + 1) % 1; applyTimeOfDay(); }
    // Development aid: ?money=<amount> sets the zoo's cash (kept in the save).
    const cash = Number.parseFloat(new URLSearchParams(location.search).get('money'));
    if (Number.isFinite(cash)) { money = cash; save(); }
    $('start').hidden = true;
    $('hud').hidden = false;
    $('menu').hidden = false;
    updateMoney();
    renderFame();
    // The original front end (main menu, map selection) over the zoo, on a fresh visit.
    const params = new URLSearchParams(location.search);
    // The main menu opens on start. In the local (development) build, a refresh while playing goes
    // straight back to the zoo; opening the main menu again clears that.
    if (!params.has('map') && !params.has('debug') && !(usesLocalGameFiles() && devResume())) showFrontEnd(fs);
    // The original in-game interface; ?classic keeps the simple development menu instead.
    if (!params.has('classic')) {
      if (usesLocalGameFiles()) document.body.classList.add('dev');
      const loc = await (gameLoc ??= new Loc().load(fs));
      uiLoc = loc;
      $('menu').hidden = true;
      for (const id of ['money', 'fame', 'clock']) $(id).hidden = true;
      document.body.classList.add('shell-on');
      shellUI = await mountShell({ fs, loc, container: document.body, catalog, iconUrl: (it) => (it.icon ? assets.icon(it.icon) : Promise.resolve(null)), onPick: (it) => selectTool(it), onMessage: shellMessage });
      updateMoney(); renderFame(); updateClockText();
      const start = paintBiomes.find((b) => b.index === paintBiome) ?? paintBiomes.find((b) => b.id === 'grassland') ?? paintBiomes[0];
      if (start) { paintBiome = start.index; showBiomeButtons(start.id); }
    }
    // Animal behavior from the game's AI files; animals wander simply until it is ready.
    fs.read('lang/1033/animal_actions.xml').then((b) => {
      for (const m of new TextDecoder('latin1').decode(b).matchAll(/_locID="([^"]+)"[^>]*>([^<]*)</g)) actionTexts.set(m[1].toLowerCase(), m[2].trim());
    }).catch(() => {});
    for (const path of fs.list((k) => /^lang\/1033\/[^/]*(zoo_messages|animal_thoughts)\.xml$/i.test(k))) {
      fs.read(path).then((b) => {
        for (const m of new TextDecoder('latin1').decode(b).matchAll(/_locID="([^"]+)"[^>]*>([^<]*)</g)) messageTexts.set(m[1].toLowerCase(), m[2].trim());
      }).catch(() => {});
    }
    aiData.loadAll().then(() => {
      aiReady = true;
      for (const e of entities) attachAI(e);
      for (const f of fences) attachAI(f);
    }).catch((err) => console.warn(`AI data: ${err.message}`));
  } catch (err) {
    console.error(err);
    setLoading(`Could not load the game files: ${err.message}`);
  }
}

function setLoading(text) { $('loadingText').textContent = text; }

// Loads an original map's terrain (maps/default/<name>.dat) and paints it like the original.
async function loadMap(fs, name) {
  const maps = fs.list((k) => /^maps\/default\/[^/]+\.dat$/.test(k)).map((p) => p.split('/').at(-1).replace(/\.dat$/i, ''));
  if (!maps.some((m) => m.toLowerCase() === name.toLowerCase())) name = DEFAULT_MAP;
  mapName = name.toLowerCase();
  const select = $('mapSelect');
  select.replaceChildren(...maps.sort((a, b) => a.localeCompare(b)).map((m) => {
    const o = document.createElement('option');
    o.value = m.toLowerCase();
    o.textContent = m;
    o.selected = m.toLowerCase() === mapName;
    return o;
  }));

  setLoading('Reading terrain…');
  const data = parseTerrainDat(await fs.read(`maps/default/${mapName}.dat`));
  skirtMatrix = mat4.fromPosYawScale([0, 0, data.heights[0]], 0, 1); // the file's edge, before edits
  const saved = await loadValue(TERRAIN_KEY(mapName));
  if (saved && saved.width === data.width && saved.height === data.height) {
    data.heights.set(saved.heights);
    data.biome.set(saved.biome);
    data.cover.set(saved.cover);
    if (saved.waterRegions) data.waterRegions = saved.waterRegions;
  }
  // The map's original lighting, at midday until the game clock arrives (Phase 3).
  // The map save names its world environment (lights, sky, fog); older maps without one guess it.
  const startFile = `maps/default/${mapName}.zt2`;
  const startText = fs.has(startFile) ? new TextDecoder().decode(await fs.read(startFile)) : null;
  const envPath = /<ZTWorldMgr\b[^>]*\benvironment="([^"]+)"/.exec(startText ?? '')?.[1] ?? guessEnvironment(mapName);
  const environment = await loadEnvironment(fs, envPath.replace(/\\/g, '/'));
  mapLights = environment.lights;
  sky = new Sky(renderer.gl);
  if (environment.skyXml) {
    await sky.load(fs, environment.skyXml);
    await sky.loadSun(fs, environment.skyXml, (path) => assets.model(path)).catch((err) => console.warn(`Sun: ${err.message}`));
  }
  skirts = [];
  for (const xmlPath of environment.skirts) {
    if (!fs.has(xmlPath)) continue;
    const file = /modelfile="([^"]+)"/.exec(new TextDecoder().decode(await fs.read(xmlPath)))?.[1]?.replace(/\\/g, '/');
    const path = file && [file, `${file}.bfb`, `${file}.nif`].find((p) => fs.has(p));
    if (path) assets.model(path).then((m) => { m.gpu.sourcePath = path; m.gpu.cpu = m.model; skirts.push(m.gpu); }).catch((err) => console.warn(`Skirt ${path}: ${err.message}`));
  }
  applyTimeOfDay();
  setLoading('Painting terrain…');
  const biomes = await loadBiomes(fs);
  const loadImage = async (path) => {
    try { return decodeDDS(await fs.read(path)); } catch { return null; }
  };
  const terrainXml = new TextDecoder().decode(await fs.read('world/terrain.xml'));
  const rise = (name, fallback) => Number.parseFloat(new RegExp(`${name}="([\d.]+)`).exec(terrainXml)?.[1] ?? fallback);
  let savedZoo = null;
  try { savedZoo = JSON.parse(localStorage.getItem(SAVE_PREFIX + mapName)); } catch { /* storage unavailable */ }
  for (const [tx, ty, mask, id] of savedZoo?.paths ?? []) {
    const item = catalogById.get(id);
    if (item?.path) paths.add(item, tx, ty, mask);
  }
  // A new zoo starts as the map was made: front gate, zoo wall, entrance paths, plants, rocks.
  mapStart = null;
  if (!savedZoo && startText) {
    mapStart = parseZooMap(startText);
    for (const p of mapStart.paths) {
      const item = catalogById.get(p.type.toLowerCase());
      if (!item?.path) continue;
      const { tx, ty, bit } = pathTriangle(p.pos);
      paths.add(item, tx, ty, bit);
    }
  }
  const surface = await composeTerrainSurface(renderer.gl, data, biomes, loadImage,
    [rise('cliffZPerMeterHoriz', 1.6), rise('cliffZPerMeterDiag', 2.0)], paths);
  surface.setPaths(paths, loadImage);
  terrainSurface = surface;
  rebuildCurbs();
  terrain = new TerrainRenderer(renderer.gl, data, surface);
  exhibits = new ExhibitMap(Math.floor(terrain.size[0] / TILE), Math.floor(terrain.size[1] / TILE));
  exhibitsDirty = true;
  mapBiomeDefs = data.biomeNames.map((n) => biomes.get(n.toLowerCase()) ?? null);
  editor = new TerrainEditor(data, terrain, surface);
  paintBiomes = data.biomeNames
    .map((name, index) => ({ index, name, def: biomes.get(name.toLowerCase()) }))
    .filter((b) => b.def && b.name.toLowerCase() !== 'gridland' && b.name.toLowerCase() !== 'zoodecoration')
    .map((b) => ({ index: b.index, id: b.name.toLowerCase(), name: biomeDisplayName(b.name), icon: b.def.icon }));
  waterTypes = paintBiomes.filter((b) => mapBiomeDefs[b.index]?.water);
  waterTexture = await assets.texture('world/water/water.dds');
  rebuildWater();
  const [w, h] = terrain.size;
  const look = mapStart?.camera?.pos ?? [w / 2, h / 2];
  camera.target = [look[0], look[1], terrain.heightAt(look[0], look[1])];
  camera.distance = 70;
}

// World lights for the clock's time of day (the original interpolates its keys the same way).
function applyTimeOfDay() {
  renderer.lighting = lightsAt(mapLights, 'objectLights', clock.t) ?? renderer.lighting;
  terrainLighting = lightsAt(mapLights, 'terrainLights', clock.t) ?? renderer.lighting;
}

function updateClockText() {
  const hour = clock.hour, h = Math.floor(hour), m = Math.floor((hour - h) * 60);
  $('clockText').textContent = `Year ${clock.year}, month ${clock.monthOfYear} · ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  $('pauseBtn').textContent = clock.paused ? '▶' : '⏸';
  $('pauseBtn').title = clock.paused ? 'Resume (P)' : 'Pause (P)';
  $('pauseBtn').classList.toggle('paused', clock.paused);
  shellUI?.setDate($('clockText').textContent);
  shellUI?.setPaused(clock.paused);
}

// Month end, as in the original: monthly upkeep is charged and the month's finances are closed.
function endOfMonth(month) {
  const upkeep = entities.reduce((sum, e) => sum + (e.item.upkeep ?? 0), 0);
  if (upkeep) pay(upkeep, 'upkeep');
  const totals = ledger.current;
  ledger.closeMonth(month);
  // A snapshot for the Zoo Status graphs.
  zoo.history = [...(zoo.history ?? []), { month, value: zooValue(), fame: zoo.fame, guests: zoo.monthAdmissions ?? 0, members: 0 }].slice(-24);
  zoo.monthAdmissions = 0;
  toast(`Month ${month % 12 + 1} ended: ${formatMoney(Ledger.net(totals))} net`);
  save();
}

function togglePause() {
  clock.paused = !clock.paused;
  updateClockText();
  save();
}
$('pauseBtn').onclick = togglePause;

// Water colour from the biome's water settings (vertexColorLow, alpha), darkened to suit the
// simple water shading used until the original water shader is ported.
function waterColor(style) {
  const c = mapBiomeDefs[style]?.water?.vertexColorLow ?? [180, 220, 215, 150];
  return [c[0] / 255 * 0.3, c[1] / 255 * 0.36, c[2] / 255 * 0.38, 0.82];
}

function rebuildWater() {
  const t = editor ? editor.data : terrain.terrain;
  waterCells = new Set(t.waterRegions.flatMap((r) => r.cells));
  waterLevels = new Map(t.waterRegions.flatMap((r) => r.cells.map((c) => [c, r.height])));
  if (waterGpu) renderer.deleteModel(waterGpu);
  waterGpu = renderer.uploadModel(buildWaterModel(editor ? editor.data : terrain.terrain, waterColor), new Map([['water', waterTexture]]));
}

function isWater(x, y) {
  const t = editor.data, c = t.cellSize;
  return waterCells.has(Math.floor(y / c) * (t.width - 1) + Math.floor(x / c));
}

// Height of the water surface at a point, or null on dry land.
function waterSurfaceAt(x, y) {
  const t = editor.data, c = t.cellSize;
  return waterLevels.get(Math.floor(y / c) * (t.width - 1) + Math.floor(x / c)) ?? null;
}
const waterDepthAt = (x, y) => { const w = waterSurfaceAt(x, y); return w === null ? 0 : Math.max(0, w - terrain.heightAt(x, y)); };

// Where an animal stands: on the ground, or for swimmers in water deep enough to swim, at the
// surface (BFSwimComponent waterInDistance).
function animalHeightAt(e, x, y) {
  const ground = terrain.heightAt(x, y);
  const swim = e.mind?.def.swim;
  if (!swim) return ground;
  const w = waterSurfaceAt(x, y);
  return w !== null && w - ground >= swim.inDepth ? w : ground;
}

const BIOME_NAMES = {
  temperateforest: 'Temperate Forest', borealforest: 'Boreal Forest', tropicalrainforest: 'Tropical Rainforest',
  grassland: 'Grassland', savannah: 'Savannah', scrub: 'Scrub', desert: 'Desert', tundra: 'Tundra',
  alpine: 'Alpine', wetlands: 'Wetlands', coastal: 'Coastal', pelagic: 'Pelagic', reef: 'Reef', benthic: 'Benthic',
};
function biomeDisplayName(name) { return BIOME_NAMES[name.toLowerCase()] ?? name; }

// Terrain edits are kept per map in IndexedDB (too large for localStorage).
let terrainSaveTimer = 0;
function scheduleTerrainSave() {
  clearTimeout(terrainSaveTimer);
  terrainSaveTimer = setTimeout(() => {
    if (!editor?.changed) return;
    const t = editor.data;
    editor.changed = false;
    saveValue(TERRAIN_KEY(mapName), {
      width: t.width, height: t.height, heights: t.heights.slice(), biome: t.biome.slice(), cover: t.cover.slice(),
      waterRegions: t.waterRegions.map((r) => ({ height: r.height, style: r.style, cells: r.cells.slice() })),
    });
  }, 800);
}

// Main menu and map selection (src/menu.js, from the game's own layouts). The zoo pauses and the
// camera turns slowly behind the menu, like the original's animated backdrop.
let frontEnd = null, menuOrbit = false;
const DEV_RESUME_KEY = 'zt2web.dev.inGame';
function devResume(on) {
  try {
    if (on === undefined) return localStorage.getItem(DEV_RESUME_KEY) === '1';
    if (on) localStorage.setItem(DEV_RESUME_KEY, '1'); else localStorage.removeItem(DEV_RESUME_KEY);
  } catch { /* storage unavailable */ }
  return false;
}
async function showFrontEnd(fs) {
  if (frontEnd) return;
  frontEnd = 'opening';
  devResume(false);
  const loc = await (gameLoc ??= new Loc().load(fs));
  const wasPaused = clock.paused;
  clock.paused = true;
  menuOrbit = true;
  for (const id of ['hud', 'menu']) $(id).hidden = true;
  frontEnd = await openFrontEnd({
    fs, loc, container: document.body,
    onPlay(map) {
      devResume(true);
      try { localStorage.setItem(MAP_KEY, map); } catch { /* storage unavailable */ }
      if (map.toLowerCase() === mapName.toLowerCase()) return;
      const url = new URL(location.href);
      url.searchParams.set('map', map);
      location.href = url.toString();
    },
    onLoadMenu() { showSaveLoad('load'); },
    onClose() {
      frontEnd = null;
      menuOrbit = false;
      clock.paused = wasPaused;
      $('hud').hidden = false;
      if (!shellUI) $('menu').hidden = false; // the original interface has its own build panels
    },
  });
}
let gameLoc = null;
let shellUI = null;
let uiLoc = null; // the game's strings once loaded (gameLoc is the loading promise)
const L = (id) => (uiLoc?.has(id) ? uiLoc.text(id) : '');
let followed = null; // entity the camera follows (info panel's track button)

// Engine messages from the original in-game interface (shell.xml) mapped to the game's tools.
const cameraHold = { zoom: 0, rotate: 0 };
// View filters (shell: ZT_VIEWFILTER_HIDE / SHOW) and the delete tool (mode_deletion).
const hiddenKinds = new Set();
let deleteMode = false;
const FOLIAGE = /^(plant|tree|foliage|shrub|grass|flower|marineplant)$/i;
function hiddenByFilter(e) {
  if (!hiddenKinds.size) return false;
  for (const t of e.item.types ?? []) {
    const k = t.toLowerCase();
    if (hiddenKinds.has(k) || (hiddenKinds.has('foliage') && FOLIAGE.test(k))) return true;
  }
  return false;
}
let flattenOffset = 0;
const DEFORM_KINDS = new Set(['raise', 'lower', 'smooth', 'flatten']);
let lastDeform = { kind: 'raise', offset: 0 }; // the deformation tool chosen last (Hill at first)
let lastBiomeTool = 'paint';
const biomeButtonXml = new Map(); // biome id -> its "Biome" toggle set from biomes/<id>.xml
async function showBiomeButtons(id) {
  if (!shellUI) return;
  if (!biomeButtonXml.has(id)) {
    const path = assets.fs.list((k) => k === `biomes/${id}.xml`)[0];
    const root = path ? parseXml(new TextDecoder('latin1').decode(await assets.fs.read(path))) : null;
    const find = (el) => (el?.name === 'UIToggleSet' && el.attrs.name === 'Biome' ? el : el?.children?.map(find).find(Boolean) ?? null);
    biomeButtonXml.set(id, find(root));
  }
  shellUI.setBiomeButtons(biomeButtonXml.get(id));
}
const TERRAIN_MODES = { hill: 'raise', valley: 'lower', smooth: 'smooth', flatten: 'flatten' };
function shellMessage(msg, a) {
  const v = String(a.string ?? '').toLowerCase();
  switch (msg) {
    case 'ZT_SET_GENDER':
      animalSex = v === 'male' ? 'male' : 'female';
      if (tool?.item?.isAnimal) { const item = tool.item; tool.variant = pickVariant(item); assets.model(tool.variant.model).then((m) => { if (tool?.item === item) ghost = { ...ghost, gpu: m.gpu }; }); }
      updateBuyInfo();
      break;
    case 'ZT_SETMODE':
      if (v === 'mode_save') { showSaveLoad('save'); break; }
      if (v === 'deepwater' || v === 'shallowwater') {
        waterDeep = v === 'deepwater';
        waterStyle = paintBiome;
        selectTerrainTool('water', { toggle: false });
        lastBiomeTool = 'water';
        break;
      }
      // APPROX: "mix" (ground and cover blended by the biome's mix mask) paints as cover.
      if (v === 'ground' || v === 'ground-cover' || v === 'mix') {
        paintCover = v !== 'ground';
        selectTerrainTool('paint', { toggle: false });
        lastBiomeTool = 'paint';
        break;
      }
      // Landscaping modes start with their current tool (Hill, or the last chosen brush).
      if (v === 'mode_deformation') { if (!terrainTool || !DEFORM_KINDS.has(terrainTool.kind)) { selectTerrainTool(lastDeform.kind, { toggle: false }); terrainTool.flattenOffset = lastDeform.offset; } break; }
      if (v === 'mode_biome') { if (!terrainTool || DEFORM_KINDS.has(terrainTool.kind)) selectTerrainTool(lastBiomeTool, { toggle: false }); break; }
      deleteMode = v === 'mode_deletion';
      if (v === 'mode_selection' || deleteMode) { cancelTool(); cancelTerrainTool(); }
      if (deleteMode) toast('Click objects to remove them (80% refund) · Esc to stop');
      break;
    case 'ZT_VIEWFILTER_HIDE': hiddenKinds.add(v); break;
    case 'ZT_VIEWFILTER_SHOW': hiddenKinds.delete(v); break;
    // Landscaping: hill, valley, smooth, flatten; cliff and ditch are flatten 3.5 m above or below
    // where the stroke starts (ZT_SETTERRAINFLATTEN_HEIGHT).
    case 'ZT_SETTERRAINFLATTEN_HEIGHT': flattenOffset = Number(a.value ?? a.string ?? 0) || 0; break;
    case 'ZT_SETTERRAINMODE':
      if (TERRAIN_MODES[v]) {
        if (v !== 'flatten') flattenOffset = 0;
        selectTerrainTool(TERRAIN_MODES[v], { toggle: false });
        terrainTool.flattenOffset = flattenOffset;
        lastDeform = { kind: TERRAIN_MODES[v], offset: flattenOffset };
      }
      break;
    // A biome's paint buttons come from its own file (biomes/<name>.xml): water and ground brushes.
    case 'ZT_SET_BIOME': {
      const b = paintBiomes.find((x) => x.id === v);
      if (b) { paintBiome = b.index; if (terrainTool) terrainTool.biome = b.index; }
      showBiomeButtons(v);
      break;
    }
    case 'ZT_PAUSE': clock.paused = v === 'pause'; updateClockText(); break;
    case 'ZT_CAMERA_ZOOM': cameraHold.zoom = v === 'in' ? -1 : v === 'out' ? 1 : 0; break;
    case 'ZT_CAMERA_ROTATE': cameraHold.rotate = v === 'left' ? 1 : v === 'right' ? -1 : 0; break;
    case 'ZT_UNDOACTION': undo(); break;
    case 'ZT_TERRAINCURSOR_SIZE': changeBrush(v === '+' ? 1 : -1); break;
    case 'ZT_OBJECT_ROTATE': if (tool && !tool.path && !tool.fence) tool.yaw += (v === 'left' ? 1 : -1) * Math.PI / 4; break;
    // Info panel: close, rename, sell (after the original confirmation), follow with the camera.
    case 'ZT_SET_SELECTED_ENTITY': select(null); break;
    // A stand's price buttons (Cheap / Moderate / Expensive): the price its items sell at.
    case 'ZT_SET_PRICE_INDEX': {
      const index = { cheap: 0, moderate: 1, expensive: 2 }[String(a.sourceName ?? '').toLowerCase()];
      if (selected && index !== undefined && selected.ai?.transactions?.buy_item?.choices) { selected.priceIndex = index; save(); }
      break;
    }
    case 'ZT_SELECT_ENTITY_UID': { const o = entities.find((x) => x.uid === a.x); if (o) select(o); break; }
    case 'ZT_SET_ENTITY_NAME':
      if (selected?.guest && v.trim()) selected.name = String(a.string).trim().slice(0, 20);
      else if (selected?.item.isAnimal && v.trim()) { selected.name = String(a.string).trim().slice(0, 30); save(); }
      break;
    // APPROX: putting an animal up for adoption sells it back (with the usual confirmation);
    // releasing it to the wild lets it go without a refund.
    case 'ZT_ANIMAL_RELEASE_WILD':
      if (selected?.item.isAnimal) { const e = selected; checkpoint(); removeEntity(e); zoo.released = (zoo.released ?? 0) + 1; toast(`${animalName(e)} was released into the wild`); save(); }
      break;
    case 'ZT_ANIMAL_RELEASE_ZOO':
    case 'ZT_UPDATE_SELL_MESSAGE': {
      const e = selected;
      if (!e || isProtected(e.item) || dialogOpen) break;
      dialogOpen = true;
      openSellConfirm({ fs: assets.fs, loc: uiLoc, shared: shellUI?.view.engine, name: e.item.isAnimal ? animalName(e) : e.item.name, refund: formatMoney(refundOf(e)),
        onSell: () => { dialogOpen = false; if (selected === e) sellSelected(); }, onClose: () => { dialogOpen = false; } })
        .catch((err) => { dialogOpen = false; console.warn(`Sell dialog: ${err.stack}`); });
      break;
    }
    case 'ZT_START_FOLLOWCAM': followed = selected; break;
    case 'ZT_STOP_FOLLOWCAM': followed = null; break;
    case 'UI_CHILD_MISSING':
      // The Zoo Status window is its own layout, opened on top of the shell.
      if (a.msg !== 'UI_SHOW') break;
      if (/^zoo status layout$/i.test(a.name)) showZooStatus();
      // In-game options: Load (asks to save first in the original), return to the main menu, exit.
      else if (/^save current game$/i.test(a.name)) showSaveLoad('load');
      else if (/^(return_mainmenu|exit game layout|exit_zoo)$/i.test(a.name)) showFrontEnd(assets.fs);
      break;
    case 'ZT_REQUEST_IN_GAME_OPTIONS': showInGameOptions(); break;
    case 'ZT_OPEN_ZOOPEDIA': showZoopedia(a.string); break;
    case 'ZT_EXITTOMAINMENU': showFrontEnd(assets.fs); break;
    // Zoo Status window.
    case 'ZT_SET_ADMISSION_PRICE_INDEX': zoo.admission = ADMISSION_BY_INDEX[Number(a.x)] ?? zoo.admission; save(); break;
    case 'ZT_ZOO_OPEN': zoo.open = Number(a.x) === 1; save(); break;
    case 'ZT_SET_ZOO_NAME': zoo.name = String(a.string ?? '').slice(0, 32); save(); break;
    default: break;
  }
}
$('mainMenuButton').onclick = () => showFrontEnd(assets.fs);

$('mapSelect').addEventListener('change', (e) => {
  try { localStorage.setItem(MAP_KEY, e.target.value); } catch { /* storage unavailable */ }
  const url = new URL(location.href);
  url.searchParams.set('map', e.target.value);
  devResume(true);
  location.href = url.toString();
});

// ---------------------------------------------------------------------------------------
// Build menu

const GROUP_ORDER = ['Terrain', 'Fences', 'Paths', 'Animals', 'Plants', 'Rocks', 'Scenery', 'Buildings', 'Animal care'];
let activeGroup = 'Animals';

function buildMenu() {
  const tabs = $('tabs');
  for (const g of GROUP_ORDER) {
    const b = document.createElement('button');
    b.textContent = g;
    b.dataset.group = g;
    b.onclick = () => { activeGroup = g; $('search').value = ''; renderItems(); };
    tabs.append(b);
  }
  $('search').addEventListener('input', renderItems);
  renderItems();
}

const iconObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const img = e.target;
    iconObserver.unobserve(img);
    assets.icon(img.dataset.icon).then((url) => { if (url) img.src = url; });
  }
}, { root: null, rootMargin: '200px' });

function renderItems() {
  updateBuyInfo();
  const q = $('search').value.toLowerCase().trim();
  for (const b of $('tabs').children) b.classList.toggle('active', !q && b.dataset.group === activeGroup);
  if (!q && activeGroup === 'Terrain') { renderTerrainTools(); return; }
  const list = catalog.filter((c) => !c.hidden && (q ? c.name.toLowerCase().includes(q) : c.group === activeGroup));
  const grid = $('items');
  grid.replaceChildren();
  if (!q && activeGroup === 'Fences') grid.append(gateToolCard());
  if (!q && activeGroup === 'Paths') grid.append(removePathCard());
  if (list.some((c) => c.isAnimal)) grid.append(sexToggle());
  for (const item of list) {
    const b = document.createElement('button');
    b.className = 'item';
    b.title = item.name;
    if (tool?.item === item) b.classList.add('active');
    const img = document.createElement('img');
    img.alt = '';
    img.dataset.icon = item.icon;
    iconObserver.observe(img);
    const name = document.createElement('span');
    name.textContent = item.name;
    const cost = document.createElement('small');
    cost.textContent = formatMoney(item.cost);
    b.append(img, name, cost);
    b.onclick = () => selectTool(item);
    grid.append(b);
  }
}

// Female / Male toggles with the original icons (UI/maingame/buttons_filtertypes.dds; the
// rects of shell.xml's "buy animal gender toggleset": normal and activated frames).
const SEX_ICONS = { female: [[0, 256], [64, 256]], male: [[128, 128], [192, 128]] };
function sexToggle() {
  const bar = document.createElement('div');
  bar.className = 'sex-toggle';
  for (const sex of ['female', 'male']) {
    const b = document.createElement('button');
    const on = animalSex === sex;
    b.className = on ? 'active' : '';
    b.title = sex === 'female' ? 'Female animals' : 'Male animals';
    b.setAttribute('aria-pressed', String(on));
    const img = document.createElement('img');
    img.alt = '';
    const [x, y] = SEX_ICONS[sex][on ? 1 : 0];
    // The glyph sits in the middle of its 64x64 cell; crop to it so it reads at button size.
    assets.sprite('ui/maingame/buttons_filtertypes.dds', x + 14, y + 18, 36, 28).then((url) => { if (url) img.src = url; });
    const label = document.createElement('span');
    label.textContent = sex === 'female' ? 'Female' : 'Male';
    b.append(img, label);
    b.onclick = () => {
      animalSex = sex;
      try { localStorage.setItem('zt2.animalSex', sex); } catch { /* storage unavailable */ }
      if (tool?.item?.isAnimal) {
        const item = tool.item;
        tool.variant = pickVariant(item);
        assets.model(tool.variant.model).then((m) => { if (tool?.item === item) ghost = { ...ghost, gpu: m.gpu }; });
      }
      renderItems();
    };
    bar.append(b);
  }
  return bar;
}

const TERRAIN_TOOLS = [
  { kind: 'raise', name: 'Raise' }, { kind: 'lower', name: 'Lower' }, { kind: 'smooth', name: 'Smooth' },
  { kind: 'flatten', name: 'Flatten' }, { kind: 'paint', name: 'Paint biome' },
  { kind: 'water', name: 'Add water' }, { kind: 'drain', name: 'Remove water' },
];
const SCULPT_TOOLS = new Set(['raise', 'lower', 'smooth', 'flatten']);
let waterStyle = null;   // water look (biome index); null = match the ground where the stroke starts
let waterDeep = false;   // original: separate Shallow Water and Deep Water brushes per biome
let terrainStrength = 1; // sculpting intensity
let sinceWaterRebuild = 0;
let terrainRadius = 4;
let paintBiome = null, paintCover = true;

function renderTerrainTools() {
  const grid = $('items');
  grid.replaceChildren();
  const panel = document.createElement('div');
  panel.className = 'terrain-tools';

  const tools = document.createElement('div');
  tools.className = 'tool-row';
  for (const t of TERRAIN_TOOLS) {
    const b = document.createElement('button');
    b.textContent = t.name;
    b.className = 'tool' + (terrainTool?.kind === t.kind ? ' active' : '');
    b.onclick = () => selectTerrainTool(t.kind);
    tools.append(b);
  }

  const sizeRow = document.createElement('label');
  sizeRow.className = 'size-row';
  const sizeText = document.createElement('span');
  sizeText.textContent = `Brush size: ${terrainRadius} m`;
  const size = document.createElement('input');
  size.type = 'range';
  size.min = '1';
  size.max = '20';
  size.value = String(terrainRadius);
  size.oninput = () => {
    terrainRadius = Number(size.value);
    sizeText.textContent = `Brush size: ${terrainRadius} m`;
    if (terrainTool) terrainTool.radius = terrainRadius;
  };
  sizeRow.append(sizeText, size);
  panel.append(tools, sizeRow);

  if (!terrainTool || SCULPT_TOOLS.has(terrainTool.kind)) {
    const strengthRow = document.createElement('label');
    strengthRow.className = 'size-row';
    const strengthText = document.createElement('span');
    const label = () => `Strength: ${Math.round(terrainStrength * 100)}%`;
    strengthText.textContent = label();
    const strength = document.createElement('input');
    strength.type = 'range';
    strength.min = '10';
    strength.max = '200';
    strength.step = '10';
    strength.value = String(Math.round(terrainStrength * 100));
    strength.oninput = () => {
      terrainStrength = Number(strength.value) / 100;
      strengthText.textContent = label();
      if (terrainTool) terrainTool.strength = terrainStrength;
    };
    strengthRow.append(strengthText, strength);
    panel.append(strengthRow);
  }

  if (terrainTool?.kind === 'paint') {
    const coverRow = document.createElement('label');
    coverRow.className = 'size-row';
    const cover = document.createElement('input');
    cover.type = 'checkbox';
    cover.checked = paintCover;
    cover.onchange = () => { paintCover = cover.checked; terrainTool.cover = paintCover; };
    coverRow.append(cover, ' Ground cover (grass, plants)');
    const biomeGrid = document.createElement('div');
    biomeGrid.className = 'biome-grid';
    for (const b of paintBiomes) {
      const btn = document.createElement('button');
      btn.className = 'item' + (terrainTool.biome === b.index ? ' active' : '');
      btn.title = b.name;
      const img = document.createElement('img');
      img.alt = '';
      if (b.icon) assets.icon(b.icon, false).then((url) => { if (url) img.src = url; });
      const name = document.createElement('span');
      name.textContent = b.name;
      btn.append(img, name);
      btn.onclick = () => { paintBiome = b.index; terrainTool.biome = b.index; renderTerrainTools(); };
      biomeGrid.append(btn);
    }
    panel.append(coverRow, biomeGrid);
  }
  if (terrainTool?.kind === 'water') {
    const hint = document.createElement('p');
    hint.className = 'size-row';
    hint.textContent = 'Paint water onto the land; the ground is dug out under it. Start inside a lake to extend it.';
    const depthRow = document.createElement('div');
    depthRow.className = 'tool-row';
    for (const [deep, label] of [[false, 'Shallow water'], [true, 'Deep water']]) {
      const b = document.createElement('button');
      b.className = 'tool' + (waterDeep === deep ? ' active' : '');
      b.textContent = label;
      b.onclick = () => { waterDeep = deep; renderTerrainTools(); };
      depthRow.append(b);
    }
    const typeLabel = document.createElement('p');
    typeLabel.className = 'size-row';
    typeLabel.textContent = 'Water type:';
    const typeGrid = document.createElement('div');
    typeGrid.className = 'biome-grid';
    const options = [{ index: null, name: 'Match the ground', icon: null }, ...waterTypes];
    for (const b of options) {
      const btn = document.createElement('button');
      btn.className = 'item' + (waterStyle === b.index ? ' active' : '');
      btn.title = b.name;
      const img = document.createElement('img');
      img.alt = '';
      if (b.icon) assets.icon(b.icon, false).then((url) => { if (url) img.src = url; });
      const name = document.createElement('span');
      name.textContent = b.name;
      btn.append(img, name);
      btn.onclick = () => { waterStyle = b.index; renderTerrainTools(); };
      typeGrid.append(btn);
    }
    panel.append(hint, depthRow, typeLabel, typeGrid);
  }
  grid.append(panel);
}

function selectTerrainTool(kind, { toggle = true } = {}) {
  if (toggle && terrainTool?.kind === kind) { cancelTerrainTool(); return; }
  cancelTool();
  select(null);
  paintBiome ??= paintBiomes[0]?.index ?? 0;
  terrainTool = { kind, radius: terrainRadius, strength: terrainStrength, biome: paintBiome, cover: paintCover, flattenHeight: 0 };
  renderItems();
  toast('Hold the mouse button (or one finger) on the map to use the tool · Esc to stop');
}

function cancelTerrainTool() {
  terrainTool = null;
  painting = false;
  if (terrain) terrain.brush = null;
  renderItems();
}

// The original fence menu has one Gate button: it turns a clicked fence segment into that
// fence type's own gate (e.g. chain link -> chainlinkgate).
const GATE_ICON = 'entities/objects/fences/staffgate_df/staffgate_icon.dds';
function gateToolCard() {
  const b = document.createElement('button');
  b.className = 'item' + (tool?.gateTool ? ' active' : '');
  b.title = 'Gate';
  const img = document.createElement('img');
  img.alt = '';
  assets.icon(GATE_ICON).then((url) => { if (url) img.src = url; });
  const name = document.createElement('span');
  name.textContent = 'Gate';
  const hint = document.createElement('small');
  hint.textContent = 'Click a fence';
  b.append(img, name, hint);
  b.onclick = () => {
    if (tool?.gateTool) { cancelTool(); return; }
    cancelTool();
    select(null);
    terrainTool = null;
    tool = { gateTool: true };
    renderItems();
    toast('Gate: click a straight fence segment to put a gate in it · Esc to stop');
  };
  return b;
}

function removePathCard() {
  const b = document.createElement('button');
  b.className = 'item' + (tool?.removePath ? ' active' : '');
  b.title = 'Remove path';
  const img = document.createElement('img');
  img.alt = '';
  assets.icon('UI/cursor_texture/recycle.dds', false).then((url) => { if (url) img.src = url; });
  const name = document.createElement('span');
  name.textContent = 'Remove path';
  const hint = document.createElement('small');
  hint.textContent = 'Drag over a path';
  b.append(img, name, hint);
  b.onclick = () => {
    if (tool?.removePath) { cancelTool(); return; }
    cancelTool();
    select(null);
    terrainTool = null;
    tool = { removePath: true, path: true };
    renderItems();
    toast('Remove path: drag over a path to remove it (half the cost back) · Esc to stop');
  };
  return b;
}

// Curbs follow the path borders, except where a fence already stands on that edge.
function rebuildCurbs() {
  exhibitsDirty = true;
  const fenceEdges = new Set(fences.map((f) => f.key));
  curbs = [];
  for (const c of paths.curbEdges()) {
    const curbItem = c.item.path.curb && catalogById.get(c.item.path.curb.toLowerCase());
    if (!curbItem || fenceEdges.has(edgeKey(c.a, c.b))) continue;
    curbs.push({ a: c.a, b: c.b, item: curbItem });
    fenceModels(curbItem).catch(() => {});
  }
}

// Applies a dragged path line: adds (or removes) triangles, pays (or refunds) per triangle,
// then repaints the touched ground and rebuilds the curbs.
async function applyPathLine(start, point) {
  const line = pathLine(start, point);
  checkpoint();
  let changed = 0, short = false;
  if (tool.removePath) {
    for (const t of line) {
      const tile = paths.tiles.get(`${t.tx},${t.ty}`);
      if (!tile) continue;
      const refund = tile.item.cost * (tile.item.refund ?? 0.8);
      const n = paths.remove(t.tx, t.ty, t.mask);
      receive(n * refund, 'recycling');
      changed += n;
    }
  } else {
    const item = tool.item;
    for (const t of line) {
      if (!inBounds([(t.tx + 0.5) * TILE, (t.ty + 0.5) * TILE])) continue;
      const tile = paths.tiles.get(`${t.tx},${t.ty}`);
      const newTriangles = triangleCount(t.mask & ~(tile?.mask ?? 0));
      if (money < newTriangles * item.cost) { short = true; break; }
      const n = paths.add(item, t.tx, t.ty, t.mask);
      pay(n * item.cost, 'construction');
      changed += n;
    }
  }
  updateMoney();
  if (short) toast('Not enough money for the whole path');
  if (!changed) return;
  await terrainSurface.preparePaths();
  const xs = line.map((t) => t.tx), ys = line.map((t) => t.ty);
  terrainSurface.refresh(Math.min(...xs) * 4 - 1, Math.min(...ys) * 4 - 1, (Math.max(...xs) + 1) * 4 + 1, (Math.max(...ys) + 1) * 4 + 1);
  terrainSurface.updateMipmaps();
  rebuildCurbs();
  save();
}

// Translucent preview of the dragged path: the triangles a release would add.
function updatePathPreview(start, point) {
  const [hx, hy] = tileAt(point);
  const line = start ? pathLine(start, point) : [{ tx: hx, ty: hy, mask: 15 }];
  const key = line.map((t) => `${t.tx},${t.ty},${t.mask}`).join(';');
  if (pathPreview?.key === key) return;
  if (pathPreview) renderer.deleteModel(pathPreview.gpu);
  const pos = [], nor = [], idx = [];
  const v = (x, y) => { pos.push(x, y, terrain.heightAt(x, y) + 0.06); nor.push(0, 0, 1); return pos.length / 3 - 1; };
  for (const t of line) {
    const x0 = t.tx * TILE, y0 = t.ty * TILE, x1 = x0 + TILE, y1 = y0 + TILE, mx = x0 + TILE / 2, my = y0 + TILE / 2;
    const tris = [];
    if (t.mask & TRI.N) tris.push([x0, y1, x1, y1]);
    if (t.mask & TRI.S) tris.push([x0, y0, x1, y0]);
    if (t.mask & TRI.E) tris.push([x1, y0, x1, y1]);
    if (t.mask & TRI.W) tris.push([x0, y0, x0, y1]);
    for (const [ax, ay, bx, by] of tris) idx.push(v(ax, ay), v(bx, by), v(mx, my));
  }
  const tint = tool.removePath ? [0.9, 0.3, 0.3] : [0.95, 0.9, 0.6];
  pathPreview = {
    key,
    gpu: renderer.uploadModel({
      meshes: [{
        positions: new Float32Array(pos), normals: new Float32Array(nor), uvs: null, colors: null,
        indices: new Uint16Array(idx), texture: null, node: null, skin: null,
        material: { diffuse: tint, ambient: tint, emissive: tint.map((c) => c * 0.5), alpha: 0.5 },
        alphaBlend: true, alphaTest: false, alphaThreshold: 0, doubleSided: true,
      }],
      bounds: { min: [0, 0, 0], max: [0, 0, 0] }, skeleton: null,
    }, new Map()),
  };
}

// Gate models: the frame (fence pieces) plus the animated door, posed closed.
function gateModels(gateItem) {
  gateItem.gateGpu ??= (async () => {
    const frame = await fenceModels(gateItem);
    const bfm = new TextDecoder().decode(await assets.fs.read(gateItem.gateActor));
    const modelPath = /modelname="([^"]+)"/.exec(bfm)?.[1];
    const door = modelPath ? await assets.model(modelPath) : null;
    let pose;
    if (door) {
      const anims = await assets.actor(gateItem.gateActor);
      const closePath = anims.get('bip01_close');
      const close = closePath ? await assets.animation(closePath) : null;
      if (close) pose = computePose(door.model.skeleton, close, close.duration, []);
    }
    return (gateItem.gateLoaded = { frame, door: door?.gpu ?? null, doorPose: pose });
  })();
  return gateItem.gateGpu;
}

function addGate(f, gateItem) {
  f.gate = gateItem;
  gateModels(gateItem).catch((err) => console.warn(err));
}

function useGateTool(ray) {
  const f = pickFence(ray)?.fence;
  if (!f) { toast('Click on a fence segment'); return; }
  if (f.gate) { toast('This segment already has a gate'); return; }
  if (isDiagonal(f.a, f.b)) { toast('Gates go in straight fence segments'); return; }
  const gateItem = f.item.fence.gate && catalogById.get(f.item.fence.gate);
  if (!gateItem) { toast(`${f.item.name} has no gate`); return; }
  if (money < gateItem.cost) { toast('Not enough money'); return; }
  checkpoint();
  pay(gateItem.cost, 'construction');
  updateMoney();
  addGate(f, gateItem);
  save();
}

// ---------------------------------------------------------------------------------------
// Placing, selecting, selling

function selectTool(item) {
  if (tool?.item === item) { cancelTool(); return; }
  select(null);
  terrainTool = null;
  painting = false;
  ghost = null;
  fenceDrag = null;
  if (item.path) {
    tool = { item, path: true };
    renderItems();
    toast(`${item.name}: drag to draw a path · Esc to stop`);
    return;
  }
  if (item.fence) {
    tool = { item, fence: true };
    fenceModels(item).catch((err) => toast(`Can't load ${item.name}: ${err.message}`));
    renderItems();
    toast(`${item.name}: drag from a tile corner to draw a fence · Esc to stop`);
    return;
  }
  tool = { item, yaw: item.placement?.randomRotate ? randomEighth() : tool?.yaw ?? 0, variant: pickVariant(item) };
  assets.model(tool.variant.model).then((m) => {
    if (tool?.item === item) ghost = { gpu: m.gpu, pos: hoverPoint, valid: false };
  }).catch((err) => toast(`Can't load ${item.name}: ${err.message}`));
  renderItems();
  toast(`${item.name}: click to place · R to rotate · Esc to stop`);
}

const randomEighth = () => Math.floor(Math.random() * 8) * (Math.PI / 4);

function cancelTool() {
  tool = null;
  ghost = null;
  fenceDrag = null;
  pathDrag = null;
  if (pathPreview) { renderer.deleteModel(pathPreview.gpu); pathPreview = null; }
  renderItems();
}

// Where the current tool's object would go at `point`, and whether that is allowed.
function evaluatePlacement(point) {
  const { item, variant } = tool;
  const rules = item.placement;
  if (!rules || item.isAnimal || !ghost?.gpu) return { pos: point, yaw: tool.yaw, cells: [], problem: inBounds(point) ? null : 'Outside the zoo' };
  const fp = footprintFor(rules, ghost.gpu.bounds, variant.scale);
  const placed = placeFootprint(fp, point, tool.yaw, rules.gridSnap);
  placed.pos[2] = terrain.heightAt(placed.pos[0], placed.pos[1]);
  placed.problem = placementProblem(rules, placed.cells, { size: terrain.size, occupancy, isWater });
  return placed;
}

// Translucent squares on the ground for the footprint cells, green if the placement is allowed.
function updateFootprintPreview(cells, ok) {
  const key = `${ok}|${cells.map((c) => c.join(',')).join(';')}`;
  if (footprintPreview?.key === key) return;
  if (footprintPreview) renderer.deleteModel(footprintPreview.gpu);
  footprintPreview = null;
  if (!cells.length) return;
  const pos = [], nor = [], idx = [];
  for (const [x, y] of cells) {
    const base = pos.length / 3;
    for (const [cx, cy] of [[x + 0.05, y + 0.05], [x + 0.95, y + 0.05], [x + 0.95, y + 0.95], [x + 0.05, y + 0.95]]) {
      pos.push(cx, cy, terrain.heightAt(cx, cy) + 0.05);
      nor.push(0, 0, 1);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const color = ok ? [0.3, 0.9, 0.35] : [0.95, 0.25, 0.2];
  footprintPreview = {
    key,
    gpu: renderer.uploadModel({
      meshes: [{
        positions: new Float32Array(pos), normals: new Float32Array(nor), uvs: null, colors: null,
        indices: pos.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), texture: null, node: null, skin: null,
        material: { diffuse: color, ambient: color, emissive: color.map((v) => v * 0.6), alpha: 0.45 },
        alphaBlend: true, alphaTest: false, alphaThreshold: 0, doubleSided: true,
      }],
      bounds: { min: [0, 0, 0], max: [0, 0, 0] }, skeleton: null,
    }, new Map()),
  };
}

// Levels the ground under a placed object to its height (ZTPlacementData terrainFlatten).
function flattenUnder(cells, height) {
  const t = editor.data, c = t.cellSize, W = t.width;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of cells) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1); }
  const sx0 = Math.max(0, Math.floor(x0 / c)), sx1 = Math.min(W - 1, Math.ceil(x1 / c));
  const sy0 = Math.max(0, Math.floor(y0 / c)), sy1 = Math.min(t.height - 1, Math.ceil(y1 / c));
  for (let sy = sy0; sy <= sy1; sy++) for (let sx = sx0; sx <= sx1; sx++) t.heights[sy * W + sx] = height;
  terrain.updateRegion(sx0, sy0, sx1, sy1);
  editor.queueSurface(sx0, sy0, sx1, sy1);
  editor.changed = true;
  scheduleTerrainSave();
}

// Extra model parts (vendors, signs, ...) attached to nodes of their parent part, as in the
// original's physObjParenting. Parts that stand for a state (BFGPhysAnimController) show only
// in that state; a shop's "used" state waits for guests (Phase 5).
function loadParts(e) {
  e.parts = [];
  const states = e.item.partStates;
  if (states) e.partState = { current: states.defaultState, timer: nextStatePeriod(states) };
  for (const def of e.item.parts ?? []) {
    const stateName = states?.states.find((s) => s.child?.toLowerCase() === def.name.toLowerCase())?.name ?? null;
    if (def.name.toLowerCase() === 'mainobj') continue; // the entity's own model
    const fade = e.item.fadeStates?.states.find((f) => f.part === def.name.toLowerCase()) ?? null;
    if (!def.parent && !fade && !stateName) continue; // unlinked binders that are not states
    const part = { def, stateName, fade, gpu: null, skeleton: null, clip: null, clipTime: Math.random() * 2, pose: [] };
    e.parts.push(part);
    (async () => {
      let modelPath = def.file, anims = null;
      if (/\.bfm$/i.test(def.file)) {
        modelPath = /modelname="([^"]+)"/.exec(new TextDecoder().decode(await assets.fs.read(def.file)))?.[1];
        anims = await assets.actor(def.file);
      }
      if (!modelPath) return;
      const m = await assets.model(modelPath);
      part.gpu = m.gpu;
      part.skeleton = m.model.skeleton;
      if (anims?.size) {
        const name = ['stand_idle', 'idle', ...[...anims.keys()].filter((k) => k.includes('idle'))].find((k) => anims.has(k));
        if (name) part.clip = await assets.animation(anims.get(name));
      }
    })().catch((err) => console.warn(`Part ${def.name} of ${e.item.id}: ${err.message}`));
  }
}

// Whether a fade-state part matches the entity's attribute now (e.g. f_FoodLevel 66..101 = full).
function fadeShows(e, fade) {
  const attr = e.item.fadeStates.attr;
  const v = e.ai?.attrs[attr] ?? e.aiSave?.attrs?.[attr] ?? 100;
  return v >= fade.min && v < fade.max;
}

// World matrix of a node of the entity's main model or of one of its parts.
function attachMatrix(e, parentName, nodeName) {
  const parent = parentName?.toLowerCase() === 'mainobj' ? { gpu: e.gpu, skeleton: e.skeleton, matrix: e.matrix, pose: null }
    : e.parts?.find((p) => p.def.name.toLowerCase() === parentName?.toLowerCase());
  if (!parent?.matrix) return null;
  const index = nodeName ? parent.skeleton?.byName.get(nodeName.toLowerCase()) : undefined;
  if (index === undefined) return parent.matrix;
  const nodes = parent.pose?.length ? parent.pose : parent.skeleton.bindWorld;
  // Attach to the node's position and rotation only (postype/rottype "use"); attachment nodes
  // often carry an authoring scale (0.28 on snack carts) that must not shrink the part.
  const n = new Float32Array(nodes[index]);
  for (let c = 0; c < 3; c++) {
    const len = Math.hypot(n[c * 4], n[c * 4 + 1], n[c * 4 + 2]) || 1;
    for (let r = 0; r < 3; r++) n[c * 4 + r] /= len;
  }
  return mat4.multiply(parent.matrix, n);
}

// Seconds until the next periodic state (states with minPeriod/maxPeriod, e.g. bats flying out).
function nextStatePeriod(states) {
  const s = states.states.find((x) => Number.isFinite(x.minPeriod));
  return s ? s.minPeriod + Math.random() * ((Number.isFinite(s.maxPeriod) ? s.maxPeriod : s.minPeriod) - s.minPeriod) : Infinity;
}

// Periodic states play once (their part's animation, or a few seconds) and return to the default.
function updatePartState(e, dt) {
  const st = e.partState, states = e.item.partStates;
  if (!st || !dt) return;
  st.timer -= dt;
  if (st.timer > 0) return;
  if (st.current === states.defaultState) {
    const periodic = states.states.find((x) => Number.isFinite(x.minPeriod));
    const part = e.parts.find((p) => p.stateName === periodic.name);
    st.current = periodic.name;
    st.timer = part?.clip?.duration ?? 5;
    if (part) part.clipTime = 0;
  } else {
    st.current = states.defaultState;
    st.timer = nextStatePeriod(states);
  }
}

function drawParts(e, dt, list, tint) {
  updatePartState(e, dt);
  for (const part of e.parts ?? []) {
    part.matrix = null;
    if (!part.gpu) continue;
    if (part.stateName && part.stateName !== e.partState?.current) continue;
    if (part.fade && !fadeShows(e, part.fade)) continue;
    // Parts with no parenting link sit on the main model (fade states such as a carcass's meat).
    part.matrix = attachMatrix(e, part.def.parent ?? 'mainObj', part.def.attachNode);
    if (!part.matrix) continue;
    let pose;
    if (part.clip) {
      part.clipTime = (part.clipTime + dt) % Math.max(part.clip.duration, 1e-3);
      pose = computePose(part.skeleton, part.clip, part.clipTime, part.pose);
    }
    list.push({ model: part.gpu, matrix: part.matrix, pose, tint });
  }
}

// Registers an entity's footprint cells once its model (and so its bounds) is known.
function occupyFor(e) {
  const rules = e.item.placement;
  if (!rules || e.item.isAnimal || !e.gpu) return;
  const placed = placeFootprint(footprintFor(rules, e.gpu.bounds, e.scale), e.pos, e.yaw, false);
  occupancy.occupy(placed.cells, e);
}

// Sex chosen in the Animals tab (original Buy Animal panel: sticky Female / Male toggles,
// Female on at the start). Remembered for this viewer.
let animalSex = 'female';
try { if (localStorage.getItem('zt2.animalSex') === 'male') animalSex = 'male'; } catch { /* storage unavailable */ }

function pickVariant(item) {
  if (item.variants?.length) {
    const suffix = animalSex === 'male' ? /_m$/i : /_f$/i;
    const pool = item.isAnimal ? item.variants.filter((v) => suffix.test(v.id)) : [];
    const list = pool.length ? pool : item.variants;
    return list[Math.floor(Math.random() * list.length)];
  }
  return { id: item.id, model: item.model, scale: item.scale };
}

function inBounds(p) { return p && p[0] >= 0 && p[1] >= 0 && p[0] <= terrain.size[0] && p[1] <= terrain.size[1]; }

function placeAt(point) {
  const { item, variant } = tool;
  if (!point) return;
  const placed = evaluatePlacement(point);
  if (placed.problem) { toast(placed.problem); return; }
  if (money < item.cost) { toast('Not enough money'); return; }
  checkpoint(Boolean(item.placement?.terrainFlatten && placed.cells.length));
  if (item.placement?.terrainFlatten && placed.cells.length) flattenUnder(placed.cells, placed.pos[2]);
  addEntity({ id: item.id, variant: variant.id, model: variant.model, scale: variant.scale, pos: [...placed.pos], yaw: placed.yaw });
  pay(item.cost, item.isAnimal ? 'animal' : 'construction');
  updateMoney();
  if (item.placement?.randomRotate) tool.yaw = randomEighth();
  // Next animal of the same species: same chosen sex, fresh appearance where there are several.
  if (item.isAnimal) {
    tool.variant = pickVariant(item);
    assets.model(tool.variant.model).then((m) => { if (tool?.item === item) ghost = { ...ghost, gpu: m.gpu }; });
  }
  save();
}

// Loaded GPU models for a fence type's post, straight and diagonal pieces (cached on the item).
function fenceModels(item) {
  item.fenceGpu ??= Promise.all(['post', 'straight', 'diagonal'].map((k) => (item.fence[k] ? assets.model(item.fence[k]).then((m) => m.gpu) : null)))
    .then(([post, straight, diagonal]) => (item.fenceLoaded = { post, straight, diagonal }));
  return item.fenceGpu;
}

function addFence(item, a, b) {
  const key = edgeKey(a, b);
  if (fences.some((f) => f.key === key)) return false;
  const f = { uid: nextUid++, id: item.id, item, a, b, key, fence: true };
  // Midpoint and ends in world metres: what animals aim at (bashing, jumping, climbing).
  f.wa = [a[0] * TILE, a[1] * TILE];
  f.wb = [b[0] * TILE, b[1] * TILE];
  f.pos = [(f.wa[0] + f.wb[0]) / 2, (f.wa[1] + f.wb[1]) / 2, 0];
  f.pos[2] = terrain.heightAt(f.pos[0], f.pos[1]);
  fences.push(f);
  exhibitsDirty = true;
  fenceModels(item);
  if (aiReady) attachAI(f);
  return true;
}

// A fence an animal smashed (ZTBehMorph to its s_Broken type): drawn with the broken model and
// no longer closing the exhibit, so the animals can get out.
function breakFence(f, typeRef = 's_Broken') {
  if (f.broken) return;
  const name = f.ai?.attrs[typeRef] ?? f.ai?.attrs.s_Broken ?? `${f.item.id}_broken`;
  const brokenItem = catalogById.get(String(name).toLowerCase()) ?? catalogById.get(`${f.item.id}_broken`.toLowerCase());
  f.broken = brokenItem ?? { id: null, fenceLoaded: null };
  if (brokenItem) fenceModels(brokenItem);
  if (f.ai) f.ai.attrs.f_FenceStrength = 0;
  if (f.gate) f.gate = null;
  exhibitsDirty = true;
  save();
}

// Region ids on the two sides of a fence segment.
function fenceSides(f) {
  const dx = f.wb[0] - f.wa[0], dy = f.wb[1] - f.wa[1], len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len * 0.3, ny = dx / len * 0.3;
  return [exhibits.regionAt(f.pos[0] + nx, f.pos[1] + ny), exhibits.regionAt(f.pos[0] - nx, f.pos[1] - ny)];
}

// Builds the segments along the dragged line, paying for each; existing segments are kept.
function buildFence(corners) {
  const item = tool.item;
  checkpoint();
  let built = 0, short = false;
  for (let k = 1; k < corners.length; k++) {
    const a = corners[k - 1], b = corners[k];
    if (!inBounds(cornerWorld(a)) || !inBounds(cornerWorld(b))) continue;
    if (money < item.cost) { short = true; break; }
    if (addFence(item, a, b)) { pay(item.cost, 'construction'); built++; }
  }
  updateMoney();
  if (built) { rebuildCurbs(); save(); }
  if (short) toast('Not enough money for the whole fence');
}

function addEntity(data) {
  const item = catalogById.get(data.id) ?? catalogById.get(data.id.toLowerCase());
  if (!item) return null;
  const e = { uid: nextUid++, item, ...data, gpu: null, matrix: null };
  nextUid = Math.max(nextUid, e.uid + 1); // saved entities keep their uid (family ties refer to it)
  if (item.isAnimal) {
    e.home = [...data.pos];
    e.target = null;
    e.wait = Math.random() * 2;
    e.clip = null;
    e.clipTime = 0;
    e.pose = [];
  }
  if (!item.isAnimal && item.parts?.length) loadParts(e);
  assets.model(data.model).then((m) => {
    e.gpu = m.gpu;
    e.skeleton = m.model.skeleton;
    if (entities.includes(e)) occupyFor(e);
    if (item.isAnimal) loadAnimations(e);
  }).catch((err) => console.warn(err));
  entities.push(e);
  if (aiReady) attachAI(e);
  return e;
}

// Picks the animations an animal uses from its actor (.bfm) animation list.
async function loadAnimations(e) {
  const variant = e.item.variants?.find((v) => v.id === e.variant);
  if (!variant?.actor) return;
  const list = await assets.actor(variant.actor);
  const first = async (names) => {
    for (const n of names) {
      const path = list.get(n.toLowerCase());
      const anim = path && await assets.animation(path);
      if (anim) return anim;
    }
    return null;
  };
  const idleNames = ['Stand_Idle', 'Swim_Idle', 'Fly_Idle', 'Sit_Idle', 'Lie_Idle', ...[...list.keys()].filter((k) => k.endsWith('_idle'))];
  const extraNames = [...list.keys()].filter((k) => /^stand_[a-z]+$/.test(k) && k !== 'stand_idle');
  const anims = {
    walk: await first(['Walk_Ahead', 'Swim_Ahead', 'Fly_Ahead', 'Run_Ahead']),
    idle: await first(idleNames),
    extras: (await Promise.all(extraNames.slice(0, 12).map((k) => assets.animation(list.get(k))))).filter(Boolean),
  };
  // Walking speed that matches the feet: distance the root bone travels per cycle.
  anims.walkSpeed = anims.walk ? (rootTravel(anims.walk) / anims.walk.duration) * e.scale : 0;
  e.anims = anims;
  play(e, anims.idle, true);
}

function play(e, clip, loop) {
  if (!clip || e.clip === clip) return;
  e.clip = clip;
  e.clipLoop = loop;
  e.clipTime = 0;
}

function attachAI(e) {
  if (e.fence && e.item.group === 'Curbs') return;
  const done = e.item.isAnimal ? attachMind(e, aiData, assets) : attachObjectAI(e, aiData);
  done.then(() => {
    // Saved needs and happiness of animals, food levels of containers.
    const saved = e.aiSave;
    if (!saved) return;
    if (e.mind) {
      Object.assign(e.mind.needs, saved.needs);
      Object.assign(e.mind.attrs, saved.attrs);
      for (const [name, t] of saved.tokens ?? []) e.mind.tokens.set(name, { ...t, left: t.left < 0 ? Infinity : t.left });
      e.mind.updateTriggers();
    }
    if (e.ai) Object.assign(e.ai.attrs, saved.attrs);
  }).catch((err) => console.warn(`AI for ${e.id}: ${err.message}`));
}

// What a save keeps of an entity (animals at their current spot, with their needs).
function entitySave(e) {
  const out = { uid: e.uid, id: e.id, variant: e.variant, model: e.model, scale: e.grow?.to ?? e.scale, pos: [...e.pos], yaw: e.yaw };
  if (e.actor) out.actor = e.actor; // young born in the zoo
  if (e.rel) out.rel = e.rel;
  if (e.priceIndex !== undefined) out.priceIndex = e.priceIndex;
  if (e.mind) {
    const tokens = [...e.mind.tokens].filter(([, t]) => t.left === Infinity || t.left > 30).map(([name, t]) => [name, { ...t, left: t.left === Infinity ? -1 : t.left }]);
    out.aiSave = { needs: e.mind.needs, attrs: { f_needPointsGood: e.mind.needPointsGood, f_needPointsBad: e.mind.needPointsBad, b_Pregnant: Boolean(e.mind.attrs.b_Pregnant) }, tokens };
  }
  else if (e.ai?.attrs.f_FoodLevel !== undefined) out.aiSave = { attrs: { f_FoodLevel: e.ai.attrs.f_FoodLevel } };
  else if (e.aiSave) out.aiSave = e.aiSave;
  return out;
}

// Plays an animation from the animal's own list by name (e.g. "Eat_BiteA"); returns false if the
// animal has no such animation. Clips load on first use.
function playNamed(e, name, loop) {
  const key = name.toLowerCase();
  const path = e.animPaths?.get(key);
  if (!path) return false;
  if (loop && e.clipName === key && e.clipLoop) return true; // one-shot clips always restart
  e.clipCache ??= new Map();
  const clip = e.clipCache.get(key);
  if (clip) {
    e.clip = null;
    play(e, clip, loop);
    e.clipName = key;
    return true;
  }
  if (!e.clipCache.has(key)) {
    e.clipCache.set(key, null);
    assets.animation(path).then((c) => {
      e.clipCache.set(key, c);
      if (c && key === 'walk_ahead') e.walkSpeed = (rootTravel(c) / c.duration) * e.scale;
      if (c && key === 'run_ahead') e.runSpeed = (rootTravel(c) / c.duration) * e.scale;
    });
  }
  return true;
}

// Per exhibit: area, biome mix (terrain cells and plants/rocks of each biome), plants, rocks and
// animals per species; used for the animals' biome, space and environment needs.
// APPROX weights: a terrain cell counts its area (0.56 m²), a plant 10 m², a tree or rock 20 m².
function exhibitStats() {
  const t = editor.data, W = t.width, c = t.cellSize;
  const stats = new Map();
  const of = (id) => {
    if (!stats.has(id)) stats.set(id, { area: exhibits.regions[id]?.area ?? 0, biomeWeights: {}, plants: 0, rocks: 0, counts: new Map() });
    return stats.get(id);
  };
  for (let cy = 0; cy < t.height - 1; cy++) {
    for (let cx = 0; cx < W - 1; cx++) {
      const id = exhibits.regionAt((cx + 0.5) * c, (cy + 0.5) * c);
      if (exhibits.regions[id]?.kind !== 'exhibit') continue;
      const name = t.biomeNames[t.biome[cy * W + cx]]?.toLowerCase();
      if (!name) continue;
      const s = of(id);
      s.biomeWeights[name] = (s.biomeWeights[name] ?? 0) + c * c;
    }
  }
  for (const e of entities) {
    const id = exhibits.regionAt(e.pos[0], e.pos[1]);
    if (exhibits.regions[id]?.kind !== 'exhibit') continue;
    const s = of(id);
    if (e.mind) s.counts.set(e.mind.species, (s.counts.get(e.mind.species) ?? 0) + 1);
    else if (e.ai) {
      const rock = e.ai.types.has('rock'), plant = e.ai.types.has('foliage');
      if (!rock && !plant) continue;
      if (rock) s.rocks++; else s.plants++;
      const w = rock || e.ai.types.has('tree') ? 20 : 10;
      for (const b of e.ai.biomes) s.biomeWeights[b] = (s.biomeWeights[b] ?? 0) + w;
    }
  }
  return stats;
}

// Creates an entity the AI asked for (droppings, babies, dropped items) next to `parent`, using
// the type's own entity file for its model.
async function spawnEntity(type, parent, { child = false, offset = 0 } = {}) {
  // The model may come from a parent type's file (Lion_Young_F inherits Lion_Young's actor).
  const def = await aiData.entity(type);
  let xml = null, model = null;
  for (const t of [type, ...[...(def?.types ?? [])].reverse()]) {
    const path = aiData.entityFiles.get(t.toLowerCase());
    if (!path) continue;
    xml = new TextDecoder('latin1').decode(await assets.fs.read(path));
    model = /(?:modelfile|actorfile)="([^"]+)"/i.exec(xml)?.[1]?.replace(/\\/g, '/');
    if (model) break;
  }
  if (!model) return;
  if (!/\.(nif|bfb|bfm)$/i.test(model)) model = assets.fs.has(`${model}.bfb`) ? `${model}.bfb` : `${model}.nif`;
  let actor = null;
  if (/\.bfm$/i.test(model)) {
    actor = model;
    model = /modelname="([^"]+)"/.exec(new TextDecoder().decode(await assets.fs.read(actor)))?.[1];
  }
  if (!model || !assets.fs.has(model)) return;
  // Scale sits on the element that names the model (BFActorComponent, BFSimpleLODComponent...).
  const scale = Number(/<\w+[^>]*(?:modelfile|actorfile)="[^"]*"[^>]*\sscale="([\d.]+)"/i.exec(xml)?.[1]
    ?? /<\w+[^>]*\sscale="([\d.]+)"[^>]*(?:modelfile|actorfile)=/i.exec(xml)?.[1] ?? 1);
  const a = Math.random() * Math.PI * 2, r = Math.random() * offset;
  const pos = [parent.pos[0] + Math.cos(a) * r, parent.pos[1] + Math.sin(a) * r, 0];
  pos[2] = terrain.heightAt(pos[0], pos[1]);
  if (child && parent.item.isAnimal) {
    // A baby of the parent's species; the mother's mate is the father.
    const baby = addEntity({ id: parent.item.id, variant: type, actor, model, scale, pos, yaw: Math.random() * Math.PI * 2 });
    if (!baby) return;
    const r = relations(baby);
    r.mother = parent.uid;
    r.father = relations(parent).mate;
    relations(parent).children.push(baby.uid);
    const father = entities.find((o) => o.uid === r.father);
    if (father) relations(father).children.push(baby.uid);
    return;
  }
  // Other spawned objects (droppings...) are not in the build menu: a minimal item for them.
  let item = catalogById.get(type.toLowerCase());
  if (!item) {
    item = { id: type, name: type.replace(/_/g, ' '), types: def?.types ?? [type], model, scale, cost: 0, refund: 0, upkeep: 0, isAnimal: false, hidden: true };
    catalogById.set(type.toLowerCase(), item);
  }
  // Build-menu objects (a carcass is also sold as food) use their catalog model and parts.
  const known = item.model && !item.hidden;
  addEntity({ id: item.id, model: known ? item.model : model, scale: known ? item.scale : scale, pos, yaw: Math.random() * Math.PI * 2 });
}

// What the animal AI may use of the game (rebuilt each frame; cheap).
function animalWorld() {
  return {
    entities, exhibits, findPath,
    hour: clock.hour,
    isWater: (x, y) => isWater(x, y),
    waterDepthAt,
    animalHeightAt,
    biomeAt: (x, y) => {
      const t = editor.data, c = t.cellSize;
      const cx = Math.min(t.width - 1, Math.max(0, Math.floor(x / c))), cy = Math.min(t.height - 1, Math.max(0, Math.floor(y / c)));
      return t.biomeNames[t.biome[cy * t.width + cx]]?.toLowerCase();
    },
    heightAt: (x, y) => terrain.heightAt(x, y),
    passable: (e) => {
      const region = exhibits.regionAt(e.pos[0], e.pos[1]);
      const swims = Boolean(e.mind?.def.swim);
      return (cx, cy) => exhibits.regionAt(cx + 0.5, cy + 0.5) === region && !occupancy.cells.has(`${cx},${cy}`) && (swims || !isWater(cx + 0.5, cy + 0.5));
    },
    spawn: (type, parent, opts) => { spawnEntity(type, parent, opts).catch((err) => console.warn(`Spawn ${type}: ${err.message}`)); },
    byUid: (uid) => entities.find((o) => o.uid === uid) ?? null,
    message: (locID, e) => {
      const text = messageTexts.get(String(locID).toLowerCase());
      if (text) toast(text.replace('%s', animalName(e)));
    },
    morph: (e, type, opts) => { morphAnimal(e, type, opts).catch((err) => console.warn(`Morph ${type}: ${err.message}`)); },
    kill: (e) => removeEntity(e),
    emote: (e, name, scale) => { showEmote(e, name, scale).catch((err) => console.warn(`Emote ${name}: ${err.message}`)); },
    fences,
    fenceSides,
    breakFence: (f, type) => breakFence(f, type),
    playLoop: (e, name) => playNamed(e, name, true),
    playOnce: (e, name) => playNamed(e, name, false),
  };
}

const isProtected = (item) => item.types.some((t) => /^(entrance|zooboundary)$/i.test(t));

function select(e) {
  selected = e;
  const box = $('selection');
  if (!e) { box.hidden = true; shellUI?.showInfo(null); return; }
  $('selSell').hidden = isProtected(e.item);
  $('selName').textContent = e.item.name;
  $('selName').textContent = e.gate ? `${e.item.name} with gate` : e.item.name;
  const upkeep = e.item.upkeep ? ` · upkeep ${formatMoney(e.item.upkeep)}/month` : '';
  $('selInfo').textContent = e.item.isAnimal ? animalInfo(e) : `Value ${formatMoney(valueOf(e))}${upkeep}`;
  $('selSell').textContent = refundOf(e) > 0 ? `Sell (+${formatMoney(refundOf(e))})` : 'Remove';
  // Debug (local mode only): change an animal's mood to try escapes, fights and recovery.
  $('selDebug').hidden = !(usesLocalGameFiles() && e.mind && !e.guest);
  box.hidden = Boolean(shellUI) && $('selDebug').hidden; // the shell shows its own info panel
  shellUI?.showInfo(infoData(e));
}

// The family tree tab: living relatives from the parents / mate / children links.
function familyOf(e) {
  const byUid = (uid) => (uid === undefined || uid === null ? null : entities.find((o) => o.uid === uid) ?? null);
  const out = [];
  const add = (locid, o) => { if (o && o !== e && !out.some((x) => x.uid === o.uid)) out.push({ uid: o.uid, text: `${L(locid) || locid.split(':')[1]}: ${animalName(o)}` }); };
  const mother = byUid(e.rel?.mother), father = byUid(e.rel?.father);
  add('entityinfo:mother', mother);
  add('entityinfo:father', father);
  add('entityinfo:grandMM', byUid(mother?.rel?.mother));
  add('entityinfo:grandMF', byUid(mother?.rel?.father));
  add('entityinfo:grandFM', byUid(father?.rel?.mother));
  add('entityinfo:grandFF', byUid(father?.rel?.father));
  add('entityinfo:mate', byUid(e.rel?.mate));
  for (const o of entities) {
    if (!o.rel || o === e) continue;
    if ((e.rel?.mother != null && o.rel.mother === e.rel.mother) || (e.rel?.father != null && o.rel.father === e.rel.father)) add('entityinfo:sibling', o);
  }
  for (const uid of e.rel?.children ?? []) add('entityinfo:child', byUid(uid));
  return out;
}

// Biome and home region of a species (its best biome) or of a plant or rock (the biome it
// belongs to), with the icons the info panels use.
function biomeInfo(bio) {
  if (!bio) return {};
  const best = Object.entries(bio.sensitivity ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] ?? bio.members?.find((b) => b !== 'zoodecoration');
  const out = {};
  if (best) out.biome = { locid: `biometype:${best}`, name: L(`biometype:${best}`) || best, icon: `ui/icon_biomes/icon_${best}.dds` };
  if (bio.location) {
    const region = bio.location.split('_').slice(1).join('_');
    out.location = { text: L(`worldlocation:${region}`) || region.replace(/_/g, ' '), icon: `ui/icon_maplocations/${bio.location}.dds` };
  }
  return out;
}

// The buy panel for the picked build item or terrain brush (hud.js buyInfo).
const itemDefs = new Map(); // catalog id -> AI entity data (biome, conservation), once loaded
function updateBuyInfo() {
  if (!shellUI) return;
  // The original shows the brush size in percent (of the 1..20 m range here).
  if (terrainTool) { shellUI.showBuy({ kind: 'brush', size: Math.round(terrainTool.radius / 20 * 100) }); return; }
  const it = tool?.item;
  if (!it || tool.gateTool) { shellUI.showBuy(null); return; }
  const data = { kind: 'object', id: it.id, name: it.name, icon: it.icon, cost: formatMoney(it.cost ?? 0), upkeep: it.upkeep ? formatMoney(it.upkeep) : null, rotate: !it.isAnimal && !it.path && !it.fence };
  const typeId = tool.variant?.id ?? it.id;
  if (!itemDefs.has(typeId) && aiData) {
    itemDefs.set(typeId, null);
    aiData.entity(typeId).then((def) => { itemDefs.set(typeId, def ?? null); if (tool?.item === it) updateBuyInfo(); }).catch(() => {});
  }
  const def = itemDefs.get(typeId);
  data.zoopedia = def?.attrs?.s_Zoopedia ?? null;
  if (it.isAnimal) data.animal = { male: animalSex === 'male', conservation: def?.attrs?.s_Endangerment, ...biomeInfo(def?.biome) };
  else if (def?.biome?.members?.length) data.foliage = biomeInfo(def.biome);
  shellUI.showBuy(data);
}
function changeBrush(delta) {
  terrainRadius = Math.min(20, Math.max(1, terrainRadius + delta));
  if (terrainTool) terrainTool.radius = terrainRadius;
  updateBuyInfo();
}

// What the original info panel shows of an object (see hud.js entityInfo).
const INFO_PANELS = [
  [/^animal$/, 'Animal Info'], [/^(tree|stump)$/, 'Tree Info'], [/^(plant|marineplant|foliage)$/, 'Plant Info'],
  [/^rock$/, 'Rocks Info'], [/^food$/, 'Food Info'], [/^enrichment$/, 'Enrichment Info'],
  [/^donationbox$/, 'Donation Box Info'], [/^trashcontainer$/, 'Trash Info'],
  [/^(foodstand|snackcart|drinkstand|giftshop)$/, 'Commerce Building Info'], [/^(building|shelters)$/, 'Building Info'],
];
const NEED_BASIC = ['hunger', 'thirst', 'rest'];
const NEED_ADVANCED = ['environment', 'exercise', 'hygiene', 'privacy', 'social', 'stimulation'];
function guestInfo(g) {
  const m = g.mind;
  const need = (n, key = `guest_${n}`) => {
    const v = m?.def.stateVars.get(n), value = m?.needs[n] ?? 0;
    const status = v?.PressingThreshold !== undefined && value >= v.PressingThreshold ? 'critical' : v?.TriggerThreshold !== undefined && value >= v.TriggerThreshold ? 'pressing' : 'satisfied';
    return { key, level: 1 - value / 100, status, tip: `${L(`entityneeds:${key}`) || n}${L(`entityneeds:${status}`) || status}` };
  };
  // "happiness" is a need like the others: it grows over the visit and seeing animals lowers it,
  // so a low value is a happy guest (ZooFame.bin uses 100 minus it).
  const unhappy = m?.needs.happiness ?? 50;
  const needs = m ? [
    { key: unhappy < 50 ? 'guest_happy' : 'guest_unhappy', level: 1 - unhappy / 100, status: unhappy < 50 ? 'satisfied' : unhappy < 75 ? 'pressing' : 'critical', tip: `${L('entityneeds:guest_happy')}${Math.round(100 - unhappy)}` },
    ...['hunger', 'thirst', 'rest', 'bathroom', 'amusement'].filter((n) => n in m.needs).map((n) => need(n)),
  ] : [];
  // Carried items: the inventory tokens that are things (Hamburger), not t_ markers.
  const inventory = [...(m?.tokens.keys() ?? [])].filter((k) => !/^t_/i.test(k) && L(`entityname:${k}`)).map((k) => L(`entityname:${k}`));
  return { id: g.uid, panel: 'Guest Info', name: g.name, icon: g.type.icon, task: (L(g.status) || '').replace('%s', '').trim(), needs: { guest: needs }, cash: formatMoney(g.cash), thoughts: g.thoughts ?? [], inventory, sellable: false };
}

function infoData(e) {
  if (e.guest) return guestInfo(e);
  const types = (e.item.types ?? []).map((t) => t.toLowerCase());
  const panel = INFO_PANELS.find(([re]) => types.some((t) => re.test(t)))?.[1] ?? 'Scenery Info';
  const data = { id: e.uid, panel, name: e.item.isAnimal ? animalName(e) : e.item.name, icon: e.item.icon, sellable: !isProtected(e.item) };
  const m = e.mind;
  if (m) {
    const target = m.task?.target?.entity;
    const doing = m.status && actionTexts.get(m.status.toLowerCase());
    data.task = doing ? doing.replace('%s', target && target !== e ? target.item.name : '').trim() : '';
    // A need's state: satisfied below its trigger threshold, critical at its pressing threshold.
    const need = (n) => {
      const v = m.def.stateVars.get(n), value = m.needs[n] ?? 0;
      const status = v?.PressingThreshold !== undefined && value >= v.PressingThreshold ? 'critical' : v?.TriggerThreshold !== undefined && value >= v.TriggerThreshold ? 'pressing' : 'satisfied';
      return { key: `animal_${n}`, level: 1 - value / 100, status, tip: `${L(`entityneeds:animal_${n}`) || n}${L(`entityneeds:${status}`) || status}` };
    };
    const has = (n) => n in m.needs;
    const happy = m.needPointsGood >= m.needPointsBad, sick = (m.needs.health ?? 0) >= 50;
    data.needs = {
      basic: [
        { key: happy ? 'animal_happy' : 'animal_not_happy', level: 1, status: happy ? 'satisfied' : 'critical', tip: `${L('entityneeds:animal_happy')}${Math.round(m.needPointsGood)}` },
        { key: sick ? 'animal_sick' : 'animal_well', level: 1, status: sick ? 'critical' : 'satisfied', tip: `${L('entityneeds:animal_well')}${L(`entityneeds:${sick ? 'sick' : 'healthy'}`)}` },
        ...NEED_BASIC.filter(has).map(need),
      ],
      advanced: NEED_ADVANCED.filter(has).map(need),
    };
    // Quick status (activity tab): happiness, health, pregnancy.
    const pregnant = Boolean(m.attrs.b_Pregnant);
    data.needs.states = [data.needs.basic[0], data.needs.basic[1],
      { key: pregnant ? 'animal_pregnant' : 'animal_not_pregnant', level: 1, status: 'satisfied', tip: L(`entityneeds:animal_${pregnant ? '' : 'not_'}pregnant`) }];
    Object.assign(data, biomeInfo(m.def.biome));
    const male = /_M$/i.test(e.variant ?? '');
    data.gender = { locid: `entityinfo:${male ? 'male' : 'female'}_stt`, icon: `ui/infopan/icon_${male ? 'male' : 'female'}.dds` };
    const risk = m.attrs.s_Endangerment;
    if (risk) data.conservation = { key: risk, locid: `entityinfo:conservation_${risk.toLowerCase()}_stt` };
  }
  if (e.item.isAnimal) data.family = familyOf(e);
  data.zoopedia = e.mind?.attrs.s_Zoopedia ?? e.ai?.attrs.s_Zoopedia ?? null;
  const food = e.ai?.attrs.f_FoodLevel;
  if (food !== undefined) data.quantity = food > 66 ? 'full' : food > 33 ? 'twothirds' : food > 0 ? 'onethird' : 'empty';
  if (e.item.upkeep) data.upkeep = { 'Current Upkeep': formatMoney(e.item.upkeep) };
  // Stands: price setting and takings; donation boxes: what guests gave.
  const buy = e.ai?.transactions?.buy_item;
  if (buy?.choices) {
    data.priceIndex = e.priceIndex ?? buy.index;
    data.price = formatMoney(buy.choices[data.priceIndex] ?? buy.cost);
    data.money = { 'Current Income': formatMoney(e.sales ?? 0), 'Current Profit': formatMoney(e.sales ?? 0), 'YTD Num': formatMoney(e.sales ?? 0) };
    data.numbers = { 'Current Users': e.users ?? 0 };
  }
  if (e.ai?.transactions?.donate) {
    const n = e.donors ?? 0, amount = e.donations ?? 0;
    data.numbers = { 'Donation Quantity': n };
    data.money = { 'Donation Amount': formatMoney(amount), 'Average Donation Amount': formatMoney(n ? amount / n : 0) };
  }
  return data;
}

// Animal panel text: what it is doing (the game's action text) and its most pressing needs.
function animalInfo(e) {
  const parts = [`${e.variant.replace(/_/g, ' ')} · ${exhibitText(e)}`];
  const m = e.mind;
  if (m) {
    const target = m.task?.target?.entity;
    const doing = m.status && actionTexts.get(m.status.toLowerCase());
    if (doing) parts.push(doing.replace('%s', target && target !== e ? target.item.name : '').trim());
    const shown = ['hunger', 'thirst', 'rest', 'exercise', 'social', 'stimulation', 'privacy', 'hygiene'];
    const needs = shown.filter((n) => n in m.needs).map((n) => [n, m.needs[n]]).sort((a, b) => b[1] - a[1]).slice(0, 3);
    parts.push(needs.map(([n, v]) => `${n} ${Math.round(v)}`).join(', '));
    parts.push(`happy ${Math.round(m.needPointsGood)} · unhappy ${Math.round(m.needPointsBad)}`);
  }
  return parts.join(' · ');
}

function exhibitText(e) {
  const r = exhibits?.regions[exhibits.regionAt(e.pos[0], e.pos[1])];
  if (!r) return '';
  if (r.kind !== 'exhibit') return 'not in an exhibit';
  const animals = entities.filter((o) => o.item.isAnimal && exhibits.regionAt(o.pos[0], o.pos[1]) === r.id).length;
  return `exhibit of ${Math.round(r.area)} m² with ${animals} animal${animals === 1 ? '' : 's'}`;
}

const animalName = (e) => e.name ?? e.item.name;

// Emoticons (world/particlesystems/emotedict.xml): name -> particle effect, played above the
// entity for the dictionary's removeTime (10 s).
let emoteDict = null;
const effects = new Map(); // nif path -> Promise<{ effect, textures }>
async function loadEmoteDict() {
  const text = new TextDecoder('latin1').decode(await assets.fs.read('world/particlesystems/emotedict.xml'));
  const dict = new Map();
  for (const m of text.matchAll(/<(\w+)>\s*<Conditions>\s*<BFParticleDefinition xmlFile="([^"]+)"[^>]*removeTime="([\d.]+)"/g)) dict.set(m[1].toLowerCase(), { xml: m[2], removeTime: Number(m[3]) });
  return dict;
}
function loadEffect(path) {
  if (!effects.has(path)) {
    effects.set(path, (async () => {
      const effect = parseEffect(await assets.fs.read(path));
      const dir = path.split('/').slice(0, -1).join('/');
      const textures = new Map();
      await Promise.all(effect.systems.map(async (sys) => {
        const resolved = sys.texture && assets.resolveTexture(dir, sys.texture);
        if (resolved) textures.set(sys.texture, await assets.texture(resolved, false));
      }));
      return { effect, textures };
    })());
  }
  return effects.get(path);
}
async function showEmote(e, name, scale = 1) {
  emoteDict ??= loadEmoteDict();
  const def = (await emoteDict).get(String(name).toLowerCase());
  if (!def || !assets.fs.has(def.xml)) return;
  const nif = /modelfile="([^"]+)"/.exec(new TextDecoder('latin1').decode(await assets.fs.read(def.xml)))?.[1]?.replace(/\\/g, '/');
  if (!nif || !assets.fs.has(nif)) return;
  const { effect, textures } = await loadEffect(nif);
  e.emote = { instance: new EffectInstance(effect, { lifetime: def.removeTime }), textures, scale };
}

// Takes an entity out of the zoo (sold, or an animal that died).
function removeEntity(e) {
  const i = entities.indexOf(e);
  if (i >= 0) entities.splice(i, 1);
  occupancy.free(e);
  if (selected === e) select(null);
}

// ZTBehMorph: a young animal grows up into the adult entity type of its species, its model
// scaling up from initScale over the morph period.
async function morphAnimal(e, type, { period = 0, initScale = 1 } = {}) {
  const v = e.item.variants?.find((x) => x.id.toLowerCase() === String(type).toLowerCase());
  if (!v) {
    // Not a stage of the species: the animal becomes that object (Die_Fight -> Carcass_Meat).
    await spawnEntity(type, e, { offset: 0 });
    removeEntity(e);
    save();
    return;
  }
  const m = await assets.model(v.model);
  const old = e.mind;
  e.variant = v.id;
  e.model = v.model;
  e.actor = undefined;
  e.gpu = m.gpu;
  e.skeleton = m.model.skeleton;
  e.clip = null; e.clipName = null; e.clipCache = null; e.anims = null;
  e.grow = { t: 0, period: Math.max(period, 0.01), from: v.scale * initScale, to: v.scale };
  e.scale = e.grow.from;
  await attachMind(e, aiData, assets);
  if (old && e.mind) {
    for (const k of Object.keys(e.mind.needs)) if (k in old.needs) e.mind.needs[k] = old.needs[k];
    e.mind.attrs.f_needPointsGood = old.needPointsGood;
    e.mind.attrs.f_needPointsBad = old.needPointsBad;
    e.mind.updateTriggers();
  }
  loadAnimations(e);
}

function sellSelected() {
  if (!selected || selected.guest || isProtected(selected.item)) return;
  checkpoint();
  const i = entities.indexOf(selected);
  if (i >= 0) entities.splice(i, 1);
  occupancy.free(selected);
  const f = fences.indexOf(selected);
  if (f >= 0) { fences.splice(f, 1); exhibitsDirty = true; }
  receive(refundOf(selected), 'recycling');
  select(null);
  save();
}
$('selSell').onclick = sellSelected;
$('selClose').onclick = () => select(null);
function setMood(e, unhappy) {
  const m = e?.mind;
  if (!m) return;
  for (const k of Object.keys(m.needs)) if (SHOWN_NEED_KEYS.includes(k)) m.needs[k] = unhappy && (k === 'hunger' || k === 'thirst') ? 95 : unhappy ? m.needs[k] : 0;
  m.attrs.f_needPointsBad = unhappy ? 90 : 0;
  m.attrs.f_needPointsGood = unhappy ? 0 : 90;
  m.updateTriggers();
  m.task = null; // choose again with the new mood
  e.act = null;
  toast(`${animalName(e)} is now ${unhappy ? 'unhappy' : 'happy'} (debug)`);
  $('selInfo').textContent = animalInfo(e);
}
const SHOWN_NEED_KEYS = ['hunger', 'thirst', 'rest', 'exercise', 'privacy', 'hygiene', 'social', 'stimulation', 'health', 'bathroom'];
$('selUnhappy').onclick = () => setMood(selected, true);
$('selHappy').onclick = () => setMood(selected, false);

function pickEntity(ray) {
  let best = null, bestT = Infinity;
  for (const e of entities) {
    if (!e.gpu || !e.matrix) continue;
    const c = mat4.transformPoint(e.matrix, e.gpu.center);
    const t = raySphere(ray, c, Math.max(0.5, e.gpu.radius * e.scale * 0.8));
    if (t < bestT) { bestT = t; best = e; }
  }
  for (const g of guests) {
    if (!g.gpu || !g.matrix) continue;
    const t = raySphere(ray, mat4.transformPoint(g.matrix, [0, 0, 0.9]), 0.6);
    if (t < bestT) { bestT = t; best = g; }
  }
  const f = pickFence(ray);
  if (f && f.t < bestT) best = f.fence;
  return best;
}

function pickFence(ray) {
  // Closest approach between the pointer ray and each segment (1 m above the ground line).
  let best = null, bestT = Infinity;
  const o = ray.origin, d = ray.dir;
  for (const f of fences) {
    const [ax, ay] = cornerWorld(f.a), [bx, by] = cornerWorld(f.b);
    const p0 = [ax, ay, terrain.heightAt(ax, ay) + 1], p1 = [bx, by, terrain.heightAt(bx, by) + 1];
    const u = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], w = [o[0] - p0[0], o[1] - p0[1], o[2] - p0[2]];
    const a = d[0] * d[0] + d[1] * d[1] + d[2] * d[2], b = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
    const c = u[0] * u[0] + u[1] * u[1] + u[2] * u[2], dd = d[0] * w[0] + d[1] * w[1] + d[2] * w[2];
    const e = u[0] * w[0] + u[1] * w[1] + u[2] * w[2], den = a * c - b * b;
    let sc = den > 1e-9 ? (b * e - c * dd) / den : 0, tc = den > 1e-9 ? (a * e - b * dd) / den : 0;
    tc = Math.max(0, Math.min(1, tc));
    sc = Math.max(0, (b * tc - dd) / a);
    const dist = Math.hypot(...[0, 1, 2].map((k) => o[k] + d[k] * sc - (p0[k] + u[k] * tc)));
    if (dist < 1.1 && sc < bestT) { bestT = sc; best = f; }
  }
  return best ? { fence: best, t: bestT } : null;
}

// ---------------------------------------------------------------------------------------
// Animals: wander around where they were placed (fenced exhibits come later).

const WANDER_RADIUS = 4 * TILE;

function updateAnimal(e, dt) {
  advanceClip(e, dt);
  if (e.wait > 0) {
    e.wait -= dt;
    // While standing, occasionally play a one-off action (yawn, sniff, roar...).
    if (e.anims && e.clip === e.anims.idle && e.anims.extras.length && Math.random() < dt * 0.08) {
      play(e, e.anims.extras[Math.floor(Math.random() * e.anims.extras.length)], false);
    }
    return;
  }
  // Animals stay in the area they were placed in: inside an exhibit they roam all of it,
  // elsewhere they keep near where they were put.
  e.region = exhibits.regionAt(e.pos[0], e.pos[1]);
  if (!e.target) {
    let goal = null;
    if (exhibits.regions[e.region]?.kind === 'exhibit') goal = exhibits.randomPoint(e.region);
    if (!goal) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * WANDER_RADIUS;
      goal = [
        Math.min(terrain.size[0], Math.max(0, e.home[0] + Math.cos(a) * r)),
        Math.min(terrain.size[1], Math.max(0, e.home[1] + Math.sin(a) * r)),
      ];
    }
    // Walk around objects, water and fences on the 1 m placement grid.
    e.route = findPath(e.pos, goal, (cx, cy) => exhibits.regionAt(cx + 0.5, cy + 0.5) === e.region
      && !occupancy.cells.has(`${cx},${cy}`) && !isWater(cx + 0.5, cy + 0.5), { maxNodes: 6000 });
    if (!e.route) { e.wait = 1 + Math.random() * 2; return; }
    e.target = e.route.shift();
  }
  const dx = e.target[0] - e.pos[0], dy = e.target[1] - e.pos[1];
  const dist = Math.hypot(dx, dy);
  if (dist < 0.15) {
    e.target = e.route?.shift() ?? null;
    if (e.target) return;
    e.wait = 2 + Math.random() * 6;
    if (e.anims) play(e, e.anims.idle, true);
    return;
  }
  if (e.anims?.walk) play(e, e.anims.walk, true);
  const speed = e.anims?.walkSpeed || 1.2;
  // Models face -Y, so heading angle θ maps to yaw θ + π/2.
  const desired = Math.atan2(dy, dx) + Math.PI / 2;
  const diff = ((desired - e.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  e.yaw += Math.sign(diff) * Math.min(Math.abs(diff), dt * 2);
  if (Math.abs(diff) < 0.8) {
    const step = Math.min(dist, speed * dt);
    const nx = e.pos[0] + (dx / dist) * step, ny = e.pos[1] + (dy / dist) * step;
    // Fences hold animals in: a step into another region ends this walk.
    if (exhibits.regionAt(nx, ny) !== e.region) {
      e.target = null;
      e.route = null;
      e.wait = 0.5 + Math.random();
      if (e.anims) play(e, e.anims.idle, true);
      return;
    }
    e.pos[0] = nx;
    e.pos[1] = ny;
    e.pos[2] = terrain.heightAt(e.pos[0], e.pos[1]);
  }
}

function advanceClip(e, dt) {
  if (!e.clip) return;
  e.clipTime += dt;
  if (e.clipTime >= e.clip.duration) {
    if (e.clipLoop) e.clipTime %= Math.max(e.clip.duration, 1e-3);
    else if (e.mind) e.clipTime = e.clip.duration; // hold the last frame; the mind moves on
    else play(e, e.anims?.idle, true);
  }
}

// Root bone horizontal position is held at its bind value: the entity itself moves instead.
function posedNodes(e) {
  if (!e.clip || !e.skeleton) return undefined;
  const skel = e.skeleton;
  const rootNode = skel.byName.get(e.clip.bones[0]?.name.toLowerCase());
  const rootXY = rootNode !== undefined ? skel.nodes[rootNode].translation : null;
  return computePose(skel, e.clip, e.clipTime, e.pose, rootXY ? { lockRootXY: true, rootNode, rootXY } : {});
}


// ---------------------------------------------------------------------------------------
// Guests (Phase 5, first step): they arrive through the front gate while the zoo is open (rules
// from AI/guestMgr.xml), pay admission, walk the paths from sight to sight, stop to look, and
// leave after a while. Each guest is one of the game's everyday guest types with its own
// clothes, skin and hair (guests.js). Their needs, viewing of animals, shopping and the rest of
// the original guest AI (AI/Tasks/guests) come next.
let guestTypes = null, guestConfig = null;
const guests = [];
let guestSpawnTimer = 3;
const guestModels = new Map(); // type id -> Promise<{ gpu, skeleton, anims, walkSpeed, head }>
async function initGuests(fs) {
  [guestTypes, guestConfig] = await Promise.all([loadGuestTypes(fs), loadGuestConfig(fs)]);
  for (const [type, file] of guestTypes.files) if (!aiData.entityFiles.has(type)) aiData.entityFiles.set(type, file);
}
function guestModel(type) {
  if (!guestModels.has(type.id)) {
    guestModels.set(type.id, (async () => {
      const actorText = new TextDecoder().decode(await assets.fs.read(type.actor));
      const modelPath = /modelname="([^"]+)"/.exec(actorText)?.[1];
      const headPath = type.head && (/\.(nif|bfb)$/i.test(type.head) ? type.head : `${type.head}.nif`);
      const [body, head, list] = await Promise.all([assets.model(modelPath), headPath ? assets.model(headPath).catch(() => null) : null, assets.actor(type.actor)]);
      const clip = async (n) => (list.has(n) ? assets.animation(list.get(n)) : null);
      const [walk, idle, ...extras] = await Promise.all(['walk_ahead', 'stand_idle', 'stand_lookaround', 'stand_checkwatch', 'stand_point', 'stand_applaud'].map(clip));
      return { gpu: body.gpu, skeleton: body.model.skeleton, head: head ? { gpu: head.gpu, skeleton: head.model.skeleton } : null,
        anims: { walk, idle, extras: extras.filter(Boolean) }, walkSpeed: walk ? (rootTravel(walk) / walk.duration) * type.scale : 1.2 };
    })());
  }
  return guestModels.get(type.id);
}
const pathTileAt = (tx, ty) => (paths.tiles.get(tileKey(tx, ty))?.mask ?? 0) !== 0;
// Path tiles next to an exhibit: where guests stop to look at the animals.
let viewingTiles = null, viewingTilesKey = '';
function guestSights() {
  const key = `${paths.tiles.size}|${fences.length}`;
  if (viewingTiles && key === viewingTilesKey) return viewingTiles;
  viewingTilesKey = key;
  const all = [...paths.tiles.values()].filter((t) => t.mask);
  const near = [];
  for (const t of all) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = (t.tx + dx + 0.5) * TILE, y = (t.ty + dy + 0.5) * TILE, region = exhibits.regionAt(x, y);
      if (exhibits.regions[region]?.kind !== 'exhibit') continue;
      near.push({ ...t, region, look: [x, y] });
      break;
    }
  }
  viewingTiles = { all, near };
  return viewingTiles;
}
function frontGate() {
  const gate = entities.find((e) => e.item.types?.some((t) => /^entrance$/i.test(t)));
  if (!gate) return null;
  // The path tile closest to the gate is where guests come in and go out.
  let best = null, bestD = Infinity;
  for (const t of paths.tiles.values()) {
    if (!t.mask) continue;
    const d = Math.hypot((t.tx + 0.5) * TILE - gate.pos[0], (t.ty + 0.5) * TILE - gate.pos[1]);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best && bestD < 6 * TILE ? { gate, tile: best } : null;
}
const maxGuests = () => (guestConfig ? guestConfig.maxBase + guestConfig.maxPerStar * Math.floor(zoo.fame / 20) : 0);
function updateGuestArrivals(dt) {
  if (!guestTypes?.length || !guestConfig?.on || !zoo.open || !dt) return;
  guestSpawnTimer -= dt;
  if (guestSpawnTimer > 0) return;
  const c = guestConfig;
  guestSpawnTimer = c.minDelay + Math.random() * (c.maxDelay - c.minDelay);
  if (guests.length >= maxGuests()) return;
  // APPROX: the chance at each try grows by ZooFamePercentRateIncreasePerStar per star from MinSpawnRate.
  if (Math.random() > c.minRate * (1 + c.ratePerStar * Math.floor(zoo.fame / 20))) return;
  const entry = frontGate();
  if (!entry) return;
  spawnGuest(entry.tile);
}
async function spawnGuest(tile) {
  // About one child for every three adults.
  const pool = guestTypes.filter((t) => t.adult === (Math.random() >= 0.25));
  const list = pool.length ? pool : guestTypes;
  const type = list[Math.floor(Math.random() * list.length)];
  const g = { uid: nextUid++, guest: true, type, item: { id: type.id, name: type.adult ? 'Guest' : 'Child', types: type.types, isGuest: true },
    pos: [(tile.tx + 0.5) * TILE, (tile.ty + 0.5) * TILE, 0], yaw: Math.random() * Math.PI * 2, scale: type.scale,
    route: [], wait: 0, visits: 4 + Math.floor(Math.random() * 8), home: tile, pose: [], clip: null, clipTime: 0, textures: new Map() };
  g.name = uiLoc ? guestName(uiLoc, type) : g.item.name;
  // Cash for the day (guest.xml setInitialCash: $400-600), less the admission.
  g.cash = Math.round(type.cash[0] + Math.random() * (type.cash[1] - type.cash[0]));
  g.status = 'guestactions:GoingToViewAnimal';
  guests.push(g);
  zoo.monthAdmissions = (zoo.monthAdmissions ?? 0) + 1;
  const price = Math.min(g.cash, type.adult ? zoo.admission : zoo.admission / 2);
  if (price > 0) { receive(price, 'admissions_income'); g.cash -= price; }
  // Needs from the guest's AI data (hunger, thirst, rest, bathroom, amusement, happiness...).
  aiData.entity(type.id).then((def) => { if (def) g.mind = new AnimalMind(aiData, def); }).catch(() => {});
  try {
    const m = await guestModel(type);
    Object.assign(g, { gpu: m.gpu, skeleton: m.skeleton, head: m.head, anims: m.anims, walkSpeed: m.walkSpeed, animPaths: await assets.actor(type.actor) });
    play(g, m.anims.idle, true);
    await Promise.all(pickLook(type).map(async ({ material, image, layer }) => {
      // The files name entities/units/guests/shared/..., the pictures live in entities/units/shared/:
      // like the engine, find them by file name.
      const found = assets.fs.has(image) ? image : assets.resolveTexture(image.split('/').slice(0, -1).join('/'), image);
      const t = found ? await assets.texture(found) : null;
      if (!t) return;
      if (!g.textures.has(material)) g.textures.set(material, {});
      g.textures.get(material)[layer] = t;
    }));
  } catch (err) { console.warn(`Guest ${type.id}: ${err.message}`); }
}
function guestRouteTo(g, tile) {
  const route = findPath([g.pos[0], g.pos[1]], [(tile.tx + 0.5) * TILE, (tile.ty + 0.5) * TILE], pathTileAt, { cell: TILE, maxNodes: 4000 });
  g.route = route ? route.slice(1).map(([x, y]) => [x + (Math.random() - 0.5) * 1.6, y + (Math.random() - 0.5) * 1.6]) : [];
  return Boolean(route);
}
function updateGuest(g, dt, world) {
  if (!g.gpu || !dt) return;
  // With the game's AI data loaded, the guest runs the original guest tasks (guest.tsk,
  // ViewAnimal.tsk, food, drinks, restrooms...): see guestWorld for how they act in this zoo.
  if (aiReady && g.mind && g.animPaths) {
    updateAnimalMind(g, dt, world);
    g.status = g.mind.status ?? g.status;
    g.pos[2] = terrain.heightAt(g.pos[0], g.pos[1]);
    advanceClip(g, dt);
    return;
  }
  g.mind?.updateNeeds(dt);
  if (g.route.length) {
    const [tx, ty] = g.route[0];
    const dx = tx - g.pos[0], dy = ty - g.pos[1], d = Math.hypot(dx, dy);
    const step = g.walkSpeed * dt;
    if (d <= step) { g.pos[0] = tx; g.pos[1] = ty; g.route.shift(); }
    else { g.pos[0] += (dx / d) * step; g.pos[1] += (dy / d) * step; }
    const want = Math.atan2(dy, dx) + Math.PI / 2;
    const turn = ((want - g.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    g.yaw += Math.sign(turn) * Math.min(Math.abs(turn), dt * 6);
    play(g, g.anims.walk, true);
    if (!g.route.length) {
      g.wait = 3 + Math.random() * 6;
      g.lookClip = g.anims.extras[Math.floor(Math.random() * g.anims.extras.length)] ?? null;
      if (!g.leaving) g.status = g.sight ? 'guestactions:ViewingAnimals' : 'guestactions:GoingToViewAnimal';
      if (g.sight) viewAnimals(g, g.sight);
    }
  } else if (g.wait > 0) {
    g.wait -= dt;
    play(g, g.lookClip && g.wait > 2 ? g.lookClip : g.anims.idle, true);
  } else if (g.leaving) {
    guests.splice(guests.indexOf(g), 1); // out through the gate
    if (selected === g) select(null);
    guestLeft(g);
    return;
  } else if (g.visits-- > 0) {
    const sights = guestSights();
    g.atSight = sights.near.length > 0 && Math.random() < 0.75;
    const list = g.atSight ? sights.near : sights.all;
    const dest = list[Math.floor(Math.random() * list.length)];
    if (!list.length || !guestRouteTo(g, dest)) g.wait = 2;
    else { g.status = 'guestactions:GoingToViewAnimal'; g.sight = g.atSight ? dest : null; }
  } else {
    g.leaving = true;
    g.status = 'guestactions:LeaveZoo';
    if (!guestRouteTo(g, g.home)) g.route = [];
  }
  g.pos[2] = terrain.heightAt(g.pos[0], g.pos[1]);
  advanceClip(g, dt);
}
// A guest at an exhibit looks at the animals in it: each species seen counts as a view for the
// zoo's fame (education and entertainment per view), and seeing animals satisfies the guest's
// wish to see animals and makes them happier.
// APPROX: the amounts per view (education 5, entertainment 10, needs -15) stand in for the
// original view scoring (f_ViewSpeed, f_MaxQoV...) that comes with the guest AI.
const speciesViews = new Map(); // species -> { viewEvents, entertain }
// How good a guest's view was (ZTBehViewAnimals' score, -1000..1000, which picks the reaction).
// APPROX: the engine's scoring is not in the data. Here each species in view counts 15, each
// further animal 3 (up to 5), scaled by how happy the animals are (needPointsGood vs Bad), and
// the guest's favourite animal counts double (f_PreferredAnimalViewFactor 2); an empty exhibit
// or none in view scores -20.
function guestViewScore(g, target) {
  const result = guestViewScoreOf(g, target);
  // A good look at a species makes the guest want to give to it (the animal's s_DonateToken,
  // t_DonateLion): the Donate<Species> task then looks for a donation box in sight.
  // APPROX: the token comes with every view that scored above zero and lasts two minutes.
  if (result.score > 0 && g.mind) {
    for (const a of result.seen ?? []) {
      const token = a.mind.attrs.s_DonateToken;
      if (token) g.mind.receiveToken({ name: String(token).toLowerCase(), timeout: 120 }, { entity: a });
    }
  }
  return result;
}
function guestViewScoreOf(g, target) {
  if (target?.region === undefined || target.region === null) return { score: -20, animal: null };
  const animals = entities.filter((e) => e.mind && exhibits.regionAt(e.pos[0], e.pos[1]) === target.region);
  if (!animals.length) return { score: -20, animal: null };
  const bySpecies = new Map();
  for (const a of animals) bySpecies.set(a.mind.species, [...(bySpecies.get(a.mind.species) ?? []), a]);
  let score = 0;
  for (const [species, list] of bySpecies) {
    const mood = list.reduce((s, a) => s + (a.mind.needPointsGood - a.mind.needPointsBad), 0) / list.length; // -100..100
    let v = (15 + 3 * Math.min(5, list.length - 1)) * (1 + mood / 200);
    if (g.favorite === species) v *= g.mind?.attrs.f_PreferredAnimalViewFactor ?? 2;
    score += v;
  }
  return { score, animal: animals[Math.floor(Math.random() * animals.length)], seen: [...bySpecies.values()].map((l) => l[0]) };
}
function viewAnimals(g, sight, { needs = true } = {}) {
  const animals = entities.filter((e) => e.mind && exhibits.regionAt(e.pos[0], e.pos[1]) === sight.region);
  if (sight.look) g.yaw = Math.atan2(sight.look[1] - g.pos[1], sight.look[0] - g.pos[0]) + Math.PI / 2;
  if (!animals.length) return;
  const species = new Set(animals.map((e) => e.mind.species));
  for (const sp of species) {
    const v = speciesViews.get(sp) ?? { viewEvents: 0, entertain: 0 };
    v.viewEvents++; v.entertain += 10;
    speciesViews.set(sp, v);
    g.seen ??= new Set();
    g.seen.add(sp);
  }
  g.education = (g.education ?? 0) + 5 * species.size;
  const n = needs ? g.mind?.needs : null; // the AI's reaction sets change the needs of AI guests
  if (n) for (const k of ['viewanimals', 'happiness', 'amusement']) if (k in n) n[k] = Math.max(0, n[k] - 15);
}
// When a guest leaves, the zoo's fame is worked out again (guest.tsk "Adjust_ZooFame" ->
// ZooFame.bin, see fame.js) from the animals, the guests and what they have seen.
function guestLeft(g) {
  const animals = entities.filter((e) => e.mind).map((e) => ({ species: e.mind.species, needPointsGood: e.mind.needPointsGood }));
  const visitors = [...guests, g].filter((x) => x.mind).map((x) => ({ happiness: x.mind.needs.happiness ?? 50, education: x.education ?? 0 }));
  zoo.fameState ??= newFameState();
  const result = adjustZooFame(zoo.fameState, { animals, guests: visitors, speciesSeen: [...speciesViews.values()], animalsReleased: zoo.released ?? 0 });
  zoo.fame = Math.round(result.points);
  renderFame();
}
// The world as the guest AI sees it: guests walk only on paths, stop beside the stands they
// use, look at exhibits from the path, pay for what they buy and leave through the gate.
function guestWorld() {
  const w = animalWorld();
  return Object.assign(w, {
    entities: [...entities, ...guests],
    // Path cells, plus the few metres around where the guest stands (stepping off a bench or out
    // of a building back onto the path).
    passable: (e, goal) => {
      const sx = e.pos[0], sy = e.pos[1];
      const gx = goal?.[0] ?? Infinity, gy = goal?.[1] ?? Infinity;
      return (cx, cy) => pathTileAt(Math.floor((cx + 0.5) / TILE), Math.floor((cy + 0.5) / TILE))
        || Math.hypot(cx + 0.5 - sx, cy + 0.5 - sy) < 5 || Math.hypot(cx + 0.5 - gx, cy + 0.5 - gy) < 2.5;
    },
    // World matrix of a named node of an object's model (docking spots), or null.
    nodeMatrix: (o, name) => (o.skeleton?.byName.has(String(name).toLowerCase()) && o.matrix ? attachMatrix(o, 'mainObj', name) : null),
    isFull: (o, tag, e) => {
      const key = `${o.uid}|${String(tag).toLowerCase()}`;
      const users = guestUsers.get(key);
      if (!users) return false;
      const slots = Math.max(1, (o.ai?.containers ?? []).filter((c) => c.binder === String(tag).toLowerCase()).length);
      // Stands serve a line of guests; other places one guest per slot.
      const capacity = /stand|queue/i.test(tag) ? slots + 3 : slots;
      return users.filter((u) => u !== e).length >= capacity;
    },
    animalHeightAt: (e, x, y) => terrain.heightAt(x, y),
    // "path" targets (GuestViewAnimal_Path): a path spot next to an exhibit within sight, or any.
    pathSpot: (e, sight) => {
      const s = guestSights();
      const inSight = (t) => Math.hypot((t.tx + 0.5) * TILE - e.pos[0], (t.ty + 0.5) * TILE - e.pos[1]) <= sight;
      const near = s.near.filter(inSight), all = s.all.filter(inSight);
      const list = near.length && Math.random() < 0.8 ? near : all;
      const t = list[Math.floor(Math.random() * list.length)];
      if (!t) return null;
      return { pos: [(t.tx + 0.5) * TILE + (Math.random() - 0.5) * 1.6, (t.ty + 0.5) * TILE + (Math.random() - 0.5) * 1.6], face: t.look ?? null, look: t.look ?? null, region: t.region ?? null };
    },
    // Stop beside a building or object (its size plus a step); on open path, at the spot.
    reach: (e, target, near) => {
      if (!target?.entity || target.entity === e) return Math.max(near ?? 0.6, 0.8);
      // Up to the object from the nearest path cell (objects stand beside or on the paths).
      return Math.max(near ?? 0.6, (target.entity.gpu?.radius ?? 1.5) * (target.entity.scale ?? 1) + 1, nearestPathDistance(target.entity.pos) + 0.8);
    },
    viewAnimals: (e, target) => { if (target?.region !== undefined && target.region !== null) viewAnimals(e, target, { needs: false }); },
    viewScore: (e, target) => guestViewScore(e, target),
    economy: guestEconomy,
    trigger: (e, name) => { if (/^adjust_zoofame$/i.test(name)) guestLeft(e); },
    // Thoughts (ZTThoughtInfo): the newest first, a few kept for the guest panel.
    thought: (e, locID, target) => {
      const text = (L(locID) || '').replace('%s', target?.entity?.item?.name ?? '').trim();
      if (!text || e.thoughts?.[0] === text) return;
      e.thoughts = [text, ...(e.thoughts ?? [])].slice(0, 6);
    },
    priceLevel: (target) => target?.entity?.priceIndex ?? target?.entity?.ai?.transactions?.buy_item?.index ?? 1,
    kill: (e) => removeGuest(e),
  });
}
// Distance from a point to the centre of the nearest walkable path cell (1 m cells), up to 9 m.
function nearestPathDistance(p) {
  let best = Infinity;
  for (let dy = -9; dy <= 9; dy++) {
    for (let dx = -9; dx <= 9; dx++) {
      const cx = Math.floor(p[0]) + dx, cy = Math.floor(p[1]) + dy;
      if (!pathTileAt(Math.floor((cx + 0.5) / TILE), Math.floor((cy + 0.5) / TILE))) continue;
      best = Math.min(best, Math.hypot(cx + 0.5 - p[0], cy + 0.5 - p[1]));
    }
  }
  return best === Infinity ? 1.5 : best;
}
function removeGuest(g) {
  const i = guests.indexOf(g);
  if (i >= 0) guests.splice(i, 1);
  if (selected === g) select(null);
}
// ZTBehEconomy for guests: buying at a stand (Buy_Item at the stand's price, paid from the
// guest's cash into the zoo's sales); "failure" when they cannot pay.
function guestEconomy(g, name, target) {
  const key = String(name ?? '').toLowerCase();
  if (key === 'buy_item' || key === 'buy_ticket' || key === 'buy_gift') {
    const stand = target?.entity;
    const tx = stand?.ai?.transactions?.[key] ?? stand?.ai?.transactions?.buy_item;
    if (!tx) return 'complete';
    const price = tx.choices ? tx.choices[Math.max(0, Math.min(tx.choices.length - 1, stand.priceIndex ?? tx.index))] : tx.cost;
    if (g.cash < price) return 'failure';
    g.cash -= price;
    receive(price, tx.category ?? 'concessions_food_drink');
    stand.sales = (stand.sales ?? 0) + price;
    stand.users = (stand.users ?? 0) + 1;
  }
  // A donation (MakeDonation at a box): for the species whose token sent the guest here, the
  // species' f_BaseDonationAmount over the guest's f_DonationDivisor, within f_MinDonation and
  // f_MaxDonation (guest.xml); the box's own amount when the species gives none.
  if (key === 'donate') {
    const box = target?.entity;
    const token = g.mind?.task?.template.tokens.find((t) => /^t_donate/i.test(t));
    const animal = token ? g.mind.tokenPayloads?.get(token)?.entity : null;
    const a = g.mind?.attrs ?? {};
    const base = animal?.mind?.attrs.f_BaseDonationAmount;
    let amount = base ? base / (a.f_DonationDivisor || 5) : box?.ai?.transactions?.donate?.cost ?? 10;
    amount = Math.round(Math.min(a.f_MaxDonation ?? 1000, Math.max(a.f_MinDonation ?? 5, amount)));
    if (g.cash < amount) return 'failure';
    g.cash -= amount;
    receive(amount, 'donations_income');
    if (box) { box.donations = (box.donations ?? 0) + amount; box.donors = (box.donors ?? 0) + 1; }
    if (animal?.mind) {
      const sp = animal.mind.species;
      const d = (zoo.donationsBySpecies ??= {})[sp] ?? { count: 0, amount: 0 };
      d.count++; d.amount += amount;
      zoo.donationsBySpecies[sp] = d;
    }
  }
  return 'complete';
}
// Who is using what: guests with a task that reserves a place (reserveTag) at an object.
const guestUsers = new Map(); // "uid|tag" -> [guest]
function updateGuestUsers() {
  guestUsers.clear();
  for (const g of guests) {
    const t = g.mind?.task;
    const o = t?.target?.entity;
    if (!o || !t.template.reserveTag || o === g) continue;
    const key = `${o.uid}|${t.template.reserveTag.toLowerCase()}`;
    if (!guestUsers.has(key)) guestUsers.set(key, []);
    guestUsers.get(key).push(g);
  }
}
function drawGuests(dt, list) {
  updateGuestArrivals(dt);
  updateGuestUsers();
  const world = guests.length ? guestWorld() : null;
  for (const g of [...guests]) {
    updateGuest(g, dt, world);
    if (!g.gpu || hiddenKinds.has('guest')) continue;
    g.matrix = mat4.fromPosYawScale(g.pos, g.yaw, g.scale);
    const pose = posedNodes(g);
    const tint = g === selected ? SELECT_TINT : undefined;
    list.push({ model: g.gpu, matrix: g.matrix, pose, textures: g.textures, tint });
    if (g.head) {
      const node = g.skeleton.byName.get(g.type.attach.toLowerCase());
      if (node !== undefined) list.push({ model: g.head.gpu, matrix: mat4.multiply(g.matrix, (pose ?? g.skeleton.bindWorld)[node]), textures: g.textures, tint });
    }
  }
}

// ---------------------------------------------------------------------------------------
// Save / restore (this browser only)

let saveTimer = 0;
// Everything the autosave (and a saved game) keeps of the zoo, apart from the terrain.
function zooData() {
  return {
    money,
    camera: { target: camera.target, yaw: camera.yaw, pitch: camera.pitch, distance: camera.distance },
    clock: clock.toJSON(),
    ledger: ledger.toJSON(),
    zoo: { ...zoo },
    entities: entities.map(entitySave),
    fences: fences.map((f) => ({ id: f.item.id, a: f.a, b: f.b, gate: f.gate?.id, broken: f.broken ? (f.broken.id ?? true) : undefined })),
    paths: paths.toJSON(),
  };
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(SAVE_PREFIX + mapName, JSON.stringify(zooData())); } catch { /* storage unavailable */ }
  }, 300);
}

// Named saves (Save / Load screens). A save keeps the zoo, the terrain and a small picture.
const savedTerrain = () => {
  const t = editor.data;
  return { width: t.width, height: t.height, heights: t.heights.slice(), biome: t.biome.slice(), cover: t.cover.slice(),
    waterRegions: t.waterRegions.map((r) => ({ height: r.height, style: r.style, cells: r.cells.slice() })) };
};
let previewRequest = null; // resolve(dataURL) after the next drawn frame
const capturePreview = () => new Promise((resolve) => { previewRequest = resolve; });
async function saveGameAs(name) {
  const preview = await capturePreview();
  const ok = await writeSave(name, { map: mapName, zoo: zooData(), terrain: savedTerrain(), preview });
  toast(ok ? `Saved "${name}"` : 'Could not save (browser storage unavailable or full)');
}
// Loading puts the saved zoo in place of the map's current game and opens that map.
async function loadGame(name) {
  const slot = await readSave(name);
  if (!slot) { toast('That saved game could not be read'); return; }
  try { localStorage.setItem(SAVE_PREFIX + slot.map, JSON.stringify(slot.zoo)); } catch { toast('Could not load (browser storage unavailable)'); return; }
  if (slot.terrain) await saveValue(TERRAIN_KEY(slot.map), slot.terrain);
  else await deleteValue(TERRAIN_KEY(slot.map));
  const url = new URL(location.href);
  url.searchParams.set('map', slot.map);
  devResume(true);
  try { localStorage.setItem(MAP_KEY, slot.map); } catch { /* storage unavailable */ }
  location.href = url.toString();
}
let dialogOpen = false;
async function showSaveLoad(kind) {
  if (dialogOpen) return;
  dialogOpen = true;
  const loc = await (gameLoc ??= new Loc().load(assets.fs));
  const wasPaused = clock.paused;
  clock.paused = true;
  const done = () => { dialogOpen = false; clock.paused = wasPaused; };
  const shared = shellUI?.view.engine;
  if (kind === 'load') await openLoadDialog({ fs: assets.fs, loc, shared, onLoad: (n) => { done(); loadGame(n); }, onClose: done });
  else await openSaveDialog({ fs: assets.fs, loc, shared, onSave: (n) => { done(); saveGameAs(n); }, onClose: done });
}
$('saveButton').onclick = () => showSaveLoad('save');
$('loadButton').onclick = () => showSaveLoad('load');

function restore() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(SAVE_PREFIX + mapName)); } catch { /* storage unavailable */ }
  if (!data) {
    if (mapStart) loadStartingZoo(mapStart);
    return;
  }
  if (data.camera) Object.assign(camera, data.camera);
  clock = new GameClock(data.clock);
  applyTimeOfDay();
  loadZooObjects(data);
}

// Objects of the map's starting zoo (its paths were added with the terrain). Curbs are rebuilt
// from the paths rather than taken from the map.
function loadStartingZoo(map) {
  for (const m of map.entities) {
    const item = catalogById.get(m.type.toLowerCase());
    if (!item?.model || item.isAnimal || item.fence || item.path) continue;
    addEntity({ id: item.id, model: item.model, scale: item.scale * (m.scale || 1), pos: [m.pos[0], m.pos[1], terrain.heightAt(m.pos[0], m.pos[1])], yaw: m.yaw });
  }
  for (const f of map.fences) {
    const item = catalogById.get(f.type.toLowerCase());
    if (!item?.fence || item.group === 'Curbs') continue;
    addFence(item, f.a.map((v) => Math.round(v / TILE)), f.b.map((v) => Math.round(v / TILE)));
  }
  rebuildCurbs();
  save();
}

function loadZooObjects(data) {
  money = data.money ?? START_MONEY;
  zoo = { ...ZOO_DEFAULTS, ...data.zoo };
  ledger = new Ledger(data.ledger);
  for (const e of data.entities ?? []) addEntity(e);
  for (const f of data.fences ?? []) {
    const item = catalogById.get(f.id);
    if (!item?.fence || !addFence(item, f.a, f.b)) continue;
    if (f.gate) {
      const gateItem = catalogById.get(f.gate);
      if (gateItem) addGate(fences.at(-1), gateItem);
    }
    if (f.broken) {
      const brokenItem = catalogById.get(String(f.broken).toLowerCase());
      fences.at(-1).broken = brokenItem ?? { id: null, fenceLoaded: null };
      if (brokenItem) fenceModels(brokenItem);
    }
  }
  rebuildCurbs();
}

// ---------------------------------------------------------------------------------------
// Undo / redo: snapshots of the zoo (and of the terrain for terrain edits) before each action.

const UNDO_LIMIT = 30;
const undoStack = [], redoStack = [];

function zooSnapshot() {
  return {
    money,
    ledger: ledger.toJSON(),
    entities: entities.map(entitySave),
    fences: fences.map((f) => ({ id: f.item.id, a: f.a, b: f.b, gate: f.gate?.id, broken: f.broken ? (f.broken.id ?? true) : undefined })),
    paths: paths.toJSON(),
  };
}

function terrainSnapshot() {
  const t = editor.data;
  return { heights: t.heights.slice(), biome: t.biome.slice(), cover: t.cover.slice(), water: structuredClone(t.waterRegions) };
}

// Call before an action that changes the zoo; withTerrain for actions that change the ground.
function checkpoint(withTerrain = false) {
  undoStack.push({ zoo: zooSnapshot(), terrain: withTerrain ? terrainSnapshot() : null });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
  updateUndoButtons();
}

async function applySnapshot(snap) {
  const pathsBefore = JSON.stringify(paths.toJSON());
  entities.length = 0;
  fences.length = 0;
  occupancy.cells.clear();
  paths.tiles.clear();
  select(null);
  for (const [tx, ty, mask, id] of snap.zoo.paths) {
    const item = catalogById.get(id);
    if (item?.path) paths.add(item, tx, ty, mask);
  }
  loadZooObjects(snap.zoo);
  const t = editor.data, W = t.width, H = t.height;
  if (snap.terrain) {
    t.heights.set(snap.terrain.heights);
    t.biome.set(snap.terrain.biome);
    t.cover.set(snap.terrain.cover);
    t.waterRegions = structuredClone(snap.terrain.water);
    terrain.updateRegion(0, 0, W - 1, H - 1);
    rebuildWater();
    editor.changed = true;
    scheduleTerrainSave();
  }
  if (snap.terrain || JSON.stringify(paths.toJSON()) !== pathsBefore) {
    await terrainSurface.preparePaths();
    terrainSurface.refresh(0, 0, W - 1, H - 1);
    terrainSurface.updateMipmaps();
  }
  updateMoney();
  save();
}

async function undo() {
  const snap = undoStack.pop();
  if (!snap) return;
  redoStack.push({ zoo: zooSnapshot(), terrain: snap.terrain ? terrainSnapshot() : null });
  await applySnapshot(snap);
  updateUndoButtons();
}

async function redo() {
  const snap = redoStack.pop();
  if (!snap) return;
  undoStack.push({ zoo: zooSnapshot(), terrain: snap.terrain ? terrainSnapshot() : null });
  await applySnapshot(snap);
  updateUndoButtons();
}

function updateUndoButtons() {
  $('undoBtn').disabled = !undoStack.length;
  $('redoBtn').disabled = !redoStack.length;
}
$('undoBtn').onclick = undo;
$('redoBtn').onclick = redo;

// A new zoo is the map as it was made (its starting zoo and original terrain).
$('newZoo').onclick = async () => {
  clearTimeout(terrainSaveTimer);
  clearTimeout(saveTimer);
  await deleteValue(TERRAIN_KEY(mapName));
  try { localStorage.removeItem(SAVE_PREFIX + mapName); } catch { /* storage unavailable */ }
  devResume(true); // straight into the new zoo, no menu
  location.reload();
};

// ---------------------------------------------------------------------------------------
// HUD

// Fame stars: five stars, each in two halves of 10 fame points.
function renderFame() {
  // Half stars from fame points; never fewer than one (ZooFame.bin clamps points / 10 to 1..10).
  const halves = Math.max(1, Math.min(10, Math.floor(zoo.fame / 10)));
  let html = '';
  for (let i = 0; i < 5; i++) {
    const n = halves - i * 2;
    html += n >= 2 ? '★' : n === 1 ? '<span style="position:relative"><span class="empty">★</span><span style="position:absolute;left:0;width:50%;overflow:hidden">★</span></span>' : '<span class="empty">★</span>';
  }
  $('stars').innerHTML = html;
  shellUI?.setFame(halves);
  $('fame').title = `Zoo fame: ${halves / 2} stars`;
}

function renderZooStatus() {
  renderFame();
  $('fameText').textContent = `${Math.floor(zoo.fame / 10) / 2} of 5 stars`;
  $('openText').textContent = zoo.open ? 'The zoo is open.' : 'The zoo is closed. No guests visit.';
  $('openBtn').textContent = zoo.open ? 'Close zoo' : 'Open zoo';
  $('priceText').textContent = formatMoney(zoo.admission);
  const level = zoo.admission <= ADMISSION_LEVELS.cheap ? 'cheap' : zoo.admission <= ADMISSION_LEVELS.moderate ? 'moderate' : zoo.admission <= ADMISSION_LEVELS.expensive ? 'expensive' : 'very expensive';
  $('priceNote').textContent = `Adults ${formatMoney(zoo.admission)}, children ${formatMoney(zoo.admission / 2)} (${level}). Higher prices bring fewer guests with higher expectations.`;
}
$('fame').onclick = () => { $('zooStatus').hidden = !$('zooStatus').hidden; $('finances').hidden = true; renderZooStatus(); };
$('statusClose').onclick = () => { $('zooStatus').hidden = true; };
$('openBtn').onclick = () => { zoo.open = !zoo.open; renderZooStatus(); save(); };
$('priceDown').onclick = () => { zoo.admission = Math.max(0, zoo.admission - 1); renderZooStatus(); save(); };
$('priceUp').onclick = () => { zoo.admission = Math.min(100, zoo.admission + 1); renderZooStatus(); save(); };

// The original in-game options menu (ui/layout/ingameoptions.xml); the zoo pauses while it is open.
let optionsOpen = false;
async function showInGameOptions() {
  if (optionsOpen || !uiLoc) return;
  optionsOpen = true;
  const wasPaused = clock.paused;
  clock.paused = true; updateClockText();
  try {
    await openWindow({ fs: assets.fs, loc: uiLoc, shared: shellUI?.view.engine, layout: 'ui/layout/ingameoptions.xml', show: 'In Game Options',
      onMessage: shellMessage, onClose: () => { optionsOpen = false; clock.paused = wasPaused; updateClockText(); } });
  } catch (err) { optionsOpen = false; clock.paused = wasPaused; console.warn(`In-game options: ${err.stack}`); }
}

// The Zoopedia (zoopedia.js); the zoo pauses while it is open.
let zoopediaOpen = false;
async function showZoopedia(entry) {
  if (zoopediaOpen || !uiLoc) return;
  zoopediaOpen = true;
  const wasPaused = clock.paused;
  clock.paused = true; updateClockText();
  const done = () => { zoopediaOpen = false; clock.paused = wasPaused; updateClockText(); };
  try { await openZoopedia({ fs: assets.fs, loc: uiLoc, shared: shellUI?.view.engine, entry, onClose: done }); }
  catch (err) { done(); console.warn(`Zoopedia: ${err.stack}`); }
}

// The original Zoo Status window (zoostatus.js) with this zoo's numbers.
let zooStatusOpen = false;
async function showZooStatus() {
  if (zooStatusOpen || !uiLoc) return;
  zooStatusOpen = true;
  try {
    await openZooStatus({ fs: assets.fs, loc: uiLoc, shared: shellUI?.view.engine, getData: zooStatusData, onMessage: shellMessage, onClose: () => { zooStatusOpen = false; } });
  } catch (err) { zooStatusOpen = false; console.warn(`Zoo status: ${err.stack}`); }
}
// The Zoo Status graphs: the last 24 months (money from the ledger, the rest from the monthly
// snapshots taken at each month's end), with this month so far last.
function zooGraphs() {
  const months = [...ledger.history.slice(-23).map((h) => ({ month: h.month, totals: h.totals })), { month: clock.month, totals: ledger.current }];
  const snap = new Map((zoo.history ?? []).map((h) => [h.month, h]));
  const now = { value: zooValue(), fame: zoo.fame, guests: zoo.monthAdmissions ?? 0, members: 0 };
  const stat = (m, k) => (m.month === clock.month ? now[k] : snap.get(m.month)?.[k] ?? 0);
  return {
    labels: months.map((m) => String((m.month % 12) + 1)),
    series: {
      'profit zoo': months.map((m) => Ledger.net(m.totals)),
      'profit donations_income': months.map((m) => m.totals.donations_income ?? 0),
      'value zoo': months.map((m) => stat(m, 'value')),
      'totalusers admissions': months.map((m) => stat(m, 'guests')),
      'fame fame': months.map((m) => stat(m, 'fame') / 20), // stars (fame points 0..100)
      'members members': months.map((m) => stat(m, 'members')),
    },
  };
}
// Zoo value: cash plus what everything built and adopted is worth.
const zooValue = () => money + entities.reduce((sum, e) => sum + valueOf(e), 0);

function zooStatusData() {
  const catLoc = (c) => `zoostatus:econ_category_${c}`;
  const money = (v) => ({ value: v, text: formatMoney(v) });
  const totals = Object.keys(CATEGORY_NAMES).filter((c) => ledger.current[c]).map((c) => ({ locid: catLoc(c), ...money(ledger.current[c]) }));
  totals.push({ locid: catLoc('Zoo'), ...money(Ledger.net(ledger.current)) });
  // The last three months and this one, oldest first.
  const shown = [...ledger.history.slice(-3).map((h) => ({ month: h.month, totals: h.totals })), { month: clock.month, totals: ledger.current }];
  const cats = Object.keys(CATEGORY_NAMES).filter((c) => shown.some((m) => m.totals[c]));
  const months = shown.map((m) => ({
    label: `Y${Math.floor(m.month / 12) + 1} M${(m.month % 12) + 1}`,
    values: [...cats.map((c) => money(m.totals[c] ?? 0)), money(Ledger.net(m.totals))],
  }));
  const animals = entities.filter((e) => e.mind).map((e) => ({ species: e.mind.species, needPointsGood: e.mind.needPointsGood }));
  const fame = adjustZooFame(structuredClone(zoo.fameState ?? newFameState()), { animals, guests: [], speciesSeen: [], animalsReleased: zoo.released ?? 0 });
  const admissionIndex = zoo.admission <= 0 ? 0 : zoo.admission <= ADMISSION_LEVELS.cheap ? 1 : zoo.admission <= ADMISSION_LEVELS.moderate ? 2 : 3;
  return {
    name: zoo.name ?? 'My Zoo', admissionIndex, admission: formatMoney(zoo.admission), open: zoo.open, guests: guests.length,
    totals, months, categories: [...cats.map(catLoc), catLoc('Zoo')], bars: fame.bars, graphs: zooGraphs(),
  };
}

function updateMoney() {
  $('money').textContent = formatMoney(money);
  shellUI?.setMoney(formatMoney(money), money < 0);
  if (!$('finances').hidden) renderFinances();
}

// Finances panel: this month and the previous one, by category.
function renderFinances() {
  const last = ledger.history.at(-1);
  const columns = [{ label: 'This month', totals: ledger.current }, ...(last ? [{ label: 'Last month', totals: last.totals }] : [])];
  const cats = Object.keys(CATEGORY_NAMES).filter((c) => columns.some((col) => col.totals[c]));
  const cell = (v) => `<td class="${v < 0 ? 'neg' : ''}">${v ? formatMoney(v) : '–'}</td>`;
  $('finTable').innerHTML = `<tr><th></th>${columns.map((c) => `<th>${c.label}</th>`).join('')}</tr>`
    + cats.map((c) => `<tr><td>${CATEGORY_NAMES[c]}</td>${columns.map((col) => cell(col.totals[c] ?? 0)).join('')}</tr>`).join('')
    + `<tr class="total"><td>Total</td>${columns.map((col) => cell(Ledger.net(col.totals))).join('')}</tr>`
    + `<tr><td>Upkeep per month</td>${columns.map((_, i) => (i ? '<td></td>' : cell(-entities.reduce((sum, e) => sum + (e.item.upkeep ?? 0), 0)))).join('')}</tr>`;
}
$('money').onclick = () => { $('finances').hidden = !$('finances').hidden; $('zooStatus').hidden = true; if (!$('finances').hidden) renderFinances(); };
$('finClose').onclick = () => { $('finances').hidden = true; };
function formatMoney(v) {
  const cents = Math.abs(v - Math.round(v)) > 0.001;
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
}

let toastTimer = 0;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

$('gridToggle').onclick = () => {
  showGrid = !showGrid;
  $('gridToggle').classList.toggle('active', showGrid);
};

// ---------------------------------------------------------------------------------------
// Input: mouse, touch and keyboard

const pointers = new Map(); // id -> { x, y, startX, startY, button, moved }
let gesture = null;         // two-finger { dist, angle }
// Movement (pixels) before a press counts as a drag rather than a click; fingers wobble more than mice.
const dragThreshold = (pointerType) => (pointerType === 'mouse' ? 6 : 14);

function screenRay(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const ndcX = ((clientX - r.left) / r.width) * 2 - 1;
  const ndcY = 1 - ((clientY - r.top) / r.height) * 2;
  return camera.ray(ndcX, ndcY, r.width / r.height);
}

let hoverNdc = [0, 0];
function updateHover(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  hoverNdc = [((clientX - r.left) / r.width) * 2 - 1, 1 - ((clientY - r.top) / r.height) * 2];
  hoverPoint = terrain ? terrain.raycast(screenRay(clientX, clientY)) : null;
  if (ghost) ghost.pos = hoverPoint;
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, button: e.button, moved: false, type: e.pointerType, toolClick: false });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    gesture = { dist: Math.hypot(a.x - b.x, a.y - b.y), angle: Math.atan2(b.y - a.y, b.x - a.x), mid: [(a.x + b.x) / 2, (a.y + b.y) / 2] };
    for (const p of pointers.values()) { p.moved = true; p.toolClick = false; } // a two-finger gesture is never a tap
    painting = false;
    fenceDrag = null;
    pathDrag = null;
  }
  updateHover(e.clientX, e.clientY);
  // Path tool: press and drag along tiles.
  if (tool?.path && pointers.size === 1 && e.button === 0) {
    pointers.get(e.pointerId).toolClick = true;
    if (hoverPoint) pathDrag = { start: tileAt(hoverPoint) };
  }
  // Fence tool: press on a tile corner and drag; the left button / single finger never moves the camera.
  if (tool?.fence && pointers.size === 1 && e.button === 0) {
    pointers.get(e.pointerId).toolClick = true;
    if (hoverPoint) fenceDrag = { start: nearestCorner(hoverPoint) };
  }
  // Terrain tools own the left button / single finger: a press starts a stroke, never a camera drag.
  if (terrainTool && pointers.size === 1 && e.button === 0) {
    pointers.get(e.pointerId).toolClick = true;
    if (hoverPoint) {
      checkpoint(true);
      painting = true;
      strokeStart = true;
      terrainTool.flattenHeight = hoverPoint[2] + (terrainTool.flattenOffset ?? 0); // flatten levels to where the stroke starts (cliff/ditch: ±3.5 m)
    }
  }
});

canvas.addEventListener('pointermove', (e) => {
  updateHover(e.clientX, e.clientY);
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > dragThreshold(p.type)) p.moved = true;
  if (!p.moved) return;

  if (pointers.size === 2 && gesture) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y), angle = Math.atan2(b.y - a.y, b.x - a.x);
    const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
    camera.zoom(gesture.dist / dist);
    camera.orbit(angle - gesture.angle, 0);
    const worldPerPixel = (2 * camera.distance * Math.tan(camera.fov / 2)) / canvas.clientHeight;
    camera.pan(-(mid[0] - gesture.mid[0]) * worldPerPixel, (mid[1] - gesture.mid[1]) * worldPerPixel);
    gesture = { dist, angle, mid };
    return;
  }
  if (painting || (p.toolClick && pointers.size === 1)) return; // terrain tools own the left button / single finger
  if (p.button === 2 || p.button === 1) {
    camera.orbit(-dx * 0.008, dy * 0.006);
  } else {
    const worldPerPixel = (2 * camera.distance * Math.tan(camera.fov / 2)) / canvas.clientHeight;
    camera.pan(-dx * worldPerPixel, dy * worldPerPixel);
  }
});

function endPointer(e) {
  const p = pointers.get(e.pointerId);
  pointers.delete(e.pointerId);
  if (pointers.size < 2) gesture = null;
  if (painting) {
    painting = false;
    editor?.update(0, true);
    scheduleTerrainSave();
    return;
  }
  if (pathDrag) {
    updateHover(e.clientX, e.clientY);
    const start = pathDrag.start;
    pathDrag = null;
    if (hoverPoint && e.type !== 'pointercancel') applyPathLine(start, hoverPoint);
    return;
  }
  if (fenceDrag) {
    updateHover(e.clientX, e.clientY);
    if (hoverPoint && e.type !== 'pointercancel') buildFence(fenceLine(fenceDrag.start, hoverPoint));
    fenceDrag = null;
    return;
  }
  if (p?.toolClick) return; // a tool press that never reached the ground
  if (!p || p.moved || e.type === 'pointercancel') { save(); return; }
  // A click / tap.
  if (p.button === 2) { cancelTool(); return; }
  updateHover(e.clientX, e.clientY);
  if (tool?.gateTool) { useGateTool(screenRay(e.clientX, e.clientY)); return; }
  if (tool) placeAt(hoverPoint);
  else if (deleteMode) {
    const target = pickEntity(screenRay(e.clientX, e.clientY));
    if (target && !isProtected(target.item)) { select(target); sellSelected(); }
  } else select(pickEntity(screenRay(e.clientX, e.clientY)));
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => {
  if (pointers.size) return;
  if (ghost) ghost.pos = null;
  hoverPoint = null;
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  camera.zoom(Math.exp(e.deltaY * 0.0012));
  save();
}, { passive: false });

const keys = new Set();
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  keys.add(e.key.toLowerCase());
  if (e.key === 'Escape') { cancelTool(); cancelTerrainTool(); select(null); deleteMode = false; }
  if ((e.key === 'p' || e.key === 'P' || e.key === 'Pause') && !e.ctrlKey && !e.metaKey) togglePause();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected) sellSelected();
  if (e.key.toLowerCase() === 'r' && tool) tool.yaw += Math.PI / 4;
  // Terrain brush size, as the original's hotkeys ([ smaller, ] bigger; ZT_TERRAINCURSOR_SIZE).
  if ((e.key === '[' || e.key === ']') && terrainTool) { changeBrush(e.key === ']' ? 1 : -1); if (!shellUI) toast(`Brush size: ${terrainRadius} m`); }
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

function keyboardCamera(dt) {
  const speed = camera.distance * 1.2 * dt;
  let r = 0, f = 0;
  if (keys.has('a') || keys.has('arrowleft')) r -= speed;
  if (keys.has('d') || keys.has('arrowright')) r += speed;
  if (keys.has('w') || keys.has('arrowup')) f += speed;
  if (keys.has('s') || keys.has('arrowdown')) f -= speed;
  if (r || f) camera.pan(r, f);
  if (keys.has('q')) camera.orbit(dt * 1.5, 0);
  if (cameraHold.rotate) camera.orbit(cameraHold.rotate * dt * 1.2, 0);
  if (cameraHold.zoom) camera.distance = Math.min(camera.maxDistance, Math.max(camera.minDistance, camera.distance * (1 + cameraHold.zoom * dt * 1.2)));
  if (keys.has('e')) camera.orbit(-dt * 1.5, 0);
}

// ---------------------------------------------------------------------------------------
// Main loop

const SELECT_TINT = [1.25, 1.25, 0.9, 1];
const GHOST_OK = [0.7, 1.3, 0.7, 0.6];
const GHOST_BAD = [1.4, 0.5, 0.5, 0.6];
const IDENTITY = mat4.identity();
let last = performance.now();

let sinceAutosave = 0, sincePanel = 0, sinceHabitat = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (terrain) {
    // The zoo's time: animals and other simulation stop while paused; the camera and building do not.
    const simDt = clock.paused ? 0 : dt;
    renderer.time += simDt;
    const hourBefore = Math.floor(clock.hour * 60);
    const monthsEnded = clock.update(dt);
    for (let k = 0; k < monthsEnded; k++) endOfMonth(clock.month - monthsEnded + k);
    if (simDt) applyTimeOfDay();
    if (Math.floor(clock.hour * 60) !== hourBefore || !$('clockText').textContent) updateClockText();
    sinceAutosave += simDt;
    if (aiReady && (sinceHabitat += simDt) > 5) {
      sinceHabitat = 0;
      const stats = exhibitStats();
      for (const e of entities) if (e.mind) updateHabitatNeeds(e, stats.get(exhibits.regionAt(e.pos[0], e.pos[1])));
    }
    if (selected && (sincePanel += dt) > 0.5) {
      sincePanel = 0;
      if (selected.item.isAnimal) $('selInfo').textContent = animalInfo(selected);
      shellUI?.showInfo(infoData(selected));
    }
    if (sinceAutosave > 15) { sinceAutosave = 0; save(); }
    keyboardCamera(dt);
    if (menuOrbit) camera.yaw += dt * 0.05;
    if (followed) {
      if (!entities.includes(followed)) followed = null;
      else { camera.target[0] += (followed.pos[0] - camera.target[0]) * Math.min(1, dt * 4); camera.target[1] += (followed.pos[1] - camera.target[1]) * Math.min(1, dt * 4); }
    }
    camera.target[0] = Math.min(terrain.size[0], Math.max(0, camera.target[0]));
    camera.target[1] = Math.min(terrain.size[1], Math.max(0, camera.target[1]));
    // Ease the camera's focus point onto the ground height so hills stay in view.
    camera.target[2] += (terrain.heightAt(camera.target[0], camera.target[1]) - camera.target[2]) * Math.min(1, dt * 6);
    terrain.grid = showGrid ? TILE : 0;
    if (painting && terrainTool && hoverPoint) {
      if (terrainTool.kind === 'water') {
        if (strokeStart) {
          const t = editor.data, ground = t.biome[Math.min(t.height - 1, Math.floor(hoverPoint[1] / t.cellSize)) * t.width + Math.min(t.width - 1, Math.floor(hoverPoint[0] / t.cellSize))];
          terrainTool.style = waterStyle ?? ground;
          const w = mapBiomeDefs[terrainTool.style]?.water;
          terrainTool.depth = waterDeep ? (w?.deepDepth ?? 6) : (w?.shallowDepth ?? 1);
        }
        editor.paintWater(terrainTool, hoverPoint, strokeStart);
      } else if (terrainTool.kind === 'drain') editor.removeWater(terrainTool, hoverPoint);
      else editor.apply(terrainTool, hoverPoint, dt);
      strokeStart = false;
    }
    editor.update(dt);
    sinceWaterRebuild += dt;
    if (editor.waterDirty && (!painting || sinceWaterRebuild > 0.15)) {
      editor.waterDirty = false;
      sinceWaterRebuild = 0;
      rebuildWater();
    }
    terrain.brush = terrainTool && hoverPoint ? [hoverPoint[0], hoverPoint[1], terrainTool.radius] : null;

    if (exhibitsDirty) {
      exhibitsDirty = false;
      exhibits.rebuild(fences, paths);
    }
    const list = [];
    let world = null;
    for (const skirt of skirts) list.push({ model: skirt, matrix: skirtMatrix });
    if (waterGpu) list.push({ model: waterGpu, matrix: IDENTITY });
    for (const e of entities) {
      if (e.item.isAnimal) {
        world ??= animalWorld();
        if (e.mind) { updateAnimalMind(e, simDt, world); advanceClip(e, simDt); } else updateAnimal(e, simDt);
      }
      e.pos[2] = e.item.isAnimal ? animalHeightAt(e, e.pos[0], e.pos[1]) : terrain.heightAt(e.pos[0], e.pos[1]); // follow terrain edits
      if (e.grow) {
        e.grow.t = Math.min(e.grow.period, e.grow.t + simDt);
        e.scale = e.grow.from + (e.grow.to - e.grow.from) * (e.grow.t / e.grow.period);
        if (e.grow.t >= e.grow.period) e.grow = null;
      }
      if (!e.gpu || hiddenByFilter(e)) continue;
      e.matrix = mat4.fromPosYawScale(e.pos, e.yaw, e.scale);
      list.push({ model: e.gpu, matrix: e.matrix, pose: e.item.isAnimal ? posedNodes(e) : undefined, tint: e === selected ? SELECT_TINT : undefined });
      if (e.parts) drawParts(e, simDt, list, e === selected ? SELECT_TINT : undefined);
    }
    drawGuests(simDt, list);
    const heightAt = (x, y) => terrain.heightAt(x, y);
    const posts = new Map(); // corner key -> post model
    const addPosts = (corners, model) => { for (const c of corners) if (model) posts.set(`${c[0]},${c[1]}`, { c, model }); };
    for (const f of fences) {
      const g = f.broken ? f.broken.fenceLoaded : f.item.fenceLoaded;
      if (!g || (hiddenKinds.has('fence') && !f.item.types?.some((t) => /zooboundary/i.test(t)))) continue;
      const tint = f === selected ? SELECT_TINT : undefined;
      const matrix = segmentMatrix(f.a, f.b, heightAt);
      const gate = f.gate?.gateLoaded;
      if (gate) {
        if (gate.frame.straight) list.push({ model: gate.frame.straight, matrix, tint });
        if (gate.door) list.push({ model: gate.door, matrix, pose: gate.doorPose, tint });
        addPosts([f.a, f.b], gate.frame.post ?? g.post);
        continue;
      }
      const model = isDiagonal(f.a, f.b) ? g.diagonal ?? g.straight : g.straight;
      if (model) list.push({ model, matrix, tint });
      addPosts([f.a, f.b], g.post);
    }
    for (const c of curbs) {
      const g = c.item.fenceLoaded;
      if (!g) continue;
      const model = isDiagonal(c.a, c.b) ? g.diagonal ?? g.straight : g.straight;
      if (model) list.push({ model, matrix: segmentMatrix(c.a, c.b, heightAt) });
    }
    for (const { c, model } of posts.values()) list.push({ model, matrix: postMatrix(c, heightAt) });
    if (tool?.path && hoverPoint) {
      updatePathPreview(pathDrag?.start ?? null, hoverPoint);
      list.push({ model: pathPreview.gpu, matrix: IDENTITY });
    } else if (pathPreview) {
      renderer.deleteModel(pathPreview.gpu);
      pathPreview = null;
    }
    if (tool?.fence && hoverPoint && tool.item.fenceLoaded) {
      const g = tool.item.fenceLoaded;
      const corners = fenceDrag ? fenceLine(fenceDrag.start, hoverPoint) : [nearestCorner(hoverPoint)];
      const affordable = money >= tool.item.cost * Math.max(1, corners.length - 1);
      const tint = affordable ? GHOST_OK : GHOST_BAD;
      for (let k = 1; k < corners.length; k++) {
        const model = isDiagonal(corners[k - 1], corners[k]) ? g.diagonal ?? g.straight : g.straight;
        if (model) list.push({ model, matrix: segmentMatrix(corners[k - 1], corners[k], heightAt), tint });
      }
      if (g.post) for (const c of corners) list.push({ model: g.post, matrix: postMatrix(c, heightAt), tint });
      if (fenceDrag && corners.length > 1) $('fenceInfo').textContent = `${corners.length - 1} × ${formatMoney(tool.item.cost)} = ${formatMoney(tool.item.cost * (corners.length - 1))}`;
    }
    $('fenceInfo').hidden = !(tool?.fence && fenceDrag);
    if (tool?.gateTool && hoverPoint) {
      const f = pickFence(camera.ray(...hoverNdc, canvas.clientWidth / canvas.clientHeight))?.fence;
      if (f) {
        const g = f.item.fenceLoaded;
        const model = g && (isDiagonal(f.a, f.b) ? g.diagonal ?? g.straight : g.straight);
        if (model) list.push({ model, matrix: segmentMatrix(f.a, f.b, heightAt), tint: GHOST_OK });
      }
    }
    if (tool?.item && !tool.fence && !tool.path && ghost?.gpu && ghost.pos) {
      const placed = evaluatePlacement(ghost.pos);
      ghost.valid = !placed.problem && money >= tool.item.cost;
      list.push({ model: ghost.gpu, matrix: mat4.fromPosYawScale(placed.pos, placed.yaw, tool.variant.scale), tint: ghost.valid ? GHOST_OK : GHOST_BAD });
      updateFootprintPreview(placed.cells, ghost.valid);
      if (footprintPreview) list.push({ model: footprintPreview.gpu, matrix: IDENTITY });
    } else if (footprintPreview) {
      renderer.deleteModel(footprintPreview.gpu);
      footprintPreview = null;
    }
    const aspect = renderer.begin([0.62, 0.76, 0.86]);
    const viewProj = camera.viewProj(aspect);
    const skyViewProj = camera.skyViewProj(aspect);
    sky?.draw(skyViewProj, clock.t);
    const sun = sky?.sunAt(clock.t);
    renderer.eye = [0, 0, 0]; // the sky is drawn around the eye
    if (sun) renderer.draw([{ model: sun.gpu, matrix: sun.matrix, tint: [...sun.color, 1] }], skyViewProj);
    terrain.draw(viewProj, terrainLighting);
    renderer.eye = camera.eye();
    renderer.draw(list, viewProj);
    if (previewRequest) {
      // A small picture of the zoo for the Load screen, taken right after drawing.
      const c = document.createElement('canvas');
      c.width = 200; c.height = 150;
      const g = c.getContext('2d'), src = renderer.gl.canvas, s = Math.min(src.width / 4, src.height / 3);
      g.drawImage(src, (src.width - s * 4) / 2, (src.height - s * 3) / 2, s * 4, s * 3, 0, 0, 200, 150);
      previewRequest(c.toDataURL('image/jpeg', 0.75));
      previewRequest = null;
    }
    // Emoticons above heads, facing the camera.
    const emotes = [];
    for (const e of [...entities, ...guests]) {
      if (!e.emote) continue;
      if (hiddenKinds.has('emote')) { e.emote.instance.update(simDt); continue; }
      e.emote.instance.update(simDt);
      if (e.emote.instance.done) { e.emote = null; continue; }
      const top = e.gpu ? e.gpu.bounds.max[2] * e.scale : 1;
      emotes.push({ instance: e.emote.instance, origin: [e.pos[0], e.pos[1], e.pos[2] + top], scale: e.emote.scale, textures: e.emote.textures });
    }
    if (emotes.length) {
      const eye = camera.eye(), f = [camera.target[0] - eye[0], camera.target[1] - eye[1], camera.target[2] - eye[2]];
      const fl = Math.hypot(...f);
      const right = [f[1] / fl, -f[0] / fl, 0], rl = Math.hypot(right[0], right[1]) || 1;
      right[0] /= rl; right[1] /= rl;
      const up = [right[1] * f[2] / fl - 0, -right[0] * f[2] / fl, (right[0] * f[1] - right[1] * f[0]) / fl];
      particleRenderer.draw(emotes, viewProj, right, up);
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
