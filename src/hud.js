// The original in-game interface (ui/layout/shell.xml) over the 3D view: primary game buttons,
// build panels, view filters, top bars. Build lists (ZTUITypeList) are filled from the catalog by
// entity type, like the engine does with <kinds>/<kindsExclude>; everything else is the layout.
import { UIEngine } from './ui/layout.js';

const kidNamed = (el, n) => el?.children.find((c) => c.name.toLowerCase() === n.toLowerCase()) ?? null;

export async function mountShell({ fs, loc, container, catalog, iconUrl, onPick, onMessage = () => {} }) {
  // Messages carry the name of the element that sent them (the stand price buttons say nothing
  // else: the game knows the price from which button was pressed).
  const engine = new UIEngine({ fs, loc, onMessage: (msg, attrs, node, view) => onMessage(msg, { ...attrs, sourceName: node?.name ?? '' }, node, view) });
  await engine.init();
  // The in-game screen is several layouts in one tree: the shell and the cash display.
  const layouts = await Promise.all(['ui/layout/shell.xml', 'ui/layout/zoobucksdisplay.xml', 'ui/layout/entityinfo.xml', 'ui/layout/buyinfo.xml'].map((p) => engine.layout(p)));
  const needsItem = await engine.layout('ui/layout/needsitem.xml');
  // Debris left by destroyed buildings (ui/modes/modes.xml <rubblepieces>) is not for sale.
  const modes = new TextDecoder('latin1').decode(await fs.read('ui/modes/modes.xml'));
  // The info panel sits in the bottom right corner (its region is for a 1024 wide screen).
  const toRight = (region) => { if (region) region.attrs = { ...region.attrs, x: String(Number(region.attrs.x) - 1024), xalign: 'max' }; };
  toRight(kidNamed(layouts[2], 'UIRegion'));
  // The buy panel (picked build item or terrain brush) shares that corner.
  toRight(kidNamed(kidNamed(kidNamed(layouts[3], 'children'), 'UILayout'), 'UIRegion'));
  const root = { name: 'UILayout', attrs: { name: 'In Game' }, text: '', children: [
    { name: 'UIRegion', attrs: { x: '0', y: '0', w: '0', h: '0', walign: 'max', halign: 'max' }, children: [], text: '' },
    { name: 'children', attrs: {}, text: '', children: layouts },
  ] };
  const host = document.createElement('div');
  host.className = 'zt-shell';
  container.append(host);
  const view = engine.mount(root, host, { width: 1024, height: 768, fit: 'fill' });

  const rubble = new Set([...(/<rubblepieces>([\s\S]*?)<\/rubblepieces>/.exec(modes)?.[1] ?? '').matchAll(/<(\w+)\s*\/>/g)].map((m) => m[1].toLowerCase()));
  // Fill every typelist with the catalog items of its kinds.
  for (const node of view.nodes) {
    if (node.type !== 'ZTUITypeList') continue;
    const kinds = (kidNamed(node.xml, 'kinds')?.children ?? []).map((c) => c.name.toLowerCase());
    if (node.xml.attrs.kind) kinds.push(node.xml.attrs.kind.toLowerCase());
    const exclude = new Set((kidNamed(node.xml, 'kindsExclude')?.children ?? []).map((c) => c.name.toLowerCase()));
    const items = catalog.filter((it) => !it.hidden && it.types && it.types.some((t) => kinds.includes(t.toLowerCase()))
      && !it.types.some((t) => exclude.has(t.toLowerCase()) || rubble.has(t.toLowerCase())));
    fillTypeList(node, items, { iconUrl, onPick, loc });
  }
  const info = entityInfo(view, needsItem);
  const buy = buyInfo(view);
  return {
    view, host,
    showInfo: info.show,
    showBuy: buy.show,
    // The chosen biome's own paint buttons (deep / shallow water, ground, mix, cover) in the
    // Landscaping panel, as the engine inserts them from biomes/<name>.xml.
    setBiomeButtons(xml) {
      const panel = view.find('Biome Panel');
      if (!panel) return;
      panel.biomeSet?.remove();
      panel.biomeSet = xml ? panel.addEntry(xml) : null;
    },
    destroy: () => { view.destroy(); host.remove(); },
    // Values the engine shows: cash (ZTMoneyText, green or red format), the date, fame stars, pause.
    setMoney(text, negative) {
      for (const name of ['zoo_bucks_static_display']) {
        const n = view.find(name);
        if (!n) continue;
        n.format = negative ? n.xml.attrs.negformat : n.xml.attrs.posformat;
        if (n.lastMoney !== text) { n.lastMoney = text; n.setText(text); }
      }
    },
    setDate(text) { const n = view.find('CurrentDate'); if (n && n.lastText !== text) { n.lastText = text; n.setText(text); } },
    setFame(halfStars) {
      const n = view.find('famestars');
      if (!n) return;
      n.visible = halfStars > 0; n.applyVisibility();
      n.el.style.clipPath = `inset(0 ${100 - (halfStars / 10) * 100}% 0 0)`;
    },
    setPaused(paused) { const n = view.find('pause'); if (n && n.toggled !== paused) { n.toggled = paused; n.applyAspect(); } },
  };
}

// A typelist: icons in `rows` rows, scrolling sideways, as in the original build panels.
// Icons load when their button first comes into view (a build list opens or scrolls), not all
// at once for every list.
const icons = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    icons.unobserve(e.target);
    e.target.loadIcon?.();
  }
});

function fillTypeList(node, items, { iconUrl, onPick }) {
  const rows = Number(node.xml.attrs.rows ?? 2);
  // Square cells, `rows` of them filling the list's height (icons are 128 px pictures).
  const cell = Math.floor(((node.box?.h ?? 118) - 2 * (rows - 1)) / rows);
  const grid = document.createElement('div');
  Object.assign(grid.style, {
    // The list's own box (template "panel": 400x118 under the filter header); icons fill the rows.
    position: 'absolute', left: '0', right: '0', top: '0', bottom: '0', display: 'grid', gridAutoFlow: 'column',
    gridTemplateRows: `repeat(${rows}, ${cell}px)`, gridAutoColumns: `${cell}px`, gap: '2px', overflowX: 'auto', overflowY: 'hidden', pointerEvents: 'auto',
    scrollbarWidth: 'thin',
  });
  for (const it of items) {
    const b = document.createElement('button');
    b.title = `${it.name} - $${(it.cost ?? 0).toLocaleString()}`;
    b.dataset.name = it.id;
    Object.assign(b.style, { width: `${cell}px`, height: `${cell}px`, border: 'none', padding: '0', background: 'transparent', cursor: 'pointer' });
    const img = document.createElement('img');
    img.alt = it.name;
    Object.assign(img.style, { width: '100%', height: '100%' });
    b.append(img);
    b.loadIcon = () => iconUrl(it).then((u) => { if (u) img.src = u; });
    icons.observe(b);
    b.onclick = (e) => { e.stopPropagation(); onPick(it); };
    grid.append(b);
  }
  node.el.append(grid);
}

// The selected object's info panel (ui/layout/entityinfo.xml): one sub-panel per kind of object
// ("Animal Info", "Food Info", "Building Info"...), filled with what the game knows about it.
// data: { panel, name, icon, task, needs: { basic, advanced }, biome, location, gender,
//   conservation, quantity, months, upkeep } (missing fields leave the element as it is).
function entityInfo(view, needsItem) {
  const root = view.find('Entity Info Layout');
  const panels = view.find('Entity Info Panel');
  if (!root || !panels) return { show() {} };
  const hide = () => { root.visible = false; root.applyVisibility(); };
  root.el.style.pointerEvents = 'auto'; // clicks on the panel stay off the zoo
  hide();
  let current = null; // the shown sub-panel
  const text = (p, name, value) => { const n = p.find(name); if (!n || value === undefined) return; if (n.input) { if (document.activeElement !== n.input) n.input.value = value; } else if (n.lastText !== value) { n.lastText = value; n.setText(value); } };
  const loc = (p, name, id) => { const n = p.find(name); if (n && id && n.locid !== id) n.setLoc(id); };
  const image = (p, name, path) => { const n = p.find(name); if (n && path && n.imagePath !== path) { n.imagePath = path; n.setImage(path); } };
  // Need icons: icon by key, a bar over it as high as the need is satisfied, coloured by state.
  // Family tree: a row per relative ("Mother: Nala"), in the list's alternating colours; a click
  // selects that animal.
  // A list of text rows (family tree, a guest's thoughts and inventory): rows in the list's own
  // alternating colours; rows with a uid select that animal or guest when clicked.
  const textList = (list, rows) => {
    if (!list || !rows) return;
    const sig = rows.map((f) => `${f.uid}:${f.text}`).join('|');
    if (list.rowsSig === sig) return;
    list.rowsSig = sig;
    list.clear();
    const colors = (kidNamed(list.xml, 'colors')?.children ?? []).map((c) => c.attrs);
    const w = Math.max(50, (list.box?.w ?? 290) - 4);
    rows.forEach((f, i) => {
      const col = colors[i % Math.max(1, colors.length)] ?? (i % 2 ? { r: '91', g: '117', b: '114', a: '255' } : { r: '77', g: '99', b: '97', a: '255' });
      const row = { name: 'UIButton', attrs: {}, text: '', children: [
        { name: 'UIRegion', attrs: { x: '0', y: '0', w: String(w), h: '18' }, children: [], text: '' },
        { name: 'UIAspect', attrs: {}, text: '', children: [{ name: 'default', attrs: { image: 'ui/shared/white1x1.dds' }, text: '', children: [
          { name: 'BFColor', attrs: col, children: [], text: '' },
          { name: 'BFFont', attrs: { align: 'left' }, children: [], text: '' },
        ] }] },
      ] };
      list.addEntry(row, (n) => { n.setText(f.text); if (f.uid !== undefined) n.onActivate = () => view.engine.onMessage('ZT_SELECT_ENTITY_UID', { x: f.uid }, n, view); });
    });
  };
  const sizedItems = new Map();
  const sized = (size) => {
    if (!sizedItems.has(size)) {
      const xml = structuredClone(needsItem);
      const r = kidNamed(xml, 'UIRegion');
      if (r) r.attrs = { ...r.attrs, w: String(size), h: String(size) };
      sizedItems.set(size, xml);
    }
    return sizedItems.get(size);
  };
  const COLORS = { satisfied: [0, 200, 0], pressing: [230, 200, 0], critical: [220, 0, 0] };
  const needs = (p, name, list) => {
    const box = p.find(name);
    if (!box || !list) return;
    const sig = list.map((n) => n.key).join();
    if (box.needSig !== sig) {
      box.needSig = sig;
      box.clear();
      // Icons shrink to keep the row inside the panel (309 wide; the item is 42x42).
      const size = Math.max(24, Math.min(42, Math.floor((309 - 6 - box.box.x) / Math.max(1, list.length))));
      const item = sized(size);
      for (const n of list) box.addEntry(item, (row) => { row.find('icon background')?.setMultiIcon(n.key); });
    }
    list.forEach((n, i) => {
      const row = box.children[i], fg = row?.find('icon foreground');
      if (!fg) return;
      row.el.title = n.tip ?? '';
      const level = Math.round(Math.max(0, Math.min(1, n.level)) * 100);
      if (fg.level !== level) { fg.level = level; fg.setRegion({ y: 100 - level, h: level }); }
      if (fg.needState !== n.status) { fg.needState = n.status; fg.setColor(...(COLORS[n.status] ?? COLORS.satisfied), 150); }
    });
  };
  return {
    show(data) {
      if (!data) { hide(); current = null; return; }
      const p = panels.children.find((c) => c.name.trim().toLowerCase() === data.panel.toLowerCase());
      if (!p) { hide(); return; }
      if (current !== p) {
        for (const c of panels.children) { c.visible = c === p; c.applyVisibility(); }
        current = p;
        // Back to the first tab (status / price...) for a new kind of object.
        for (const set of p.children.filter((c) => c.type === 'UIToggleSet')) set.message('UI_REPRESS');
      }
      if (!root.visible) { root.visible = true; root.applyVisibility(); }
      if (p.shownFor !== data.id) {
        p.shownFor = data.id;
        image(p, 'Entity Image Display', data.icon);
        text(p, 'Entity Name Label', data.name);
      }
      text(p, 'Task Label', data.task);
      needs(p, 'basic animal needs', data.needs?.basic);
      needs(p, 'advanced animal needs', data.needs?.advanced);
      needs(p, 'state display', data.needs?.states);
      needs(p, 'guest needs', data.needs?.guest);
      if (data.cash !== undefined) { const c = p.find('Guest Cash Display'); if (c && c.lastText !== data.cash) { c.lastText = data.cash; c.format = c.xml.attrs.posformat; c.setText(data.cash); } }
      if (data.biome) { loc(p, 'Biome Name', data.biome.locid); image(p, 'Entity Biome Display', data.biome.icon); }
      if (data.location) { text(p, 'Location Text', data.location.text); image(p, 'Entity Location', data.location.icon); }
      if (data.gender) { loc(p, 'Gender Text', data.gender.locid); image(p, 'Gender Icon', data.gender.icon); }
      if (data.conservation) { p.find('Conservation Image  Display')?.setMultiIcon(data.conservation.key); loc(p, 'Conservation Text', data.conservation.locid); }
      if (data.quantity) { p.find('Quantity Image Display')?.setMultiIcon(data.quantity); p.find('Trash Quantity Image Display')?.setMultiIcon(data.quantity); }
      if (data.family) textList(p.find('Family Tree List'), data.family);
      if (data.thoughts) textList(p.find('thoughts'), data.thoughts.map((text) => ({ text })));
      if (data.inventory) textList(p.find('Inventory'), data.inventory.map((text) => ({ text })));
      zoopediaLink(p.find('zoopedia link'), data.zoopedia);
      if (data.months !== undefined) text(p, 'Month Number', String(data.months));
      // A stand: its price (Cheap / Moderate / Expensive) and what it has taken in.
      if (data.priceIndex !== undefined) {
        const set = p.find('Cost ToggleSet');
        const button = set?.children.filter((c) => /ToggleButton$/.test(c.type))[data.priceIndex];
        if (button && !button.toggled) button.activate(); // also shows the price word (entityinfo:price_med...)
      }
      for (const [name, value] of Object.entries(data.money ?? {})) { const m = p.find(name); if (m && m.lastText !== value) { m.lastText = value; m.format = m.xml.attrs.posformat; m.setText(value); } }
      for (const [name, value] of Object.entries(data.numbers ?? {})) text(p, name, String(value));
      if (data.upkeep !== undefined) for (const n of ['Current Upkeep', 'Lifetime Num']) { const m = p.find(n); if (m && m.lastText !== data.upkeep[n]) { m.lastText = data.upkeep[n]; m.format = m.xml.attrs.posformat; m.setText(data.upkeep[n]); } }
      const sell = p.find('Sell');
      if (sell && sell.enabled !== (data.sellable !== false)) { sell.enabled = data.sellable !== false; sell.applyAspect(); }
    },
  };
}

// The picked build item or terrain brush (ui/layout/buyinfo.xml): name, picture, price and
// upkeep; for animals biome, home region, conservation status and the chosen sex; rotate
// buttons for objects; the brush size for terrain tools.
// data: { kind: 'object' | 'brush', id, name, icon, cost, upkeep, animal: { biome, location,
//   conservation, male }, foliage: { biome, location }, rotate, size }
function buyInfo(view) {
  const panel = view.find('Buy Info Panel');
  if (!panel) return { show() {} };
  const objectPanel = panel.find('Buy Object Panel'), brushPanel = panel.find('Terraform Brush Info Panel');
  const set = (n, on) => { if (n && n.visible !== on) { n.visible = on; n.applyVisibility(); } };
  const text = (p, name, value) => { const n = p?.find(name); if (n && value !== undefined && n.lastText !== value) { n.lastText = value; n.setText(value); } };
  const money = (p, name, value) => { const n = p?.find(name); if (n && n.lastText !== value) { n.lastText = value; n.format = n.xml.attrs.posformat; n.setText(value); } };
  const image = (n, path) => { if (n && path && n.imagePath !== path) { n.imagePath = path; n.setImage(path); } };
  for (const n of ['Research Object Panel', 'research bump', 'Items Sold']) set(panel.find(n), false);
  return {
    show(data) {
      if (!data) { set(panel, false); return; }
      set(panel, true);
      set(objectPanel, data.kind === 'object');
      set(brushPanel, data.kind === 'brush');
      if (data.kind === 'brush') { text(brushPanel, 'Brush Size Num', String(data.size)); return; }
      const p = objectPanel;
      zoopediaLink(p.find('zoopedia link'), data.zoopedia);
      text(p, 'Entity Name Label', data.name);
      image(p.find('Entity Image Display'), data.icon);
      money(p, 'Cost Display', data.cost);
      set(p.find('Upkeep Panel'), Boolean(data.upkeep));
      if (data.upkeep) money(p, 'Upkeep Display', data.upkeep);
      set(p.find('rotate'), Boolean(data.rotate));
      // The gender block is for staff (male / female people); animals use the list's sex toggle
      // and show biome, region and conservation status in the same place.
      set(p.find('gender'), Boolean(data.staff));
      if (data.staff) { set(p.find('male'), false); set(p.find('female'), false); set(p.find('male people'), data.staff.male); set(p.find('female people'), !data.staff.male); }
      const bl = p.find('biome_location_endangerment'), b = p.find('biome');
      set(bl, Boolean(data.animal?.biome));
      set(b, Boolean(data.foliage?.biome));
      const where = data.animal ?? data.foliage;
      const box = data.animal ? bl : b;
      if (box && where?.biome) {
        image(box.find('Biome Icon'), where.biome.icon);
        box.find('Biome Icon').el.title = where.biome.name ?? '';
        if (where.location) { image(box.find('location map'), where.location.icon); box.find('location map').el.title = where.location.text ?? ''; }
        if (data.animal?.conservation) box.find('Buy Panel Conservation Image  Display')?.setMultiIcon(data.animal.conservation);
      }
    },
  };
}

// The panels' Zoopedia buttons open the entry named by the object (s_Zoopedia).
function zoopediaLink(button, entry) {
  if (!button) return;
  button.onActivate = () => button.view.engine.onMessage('ZT_OPEN_ZOOPEDIA', { string: entry || 'zoopedia:zoopedia_home:entry' }, button, button.view);
}
