// Automated play-testing: drives a headless Chrome over the DevTools protocol with real mouse
// input and saves screenshots. Requires the local server (node tools/serve.mjs 8080).
// Usage: node tools/playtest.mjs <scenario> <out-dir>
// Scenarios are defined at the bottom of this file.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const [scenarioName, outDir = '.'] = process.argv.slice(2);

const profile = await mkdtemp(join(tmpdir(), 'zt2-playtest-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run',
  '--disable-extensions', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', `--window-size=${process.env.PT_SIZE ?? '1200,800'}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, nextId = 1;
const pending = new Map();
const consoleLines = [];

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = targets.find((t) => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        ws.onmessage = (m) => {
          const msg = JSON.parse(m.data);
          if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
          if (msg.method === 'Runtime.consoleAPICalled') consoleLines.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
          if (msg.method === 'Runtime.exceptionThrown') consoleLines.push('EXCEPTION ' + msg.params.exceptionDetails.exception?.description);
        };
        return;
      }
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Could not connect to Chrome');
}

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result))));
}

const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
async function waitFor(expr, timeoutMs = 240000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await evaluate(expr)) return; await sleep(500); }
  throw new Error(`Timed out waiting for: ${expr}`);
}
const mouse = (type, x, y, buttons = 0) => send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: 1, pointerType: 'mouse' });
async function click(x, y) { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, 1); await mouse('mouseReleased', x, y); }
async function clickText(selector, text) {
  const pos = await evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim() === ${JSON.stringify(text)}); if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  await sleep(150);
  if (!pos) throw new Error(`No ${selector} with text ${text}`);
  await click(pos[0], pos[1]);
}
async function drag(points, holdMs = 40) {
  await mouse('mouseMoved', ...points[0]);
  await mouse('mousePressed', ...points[0], 1);
  for (const p of points) { await mouse('mouseMoved', p[0], p[1], 1); await sleep(holdMs); }
  await mouse('mouseReleased', ...points.at(-1));
}
async function screenshot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const file = join(outDir, `${name}.png`);
  await writeFile(file, Buffer.from(data, 'base64'));
  console.log('screenshot', file);
}

const scenarios = {
  // Sculpt and paint terrain with the Terrain tools.
  async terrain() {
    await send('Page.navigate', { url: 'http://localhost:8080/?classic&map=grassland&cam=144,144,45,0.7,-1.2' });
    await waitFor(`document.getElementById('start')?.hidden === true`);
    await sleep(1500);
    await screenshot('terrain-0-before');
    await clickText('#tabs button', 'Terrain');
    await clickText('.tool-row .tool', 'Raise');
    const ring = []; for (let i = 0; i <= 40; i++) ring.push([600 + Math.cos(i / 6) * 30, 430 + Math.sin(i / 6) * 30]);
    await drag(ring, 60);
    await clickText('.tool-row .tool', 'Paint biome');
    await clickText('.biome-grid span', 'Desert');
    const line = []; for (let i = 0; i <= 30; i++) line.push([450 + i * 12, 600]);
    await drag(line, 40);
    await sleep(800);
    await screenshot('terrain-1-after');
  },

  // Just look at a map (MAP, CAM): e.g. its starting zoo.
  async view() {
    const map = process.env.MAP ?? 'grassland';
    const cam = process.env.CAM ? `&cam=${process.env.CAM}` : '';
    const time = process.env.TIME ? `&time=${process.env.TIME}` : '';
    await send('Page.navigate', { url: `http://localhost:8080/?classic&debug&map=${map}${cam}${time}` });
    await waitFor(`document.getElementById('start')?.hidden === true`);
    await sleep(Number(process.env.WAIT ?? 4000));
    console.log('entities', await evaluate(`zt2Debug.entities.length`), 'fences', await evaluate(`zt2Debug.fences.length`), 'path tiles', await evaluate(`zt2Debug.paths.tiles.size`));
    if (process.env.EVAL) console.log(await evaluate(process.env.EVAL));
    await screenshot(`view-${map}${process.env.TIME ? `-t${process.env.TIME}` : ''}`);
  },

  // The original front end: main menu, Freeform, pick a map (MAPNAME text), screenshots of each.
  async menu() {
    await send('Page.navigate', { url: 'http://localhost:8080/' });
    await waitFor(`!!document.querySelector('.zt-frontend [data-name="Freeform Button"]')`);
    await sleep(2500);
    await screenshot('menu-main');
    const center = async (sel) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    await click(600, 300); // close the splash ("Click to Continue")
    await sleep(2500);
    await screenshot('menu-after-splash');
    const free = await center('.zt-frontend [data-name="Freeform Button"]');
    await click(...free);
    await sleep(4000);
    await screenshot('menu-maps');
    const row = await evaluate(`(() => { const rows = [...document.querySelectorAll('.zt-frontend [data-name="Map List"] > div')]; const r = rows.find((x) => x.textContent.includes(${JSON.stringify(process.env.MAPNAME ?? 'Grassland')})) ?? rows[0]; if (!r) return null; r.scrollIntoView({ block: 'center' }); const b = r.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2, rows.length]; })()`);
    console.log('rows', row?.[2]);
    console.log('row0', await evaluate(`(() => { const r = document.querySelector('.zt-frontend [data-name="Map List"] > div'); return r ? r.outerHTML.slice(0, 600) + ' | box ' + JSON.stringify(r.getBoundingClientRect()) : null; })()`));
    if (row) { await click(row[0], row[1]); await sleep(2000); }
    await screenshot('menu-selected');
    if (process.env.PLAY) {
      const play = await center('.zt-frontend [data-name="Play Map"]');
      await click(...play);
      await sleep(1000);
      console.log('url', await evaluate('location.href'));
      await waitFor(`document.getElementById('start')?.hidden === true`);
      await sleep(3000);
      console.log('menu open after play:', await evaluate(`!!document.querySelector('.zt-frontend')`), 'map', await evaluate(`document.getElementById('mapSelect').value`));
      console.log('selected after play:', await evaluate(`document.getElementById('selName').textContent || 'nothing'`));
      await screenshot('menu-played');
      // Development build: a refresh without ?map= goes back to the zoo, not the menu.
      await send('Page.navigate', { url: 'http://localhost:8080/' });
      await waitFor(`document.getElementById('start')?.hidden === true`);
      await sleep(3000);
      console.log('after refresh: menu', await evaluate(`!!document.querySelector('.zt-frontend')`), 'map', await evaluate(`document.getElementById('mapSelect').value`));
    }
  },

  // The original in-game interface (?shell): CLICKS="construction;building" clicks shell elements by
  // name in order and takes a screenshot after each.
  async shell() {
    await send('Page.navigate', { url: `http://localhost:8080/?debug&shell&map=${process.env.MAP ?? 'grassland'}&cam=${process.env.CAM ?? '144,144,40,0.8,-1.2'}` });
    await waitFor(`!!document.querySelector('.zt-shell [data-name="Main Game Buttons"]')`);
    await sleep(3000);
    // PRE_EVAL: set up the zoo first (e.g. adopt an animal and select it).
    if (process.env.PRE_EVAL) { console.log('pre ->', await evaluate(process.env.PRE_EVAL)); await sleep(Number(process.env.PRE_WAIT ?? 3000)); }
    await screenshot('shell-0');
    // STEPS_FILE: a JSON list of { name, eval, wait } run in order, each followed by a screenshot.
    if (process.env.STEPS_FILE) {
      const { readFile } = await import('node:fs/promises');
      for (const st of JSON.parse(await readFile(process.env.STEPS_FILE, 'utf8'))) {
        console.log(st.name, '->', await evaluate(st.eval));
        await sleep(st.wait ?? 2500);
        await screenshot(st.name);
      }
    }
    let k = 0;
    for (const name of (process.env.CLICKS ?? '').split(';').filter(Boolean)) {
      const pos = await evaluate(`(() => { const els = [...document.querySelectorAll('.zt-frontend [data-name], .zt-shell [data-name]')].filter((e) => e.dataset.name.trim().toLowerCase() === ${JSON.stringify(name.toLowerCase())} && e.offsetParent); const el = els[0]; if (!el) return null; const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
      if (!pos && name.startsWith('@')) {
        // @x,y: a click on the map.
        const [x, y] = name.slice(1).split(',').map(Number);
        await mouse('mouseMoved', x, y); await sleep(600); await click(x, y); await sleep(1500);
        if (process.env.SHELL_EVAL) console.log(name, '->', await evaluate(process.env.SHELL_EVAL));
        await screenshot(`shell-${++k}`);
        continue;
      }
      if (!pos) { console.log('not found / hidden:', name); continue; }
      const hit = await evaluate(`(() => { const e = document.elementFromPoint(${pos[0]}, ${pos[1]}); return e ? (e.dataset.name || e.closest('[data-name]')?.dataset.name || e.tagName) : null; })()`);
      await click(...pos);
      await sleep(Number(process.env.CLICK_WAIT ?? 2500));
      if (process.env.SHELL_EVAL) console.log(name, 'hit', hit, '->', await evaluate(process.env.SHELL_EVAL));
      await screenshot(`shell-${++k}`);
    }
  },

  // Screenshot of one page (PAGE=/docs/featured.html), e.g. to render the featured image.
  async page() {
    const [w, h] = (process.env.PT_SIZE ?? '1280,640').split(',').map(Number);
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `http://localhost:8080${process.env.PAGE ?? '/'}` });
    await sleep(Number(process.env.PAGE_WAIT ?? 2500));
    await screenshot('page');
  },

  // Save a zoo under a name, open another map, load it back (original Save / Load screens).
  async saveload() {
    const center = async (sel) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    await send('Page.navigate', { url: 'http://localhost:8080/?classic&debug&map=grassland' });
    await waitFor(`document.getElementById('start')?.hidden === true`);
    await sleep(1500);
    await evaluate(`zt2Debug.build.fence('chainlink', [[40,40],[41,40],[42,40],[43,40]])`);
    const before = await evaluate('zt2Debug.fences.length');
    await click(...await center('#saveButton'));
    await waitFor(`!!document.querySelector('.zt-frontend [data-name="SaveName"] input')`);
    await sleep(1500);
    await evaluate(`(() => { const i = document.querySelector('.zt-frontend [data-name="SaveName"] input'); i.value = 'Test zoo'; i.dispatchEvent(new Event('input')); })()`);
    await screenshot('save-dialog');
    await click(...await center('.zt-frontend [data-name="Save Game Button"]'));
    await sleep(2500);
    console.log('toast:', await evaluate(`document.getElementById('toast').textContent`), 'fences', before);
    await send('Page.navigate', { url: 'http://localhost:8080/?classic&debug&map=desert' });
    await waitFor(`document.getElementById('start')?.hidden === true`);
    await sleep(1500);
    await click(...await center('#loadButton'));
    await waitFor(`!!document.querySelector('.zt-frontend [data-name="SavedGamesList"] > div')`);
    await sleep(1500);
    const row = await center('.zt-frontend [data-name="SavedGamesList"] > div');
    await click(...row);
    await sleep(800);
    await screenshot('load-dialog');
    await click(...await center('.zt-frontend [data-name="TextButton Load"]'));
    await sleep(1500);
    await waitFor(`document.getElementById('start')?.hidden === true`);
    await sleep(1500);
    console.log('after load:', await evaluate('location.search'), 'fences', await evaluate('zt2Debug?.fences.length ?? -1'));
  },

  // Build a small fenced exhibit, put animals in it, and check they stay inside (SPECIES, FENCE_ID, SECS).
  async exhibit() {
    await send('Page.navigate', { url: `http://localhost:8080/?classic&debug&map=grassland&cam=${process.env.CAM ?? '148,148,40,0.8,-1.2'}` });
    await waitFor(`document.getElementById('start')?.hidden === true`);
    await sleep(1500);
    const sq = [[46, 46], [52, 46], [52, 51], [51, 52], [46, 52], [46, 46]]; // 6x6 tiles with one diagonal corner
    const corners = [];
    for (let k = 1; k < sq.length; k++) {
      let [x, y] = sq[k - 1]; const [bx, by] = sq[k];
      if (!corners.length) corners.push([x, y]);
      while (x !== bx || y !== by) { x += Math.sign(bx - x); y += Math.sign(by - y); corners.push([x, y]); }
    }
    const species = process.env.SPECIES ?? 'ZebraCommon';
    await evaluate(`zt2Debug.build.fence(${JSON.stringify(process.env.FENCE_ID ?? 'chainlink')}, ${JSON.stringify(corners)}),
      ${JSON.stringify((process.env.VARIANTS ?? ',,').split(','))}.map((v, i) => zt2Debug.build.animal(${JSON.stringify(species)}, 141 + i * 4, 150 - i * 2, v || undefined))`);
    // POND="148,148,4,3": a pond at x,y with radius and depth.
    if (process.env.POND) await evaluate(`zt2Debug.build.water(${process.env.POND})`);
    // ANIMALS="ZebraCommon@146,146;Lion:Lion_Adult_M@150,148" adds animals of other species.
    for (const spec of (process.env.ANIMALS ?? '').split(';').filter(Boolean)) {
      const [who, at] = spec.split('@'); const [id, variant] = who.split(':'); const [x, y] = at.split(',').map(Number);
      await evaluate(`zt2Debug.build.animal(${JSON.stringify(id)}, ${x}, ${y}, ${JSON.stringify(variant ?? null)})`);
    }
    // OBJECTS="FoodDish_Meat@148,149;FoodDish_Water@143,145" places objects in the exhibit.
    for (const spec of (process.env.OBJECTS ?? '').split(';').filter(Boolean)) {
      const [id, at] = spec.split('@'); const [x, y] = at.split(',').map(Number);
      await evaluate(`zt2Debug.build.object(${JSON.stringify(id)}, ${x}, ${y})`);
    }
    // NEEDS="hunger=80,thirst=80" sets the animals' needs once their AI has started.
    if (process.env.NEEDS) {
      await waitFor(`zt2Debug.entities.filter((e) => e.item.isAnimal).every((e) => e.mind)`, 180000);
      const needs = Object.fromEntries(process.env.NEEDS.split(',').map((kv) => kv.split('=')).map(([k, v]) => [k, Number(v)]));
      const attrs = Object.fromEntries((process.env.ATTRS ?? '').split(',').filter(Boolean).map((kv) => kv.split('=')).map(([k, v]) => [k, Number(v)]));
      await evaluate(`zt2Debug.entities.filter((e) => e.mind).forEach((e) => { Object.assign(e.mind.needs, ${JSON.stringify(needs)}); Object.assign(e.mind.attrs, ${JSON.stringify(attrs)}); e.mind.updateTriggers(); })`);
    }
    await sleep(800);
    const check = `(() => { const ex = zt2Debug.exhibits; return zt2Debug.entities.filter((e) => e.item.isAnimal).map((e) => { const r = ex.regions[ex.regionAt(e.pos[0], e.pos[1])]; return r.kind + ' ' + Math.round(r.area) + 'm2 @' + e.pos.slice(0, 2).map((v) => v.toFixed(1)).join(','); }).join(' | '); })()`;
    console.log('placed:', await evaluate(check));
    // TICK_EVAL: an expression run every 2 s while waiting; changed results are printed.
    let last = null;
    for (let t = 0; t < Number(process.env.SECS ?? 30); t += 2) {
      await sleep(2000);
      if (!process.env.TICK_EVAL) continue;
      const r = await evaluate(process.env.TICK_EVAL);
      if (r !== last && r !== undefined && r !== '') console.log(`t=${t + 2}s`, r);
      last = r;
    }
    console.log('after:', await evaluate(check));
    await screenshot('exhibit');
  },

  // Paint water with the brush (shallow, then deep), then remove part of it.
  async water() {
    const cam = process.env.CAM ?? '144,144,45,0.85,-1.2';
    await send('Page.navigate', { url: `http://localhost:8080/?classic&map=grassland&cam=${cam}` });
    await waitFor(`document.getElementById('start')?.hidden === true`);
    await sleep(1500);
    await clickText('#tabs button', 'Terrain');
    await clickText('.tool-row .tool', 'Add water');
    const line = (x0, x1, y) => { const pts = []; for (let i = 0; i <= 25; i++) pts.push([x0 + (x1 - x0) * i / 25, y]); return pts; };
    await drag(line(500, 800, 420), 50);
    await clickText('.tool-row .tool', 'Deep water');
    await drag(line(550, 750, 520), 50);
    await sleep(800);
    console.log('water regions:', await evaluate(`document.querySelector('#toast') && 'ok'`));
    await screenshot('water-1-painted');
    await clickText('.tool-row .tool', 'Remove water');
    await drag(line(500, 620, 420), 50);
    await sleep(800);
    await screenshot('water-2-removed');
  },

  // Draw a straight and a diagonal fence.
  async fences() {
    const map = process.env.MAP ?? 'grassland';
    const cam = process.env.CAM ?? '144,144,40,0.75,-1.2';
    await send('Page.navigate', { url: `http://localhost:8080/?classic&map=${map}&cam=${cam}` });
    await waitFor(`document.getElementById('start')?.hidden === true`);
    await sleep(1500);
    await clickText('#tabs button', 'Fences');
    await clickText('#items .item span', process.env.FENCE ?? 'Chain Link Fence');
    await sleep(1500);
    const line = (a, b) => { const pts = []; for (let i = 0; i <= 20; i++) pts.push([a[0] + (b[0] - a[0]) * i / 20, a[1] + (b[1] - a[1]) * i / 20]); return pts; };
    await drag(line([480, 380], [880, 380]), 30);
    await drag(line([880, 380], [1050, 560]), 30);
    await sleep(1200);
    console.log('money:', await evaluate(`document.getElementById('money').textContent`));
    await screenshot('fences-1');
    if (process.env.GATE) {
      await clickText('#items .item span', 'Gate');
      await click(700, 410);
      await sleep(2500);
      console.log('money after gate:', await evaluate(`document.getElementById('money').textContent`), 'toast:', await evaluate(`document.getElementById('toast').textContent`));
      await screenshot('fences-gate');
    }
    // Zoom in towards the fence for a close look.
    for (let i = 0; i < 12; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 420, deltaX: 0, deltaY: -120 }); await sleep(30); }
    await sleep(800);
    await screenshot('fences-2-close');
  },

  // Screenshot one model in the viewer: MODEL=<search text>.
  async viewer() {
    await send('Page.navigate', { url: `http://localhost:8080/viewer.html?model=${encodeURIComponent(process.env.MODEL)}` });
    await waitFor(`document.getElementById('status')?.textContent.includes('triangles')`);
    await sleep(800);
    console.log(await evaluate(`document.getElementById('status').textContent`));
    await screenshot('viewer');
    if (process.env.ZOOMOUT) {
      for (let i = 0; i < Number(process.env.ZOOMOUT); i++) { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 750, y: 400, deltaX: 0, deltaY: 120 }); await sleep(20); }
      await sleep(500);
      await screenshot('viewer-far');
    }
  },

  // Draw a straight and a diagonal path.
  async paths() {
    const cam = process.env.CAM ?? '144,144,35,0.85,-1.2';
    await send('Page.navigate', { url: `http://localhost:8080/?classic&map=grassland&cam=${cam}` });
    await waitFor(`document.getElementById('start')?.hidden === true`);
    await sleep(1500);
    await clickText('#tabs button', 'Paths');
    await clickText('#items .item span', process.env.PATH_TYPE ?? 'Brick Path');
    const line = (a, b) => { const pts = []; for (let i = 0; i <= 20; i++) pts.push([a[0] + (b[0] - a[0]) * i / 20, a[1] + (b[1] - a[1]) * i / 20]); return pts; };
    await drag(line([480, 420], [900, 420]), 30);
    await sleep(500);
    await drag(line([900, 420], [1080, 600]), 30);
    await sleep(2500);
    console.log('money:', await evaluate(`document.getElementById('money').textContent`));
    await screenshot('paths-1');
  },

  // Place a building, try to place another on top of it, and show the footprint preview.
  async placement() {
    await send('Page.navigate', { url: `http://localhost:8080/?classic&debug&map=grassland&cam=${process.env.CAM ?? '144,144,35,0.85,-1.2'}` });
    await waitFor(`document.getElementById('start')?.hidden === true`);
    await sleep(1500);
    await clickText('#tabs button', process.env.TAB ?? 'Buildings');
    // PRE_CLICK="selector|text": an extra click before picking the item (e.g. the Male toggle).
    if (process.env.PRE_CLICK) { const [sel, text] = process.env.PRE_CLICK.split('|'); await clickText(sel, text); await sleep(300); }
    await clickText('#items .item span', process.env.ITEM ?? 'Animal Photo Booth');
    await sleep(2000);
    const [px, py] = (process.env.AT ?? '700,450').split(',').map(Number);
    await mouse('mouseMoved', px, py);
    await sleep(500);
    await click(px, py);
    await sleep(800);
    console.log('after first:', await evaluate(`document.getElementById('money').textContent`));
    await click(px, py);
    await sleep(500);
    console.log('second attempt toast:', await evaluate(`document.getElementById('toast').textContent`), '| money', await evaluate(`document.getElementById('money').textContent`));
    await sleep(1500);
    console.log('last placed entities:', await evaluate(`JSON.stringify(window.zt2Debug?.entities.slice(-3).map((e) => ({ id: e.id, pos: e.pos.map((v) => +v.toFixed(2)), parts: (e.parts ?? []).map((p) => ({ name: p.def.name, at: p.matrix ? [12, 13, 14].map((i) => +p.matrix[i].toFixed(2)) : null, scale: p.matrix ? +Math.hypot(p.matrix[0], p.matrix[1], p.matrix[2]).toFixed(2) : null, bounds: p.gpu?.bounds })) })))`));
    await mouse('mouseMoved', 760, 470);
    await sleep(800);
    await screenshot('placement-1');
  },

  // Undo / redo of placing an object and of drawing a path.
  async undo() {
    await send('Page.navigate', { url: 'http://localhost:8080/?classic&debug&map=grassland&cam=144,144,35,0.85,-1.2' });
    await waitFor(`document.getElementById('start')?.hidden === true`);
    await sleep(1500);
    const key = async (k, mods = 2) => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: 'Key' + k.toUpperCase(), modifiers: mods, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: 'Key' + k.toUpperCase(), modifiers: mods, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) });
      await sleep(1200);
    };
    const state = () => evaluate(`JSON.stringify({ entities: window.zt2Debug.entities.length, paths: window.zt2Debug.paths.tiles.size, money: document.getElementById('money').textContent })`);
    await clickText('#tabs button', 'Buildings');
    await clickText('#items .item span', 'ATM');
    await sleep(1500);
    await mouse('mouseMoved', 700, 450); await sleep(300); await click(700, 450); await sleep(800);
    console.log('placed      ', await state());
    await key('z'); console.log('undo        ', await state());
    await key('y'); console.log('redo        ', await state());
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await clickText('#tabs button', 'Paths');
    await clickText('#items .item span', 'Brick Path');
    const line = []; for (let i = 0; i <= 15; i++) line.push([500 + i * 20, 560]);
    await drag(line, 30); await sleep(1500);
    console.log('path drawn  ', await state());
    await key('z'); console.log('undo path   ', await state());
    await screenshot('undo-after');
  },
};

try {
  await connect();
  await send('Runtime.enable');
  await send('Page.enable');
  if (!scenarios[scenarioName]) throw new Error(`Unknown scenario ${scenarioName}; have ${Object.keys(scenarios).join(', ')}`);
  await scenarios[scenarioName]();
  // AFTER: an expression to run once the scenario is done (e.g. open a panel), then a screenshot.
  if (process.env.AFTER) {
    console.log('after:', await evaluate(process.env.AFTER));
    await sleep(500);
    await screenshot(`${scenarioName}-after`);
  }
} catch (err) {
  console.error('FAILED:', err.message);
  process.exitCode = 1;
} finally {
  if (process.env.DEBUG) console.log(['Console:', ...consoleLines].join(String.fromCharCode(10)));
  const problems = consoleLines.filter((l) => /EXCEPTION|error/i.test(l));
  if (problems.length) console.log('Console problems:\n' + problems.join('\n'));
  ws?.close();
  chrome.kill();
  await sleep(500);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
