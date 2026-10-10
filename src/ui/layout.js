// Interpreter for the original UI layouts (ui/layout/*.xml) and templates (ui/template/**):
// UILayout / UIStatic / UIText / UIButton / UIHoverButton / UIToggleButton / UIToggleSet /
// UIListBox elements become absolutely positioned DOM nodes in the layout's own pixel space
// (1024x768 for the menus), scaled to the window. Per element:
//  - UIRegion x y w h with xalign/yalign (min, max = from the far edge, mid, "% min" = percent)
//    and walign/halign (len = length, max = far edge measured from the parent's far edge,
//    min = far edge from the near edge, "% min" = percent of the parent);
//  - UIState visible/active; UIAspect: default image + BFRect (sprite rect) + BFColor, per state
//    (standard/alternate x normal/highlighted/activated/disabled), locid/string text and BFFont;
//  - events (<enter> <leave> <activate> <on> <off>): UI_CHILD show/hide/enable/disable/set
//    locid/activate on named elements; other messages go to the game (onMessage).
// Templates: an element with template="x" starts from ui/template's templateName="x" element.
import { parseXml } from '../xml.js';
import { decodeDDS } from '../dds.js';

const EVENT_TAGS = ['enter', 'leave', 'activate', 'on', 'off', 'deactivate', 'show', 'hide'];
const SINGLE = new Set(['uiregion', 'uistate', 'uihelpinfo', 'text', 'uishowhideanim', 'uihotkeys', 'uitooltip']);

export class UIEngine {
  constructor({ fs, loc, onMessage = () => {} }) {
    this.fs = fs;
    this.loc = loc;
    this.onMessage = onMessage;
    this.templates = new Map();
    this.layouts = new Map();
    this.images = new Map(); // path -> Promise<{ url, width, height } | null>
  }

  async init() {
    const files = this.fs.list((k) => /^ui\/template\/.*\.xml$/i.test(k));
    const texts = await Promise.all(files.map((p) => this.fs.read(p).then((b) => new TextDecoder('latin1').decode(b)).catch(() => '')));
    for (const t of texts) {
      if (!t) continue;
      const root = parseXml(t);
      for (const el of root.name === '#document' ? root.children : [root]) {
        if (el.attrs.templateName) this.templates.set(el.attrs.templateName.toLowerCase(), el);
      }
    }
    return this;
  }

  async layout(path) {
    const key = path.toLowerCase();
    if (!this.layouts.has(key)) this.layouts.set(key, this.fs.read(path).then((b) => parseXml(new TextDecoder('latin1').decode(b))));
    return this.layouts.get(key);
  }

  // Full image as a data URL (UI sheets are small; the browser crops with background-position).
  image(path) {
    const key = path.toLowerCase().replace(/\\/g, '/');
    if (!this.images.has(key)) {
      this.images.set(key, (async () => {
        const p = this.fs.has(key) ? key : [key.replace(/\.tga$/, '.dds'), key.replace(/\.dds$/, '.tga')].find((x) => this.fs.has(x));
        if (!p || !/\.dds$/i.test(p)) return null;
        const img = decodeDDS(await this.fs.read(p));
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer), img.width, img.height), 0, 0);
        return { url: c.toDataURL(), width: img.width, height: img.height };
      })().catch(() => null));
    }
    return this.images.get(key);
  }

  // Cropped sprite (for <img> in text markup); w or h of 0 means the whole picture.
  async sprite(path, x, y, w, h) {
    const im = await this.image(path);
    if (!im) return null;
    if (!(w > 0) || !(h > 0)) { if (!x && !y) return im.url; w = w > 0 ? w : im.width; h = h > 0 ? h : im.height; }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const img = new Image();
    img.src = im.url;
    await img.decode();
    c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
    return c.toDataURL();
  }

  // Applies templates (recursively) and returns a merged element.
  resolve(el, depth = 0) {
    const t = el.attrs.template && this.templates.get(el.attrs.template.toLowerCase());
    if (!t || depth > 8) return el;
    return mergeElements(this.resolve(t, depth + 1), el);
  }

  // Builds a view of a layout element inside `container`, fitted to a design size.
  mount(xmlRoot, container, { width = 1024, height = 768, fit = 'contain' } = {}) {
    return new UIView(this, xmlRoot, container, { width, height, fit });
  }
}

// --- merging templates -------------------------------------------------------------------

function mergeElements(base, over) {
  const attrs = { ...base.attrs, ...over.attrs };
  delete attrs.templateName;
  if (!over.attrs.template) delete attrs.template;
  const children = [];
  const byName = (list, n) => list.find((c) => c.name.toLowerCase() === n);
  const names = new Set([...base.children, ...over.children].map((c) => c.name.toLowerCase()));
  for (const n of names) {
    const a = base.children.filter((c) => c.name.toLowerCase() === n), b = over.children.filter((c) => c.name.toLowerCase() === n);
    if (n === 'uiaspect') children.push(mergeDeep(byName(base.children, n) ?? { name: 'UIAspect', attrs: {}, children: [] }, byName(over.children, n) ?? { name: 'UIAspect', attrs: {}, children: [] }));
    else if (n === 'children') children.push({ name: 'children', attrs: {}, children: [...a.flatMap((c) => c.children), ...b.flatMap((c) => c.children)], text: '' });
    else if (SINGLE.has(n) || EVENT_TAGS.includes(n)) children.push(b[0] ?? a[0]);
    else children.push(...a, ...b);
  }
  return { name: over.name, attrs, children, text: over.text || base.text };
}

// Deep merge of aspect trees: same-named children merge, attributes of `over` win.
function mergeDeep(a, b) {
  const out = { name: b.name, attrs: { ...a.attrs, ...b.attrs }, children: [], text: b.text || a.text };
  const names = [...new Set([...a.children, ...b.children].map((c) => c.name.toLowerCase()))];
  for (const n of names) {
    const ca = a.children.find((c) => c.name.toLowerCase() === n), cb = b.children.find((c) => c.name.toLowerCase() === n);
    out.children.push(ca && cb ? mergeDeep(ca, cb) : cb ?? ca);
  }
  return out;
}

const kid = (el, n) => el?.children.find((c) => c.name.toLowerCase() === n.toLowerCase()) ?? null;
const numOr = (v, d = 0) => { const t = String(v ?? '').trim(); const n = t === '' ? NaN : Number(t); return Number.isFinite(n) ? n : d; };

// --- regions ------------------------------------------------------------------------------

function axis(pos, len, posAlign, lenAlign, parent, last) {
  const special = (v, fallback) => (/^LAST_/.test(String(v).trim()) ? fallback : numOr(v));
  const p = special(pos, 0), l = special(len, last);
  const pa = String(posAlign ?? 'min').replace(/\s+/g, ' ').trim().toLowerCase();
  const la = String(lenAlign ?? 'len').replace(/\s+/g, ' ').trim().toLowerCase();
  let start = pa === 'max' ? parent + p : pa === 'mid' ? parent / 2 + p : pa.startsWith('%') ? parent * p / 100 : p;
  let size;
  if (la === 'max') size = parent + l - start;
  else if (la === 'min') size = l - start;
  else if (la.startsWith('%')) size = parent * l / 100;
  else size = l;
  return [start, Math.max(0, size)];
}

// --- view -----------------------------------------------------------------------------------

export class UIView {
  constructor(engine, xmlRoot, container, opts) {
    this.engine = engine;
    this.opts = opts;
    this.container = container;
    this.stage = document.createElement('div');
    this.stage.className = 'zt-ui';
    Object.assign(this.stage.style, { position: 'absolute', left: '0', top: '0', width: `${opts.width}px`, height: `${opts.height}px`, transformOrigin: '0 0' });
    container.append(this.stage);
    this.nodes = [];
    this.root = this.build(engine.resolve(xmlRoot), null, this.stage);
    this.applySkins();
    this.relayout();
    for (const n of this.nodes) if (n.visible && kid(n.xml, 'UIShowHideAnim')) n.applyVisibility(); // initial show animations
    this.onResize = () => this.relayout();
    window.addEventListener('resize', this.onResize);
  }

  destroy() { window.removeEventListener('resize', this.onResize); this.stage.remove(); }

  // <replacement><skin dir><replace name image/></skin>: images for named elements (e.g. the
  // main menu's backdrop pieces and splash tiles).
  applySkins() {
    for (const n of [...this.nodes]) {
      for (const skin of kid(n.xml, 'replacement')?.children ?? []) {
        let dir = (skin.attrs.dir ?? '').replace(/\\/g, '/');
        // replaceType="directory": one of the folder's picture sets, chosen at random
        // (ui/mainmenu/set06_Grassland/...), as the game does for its menu backdrop.
        const first = skin.children[0]?.attrs.image;
        if (skin.attrs.replaceType === 'directory' && first && !this.engine.fs.has(dir + first)) {
          const tail = `/${first.toLowerCase()}`;
          const sets = [...new Set(this.engine.fs.list((k) => k.startsWith(dir.toLowerCase()) && k.endsWith(tail)).map((p) => p.slice(0, p.length - first.length)))];
          if (sets.length) dir = sets[Math.floor(Math.random() * sets.length)];
        }
        for (const r of skin.children) {
          const target = this.find(r.attrs.name);
          if (target && r.attrs.image) target.setImage(dir + r.attrs.image);
        }
      }
    }
  }

  find(name) {
    const n = String(name).trim().toLowerCase();
    return this.nodes.find((x) => x.name.trim().toLowerCase() === n) ?? null;
  }

  build(xml, parent, dom) {
    const node = new UINode(this, xml, parent);
    this.nodes.push(node);
    dom.append(node.el);
    const kids = kid(xml, 'children')?.children ?? [];
    for (const c of kids) {
      // Visual elements: UI* / ZTUI* widgets, or any ZT* element with its own region (ZTMoneyText...).
      const widget = /^(UI|ZTUI)/i.test(c.name) || (/^ZT/i.test(c.name) && kid(c, 'UIRegion'));
      if (!widget || /^UI(Region|State|Aspect|HelpInfo|HotKeys|ShowHideAnim|Tooltip)$/i.test(c.name)) continue;
      node.children.push(this.build(this.engine.resolve(c), node, node.el));
    }
    return node;
  }

  relayout() {
    const { width, height, fit } = this.opts;
    const cw = this.container.clientWidth || window.innerWidth, ch = this.container.clientHeight || window.innerHeight;
    if (fit === 'contain') {
      const s = Math.min(cw / width, ch / height);
      const ox = (cw - width * s) / 2, oy = (ch - height * s) / 2;
      this.stage.style.transform = `translate(${ox}px, ${oy}px) scale(${s})`;
      this.root.layout(width, height);
      // Full-screen dimmers (dialog backdrops) reach past the 4:3 area to the window's edges.
      for (const n of this.nodes) {
        const b = n.box;
        if (!n.fillEl || !b || b.x !== 0 || b.y !== 0 || b.w < width || b.h < height) continue;
        Object.assign(n.fillEl.style, { left: `${-ox / s}px`, top: `${-oy / s}px`, width: `${cw / s}px`, height: `${ch / s}px` });
      }
    } else {
      // Fill: the layout gets the window's size in its own pixels (scaled by height).
      const s = ch / height;
      this.stage.style.width = `${cw / s}px`;
      this.stage.style.transform = `scale(${s})`;
      this.root.layout(cw / s, height);
    }
  }

  // Runs one <event> list (enter/leave/activate/on/off) of a node.
  run(events, source) {
    for (const ev of events?.children ?? []) {
      if (ev.name !== 'event') continue;
      const msg = ev.attrs.msg;
      if (msg === 'UI_CHILD') {
        const target = this.find(ev.attrs.name);
        // Panels from layouts not built yet: the game may handle them (e.g. "zoo status layout").
        if (!target) {
          // Game modes addressed by name (e.g. "mode_biome" gets ZT_SET_BIOME) and panels not built yet.
          for (const c of ev.children) {
            if (/^ZT_/.test(c.attrs.msg ?? '')) this.engine.onMessage(c.attrs.msg, c.attrs, source, this);
            else if (c.attrs.msg) this.engine.onMessage('UI_CHILD_MISSING', { name: ev.attrs.name, msg: c.attrs.msg }, source, this);
          }
          continue;
        }
        for (const c of ev.children) if (c.attrs.msg) target.message(c.attrs.msg, c.attrs); // <child> (or a nested <event>)
      } else if (msg === 'UI_SELF') {
        for (const c of ev.children) if (c.attrs.msg) source.message(c.attrs.msg, c.attrs);
      } else if (/^UI_/.test(msg)) {
        // No target name: the message goes to the element's parent (a splash tile hides the splash).
        (source.parent ?? source).message(msg, ev.attrs);
      } else {
        this.engine.onMessage(msg, ev.attrs, source, this);
      }
    }
  }
}

class UINode {
  constructor(view, xml, parent) {
    this.view = view;
    this.xml = xml;
    this.parent = parent;
    this.type = xml.name;
    this.name = xml.attrs.name ?? '';
    this.children = [];
    const st = kid(xml, 'UIState')?.attrs ?? {};
    this.visible = st.visible !== 'hidden';
    this.enabled = st.active !== 'disabled';
    this.toggled = xml.attrs.toggle === '1';
    this.state = 'normal';
    this.aspect = kid(xml, 'UIAspect');
    this.locid = this.aspect?.attrs.locid || null;
    // <text format="id">: a styling wrapper whose %text% receives the element's own text.
    this.format = kid(xml, 'text')?.attrs.format ?? null;
    this.string = this.aspect?.attrs.string ?? null;
    this.autosize = xml.attrs.autosize === 'true' && this.type === 'UIText'; // grows with its text (zoopedia pages)
    this.el = document.createElement('div');
    this.el.dataset.ui = this.type;
    if (this.name) this.el.dataset.name = this.name;
    Object.assign(this.el.style, { position: 'absolute', boxSizing: 'border-box' });
    const helpInfo = kid(xml, 'UIHelpInfo')?.attrs ?? {};
    const tip = helpInfo.ids ? view.engine.loc.text(`${helpInfo.ids}_stt`) : helpInfo.short ? view.engine.loc.text(helpInfo.short) : '';
    if (tip) this.el.title = tip;
    // Modal layouts (dialogs) catch all clicks behind them.
    if (xml.attrs.modal === 'true' || this.aspect?.attrs.alwayshit === 'true') this.el.style.pointerEvents = 'auto';
    if (this.type === 'UITextEdit') this.makeInput(xml);
    if (this.autosize) this.el.style.pointerEvents = 'auto'; // links in the text
    this.interactive = /Button$/i.test(this.type);
    if (this.interactive) this.wire();
    this.applyAspect();
    this.applyVisibility();
  }

  wire() {
    const el = this.el;
    el.style.cursor = 'pointer';
    el.style.pointerEvents = 'auto';
    el.addEventListener('pointerenter', () => { if (!this.enabled) return; this.setState('highlighted'); this.view.run(kid(this.xml, 'enter'), this); });
    el.addEventListener('pointerleave', () => { if (!this.enabled) return; this.setState('normal'); this.view.run(kid(this.xml, 'leave'), this); });
    // Plain buttons with <on>/<off> act while held (zoom and rotate the camera).
    const hold = !/Toggle/i.test(this.type) && (kid(this.xml, 'on') || kid(this.xml, 'off'));
    let held = false;
    const release = () => { if (held) { held = false; this.view.run(kid(this.xml, 'off'), this); } };
    el.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      e.stopPropagation();
      this.setState('activated');
      if (hold) { held = true; el.setPointerCapture?.(e.pointerId); this.view.run(kid(this.xml, 'on'), this); }
    });
    el.addEventListener('pointerup', () => { release(); if (this.enabled && this.state === 'activated') this.setState('highlighted'); });
    el.addEventListener('pointercancel', release);
    el.addEventListener('click', (e) => { e.stopPropagation(); if (this.enabled) this.activate(); });
    el.addEventListener('dblclick', (e) => { e.stopPropagation(); if (this.enabled) this.view.run(kid(this.xml, 'doubleclick'), this); });
  }

  activate() {
    if (/ToggleButton$/i.test(this.type)) {
      const set = this.parent?.type === 'UIToggleSet' || this.parent?.type === 'UIListBox' ? this.parent : null;
      if (set) {
        for (const s of set.children) if (s !== this && s.toggled) s.setToggled(false);
        if (!this.toggled) this.setToggled(true);
      } else this.setToggled(!this.toggled);
    }
    this.view.run(kid(this.xml, 'activate'), this);
    this.onActivate?.();
  }

  setToggled(on) {
    this.toggled = on;
    this.applyAspect();
    this.view.run(kid(this.xml, on ? 'on' : 'off'), this);
  }

  setState(s) { this.state = s; this.applyAspect(); }

  message(msg, attrs = {}) {
    switch (msg) {
      case 'UI_SHOW': this.visible = true; this.applyVisibility(); this.view.run(kid(this.xml, 'show'), this); break;
      case 'UI_HIDE': this.visible = false; this.applyVisibility(); break;
      case 'UI_ENABLE': this.enabled = true; this.applyAspect(); break;
      case 'UI_DISABLE': this.enabled = false; this.applyAspect(); break;
      case 'UI_SET_LOCID': this.locid = attrs.string ?? null; this.applyAspect(); break;
      case 'UI_ACTIVATE_ON': if (!this.toggled) this.activate(); break;
      case 'UI_ACTIVATE': this.activate(); break;
      case 'UI_ACTIVATE_OFF': if (this.toggled) this.setToggled(false); break;
      // Shows one child (by name) and hides the others, e.g. a tab's panel.
      case 'UI_SHOW_CHILD_EX': {
        const want = String(attrs.string ?? '').trim().toLowerCase();
        for (const c of this.children) { c.visible = c.name.trim().toLowerCase() === want; c.applyVisibility(); }
        break;
      }
      // Toggle sets: select the next / previous entry (biome arrows).
      case 'UI_SET_NEXT': case 'UI_SET_PREVIOUS': {
        const list = this.children.filter((c) => /ToggleButton$/i.test(c.type) && c.visible);
        if (!list.length) break;
        const i = list.findIndex((c) => c.toggled);
        const next = list[(i + (msg === 'UI_SET_NEXT' ? 1 : -1) + list.length) % list.length];
        next.activate();
        break;
      }
      // A toggle set presses its current button again (or its first one) to refresh what it shows.
      case 'UI_REPRESS': {
        const cur = this.children.find((c) => c.toggled) ?? this.children.find((c) => /ToggleButton$/i.test(c.type) && c.visible);
        if (cur) { cur.toggled = false; cur.activate(); }
        break;
      }
      case 'UI_SET_TEXT': this.value = attrs.string ?? ''; if (this.input) this.input.value = this.value; else this.setText(this.value); break;
      // Copies this element's value to another one (e.g. the selected save's name to a dialog).
      case 'UI_COPY_TEXT': { const t = this.view.find(attrs.string); if (t) { t.value = this.value; if (t.input) t.input.value = this.value ?? ''; } break; }
      // Hands this element's value (selected map, slider amount...) to the game.
      case 'UI_SEND_TEXT': this.view.engine.onMessage(attrs.type, { string: this.value ?? '' }, this, this.view); break;
      default: this.view.engine.onMessage(msg, attrs, this, this.view);
    }
  }

  // UITextEdit: a text field (save names); value follows what is typed.
  makeInput(xml) {
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = Number(xml.attrs.maxlength ?? 64);
    Object.assign(input.style, { position: 'absolute', inset: '0', zIndex: '2', width: '100%', height: '100%', border: 'none', background: 'transparent', color: '#3b5342', font: '13px Arial, sans-serif', padding: '0 6px', pointerEvents: 'auto', outline: 'none' });
    if (this.locid) { input.placeholder = this.view.engine.loc.text(this.locid); this.locid = null; }
    const legal = xml.attrs.legalFilenameOnly === 'true';
    input.addEventListener('input', () => {
      if (legal) input.value = input.value.replace(/[\\/:*?"<>|]/g, '');
      this.value = input.value;
      this.onInput?.(this.value);
      this.view.run(kid(xml, 'textchanged'), this); // e.g. hand a new animal name to the game
    });
    input.addEventListener('keydown', (e) => e.stopPropagation()); // typing must not move the camera
    this.input = input;
    this.el.append(input);
  }

  applyVisibility() {
    this.el.style.display = this.visible ? '' : 'none';
    if (!this.visible) this.animated = false; // animate again on the next show
    // UIShowHideAnim: grow from the start rect (and fade in) when shown.
    const anim = kid(this.xml, 'UIShowHideAnim');
    if (anim && this.visible && this.box && !this.animated) {
      this.animated = true;
      const t = numOr(String(anim.attrs.time ?? '.5').replace(/f$/, ''), 0.5);
      const st = kid(anim, 'start')?.attrs, cs = kid(kid(anim, 'colors'), 'start')?.attrs;
      if (st) {
        // A start size of -1 keeps the element's own size (a panel sliding in from the side).
        const w = numOr(st.w) < 0 ? this.box.w : numOr(st.w), h = numOr(st.h) < 0 ? this.box.h : numOr(st.h);
        const from = { left: `${numOr(st.x)}px`, top: `${numOr(st.y)}px`, width: `${w}px`, height: `${h}px`, opacity: cs ? String(numOr(cs.a, 255) / 255) : '1' };
        const to = { left: `${this.box.x}px`, top: `${this.box.y}px`, width: `${this.box.w}px`, height: `${this.box.h}px`, opacity: '1' };
        this.el.animate([from, to], { duration: t * 1000, easing: 'ease-out' });
      }
    }
  }

  // Aspects come from the (shared) layout tree: copy before changing one element's look.
  ownAspect() {
    if (!this.aspectOwned && this.aspect) { this.aspect = structuredClone(this.aspect); this.aspectOwned = true; }
    return this.aspect;
  }

  setImage(path) {
    const def = kid(this.ownAspect(), 'default');
    if (def) def.attrs = { ...def.attrs, image: path };
    else this.aspect = { name: 'UIAspect', attrs: {}, text: '', children: [{ name: 'default', attrs: { image: path }, children: [], text: '' }] };
    this.applyAspect();
  }

  // Current aspect: default, overridden by the state's entry (alternate set when toggled on).
  current() {
    const a = this.aspect;
    const def = kid(a, 'default');
    const set = kid(a, this.toggled ? 'alternate' : 'standard') ?? kid(a, 'standard');
    const st = kid(set, this.enabled ? this.state : 'disabled') ?? kid(set, 'normal');
    const pick = (n) => kid(st, n) ?? kid(def, n);
    const fontDef = kid(def, 'BFFont'), fontSt = kid(st, 'BFFont');
    return {
      image: st?.attrs.image ?? def?.attrs.image ?? '',
      rect: pick('BFRect')?.attrs ?? null,
      color: pick('BFColor')?.attrs ?? null,
      font: { ...fontDef?.attrs, ...fontSt?.attrs },
      fontColor: (kid(fontSt, 'BFColor') ?? kid(fontDef, 'BFColor'))?.attrs ?? null,
    };
  }

  async applyAspect() {
    const c = this.current();
    const el = this.el;
    this.applied = c;
    const alpha = c.color ? numOr(c.color.a, 255) / 255 : 1;
    if (c.image) {
      const im = await this.view.engine.image(c.image);
      if (this.applied !== c) return;
      if (im && /white1x1/i.test(c.image)) {
        // A 1x1 white image tinted by BFColor: a plain colour fill (dark backdrop of dialogs).
        const col = c.color ?? { r: 255, g: 255, b: 255, a: 255 };
        el.style.backgroundImage = '';
        el.style.opacity = '';
        this.sprite = null;
        // Drawn on its own layer so a full-screen dimmer can reach the window's edges.
        if (!this.fillEl) {
          this.fillEl = document.createElement('div');
          Object.assign(this.fillEl.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', pointerEvents: 'none' });
          el.prepend(this.fillEl);
          queueMicrotask(() => this.view.relayout());
        }
        this.fillEl.style.backgroundColor = `rgba(${numOr(col.r)},${numOr(col.g)},${numOr(col.b)},${alpha})`;
      } else if (im) {
        const r = c.rect ?? {};
        const rw = numOr(r.w, -1) > 0 ? numOr(r.w) : im.width, rh = numOr(r.h, -1) > 0 ? numOr(r.h) : im.height;
        this.sprite = { im, x: numOr(r.x), y: numOr(r.y), w: rw, h: rh };
        el.style.backgroundImage = `url(${im.url})`;
        el.style.backgroundRepeat = 'no-repeat';
        el.style.opacity = String(alpha);
        this.fitSprite();
      }
    } else {
      this.sprite = null;
      el.style.backgroundImage = '';
      el.style.opacity = '';
      // BFColor without an image is only a tint: nothing is drawn.
    }
    // Text: a locid string (with the game's markup) or a literal string.
    // Safe by construction: Loc.html rebuilds only known tags and escapes text; literal strings are escaped.
    const loc = this.view.engine.loc, sprite = (p, x, y, w, h) => this.view.engine.sprite(p, x, y, w, h);
    const content = this.locid ? loc.html(this.locid, this.locArgs ?? [], sprite) : this.string ? escapeHtml(this.string) : '';
    const html = this.format && loc.has(this.format) ? (content ? loc.html(this.format, [], sprite).replace(/%text%/gi, content) : '') : content;
    if (html || this.textEl) {
      if (!this.textEl) {
        this.textEl = document.createElement('div');
        Object.assign(this.textEl.style, this.autosize
          ? { position: 'relative', display: 'block', lineHeight: '1.15' }
          : { position: 'absolute', inset: '0', display: 'flex', alignItems: 'center', pointerEvents: 'none', lineHeight: '1.15', overflow: 'hidden' });
        el.append(this.textEl);
      }
      const align = (c.font.align ?? (this.interactive ? 'center' : 'left')).toLowerCase();
      this.textEl.style.justifyContent = align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start';
      this.textEl.style.textAlign = align;
      this.textEl.style.fontFamily = 'Arial, sans-serif';
      this.textEl.style.fontSize = `${numOr(c.font.size, 12) + 1}px`;
      const fc = c.fontColor;
      this.textEl.style.color = fc ? `rgba(${numOr(fc.r)},${numOr(fc.g)},${numOr(fc.b)},${numOr(fc.a, 255) / 255})` : '#fff';
      this.textEl.innerHTML = `<div>${html}</div>`;
    }
  }

  fitSprite() {
    const s = this.sprite;
    if (!s || !this.box) return;
    const sx = this.box.w / s.w, sy = this.box.h / s.h;
    this.el.style.backgroundSize = `${s.im.width * sx}px ${s.im.height * sy}px`;
    this.el.style.backgroundPosition = `${-s.x * sx}px ${-s.y * sy}px`;
  }

  layout(pw, ph) {
    const r = { ...(kid(this.xml, 'UIRegion')?.attrs ?? { x: 0, y: 0, w: pw, h: ph, walign: 'len', halign: 'len' }), ...this.regionOverride };
    const [x, w] = axis(r.x, r.w, r.xalign, r.walign, pw, pw);
    const [y, h] = axis(r.y, r.h, r.yalign, r.halign, ph, ph);
    this.box = { x, y, w, h };
    Object.assign(this.el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: this.autosize ? 'auto' : `${h}px` });
    if (this.autosize) this.el.style.minHeight = `${h}px`;
    this.fitSprite();
    // List boxes and toggle sets with rows stack their entries vertically.
    // rows="1" columns="-1": one row that grows sideways (need icons).
    const stacked = (this.type === 'UIListBox' || this.type === 'UIToggleSet') && this.xml.attrs.rows !== undefined;
    const across = stacked && this.xml.attrs.rows === '1' && this.xml.attrs.columns === '-1';
    let cursor = 0;
    for (const c of this.children) {
      c.layout(w, h);
      // In a row, a child's x is a gap before it (graph buttons x="15"). In a column, a child placed
      // away from the top keeps its spot over the others (the zoopedia page title).
      const own = kid(c.xml, 'UIRegion')?.attrs;
      if (stacked && !across && numOr(own?.y)) c.el.style.zIndex = '1';
      if (stacked && c.visible && (across || !numOr(own?.y))) {
        const gap = across ? numOr(own?.x) : 0;
        c.el.style[across ? 'left' : 'top'] = `${cursor + gap}px`;
        const size = c.autosize ? c.el.offsetHeight : c.box.h;
        cursor += across ? gap + c.box.w + numOr(this.xml.attrs.xspacer, 0) : size + numOr(this.xml.attrs.yspacer, 0);
      }
    }
    // Lists that grow downwards scroll; rows of tabs and icons do not.
    if (stacked && !across) { this.el.style.overflowY = 'auto'; this.el.style.pointerEvents = 'auto'; }
  }

  // Adds an entry built from a layout element (for lists the game fills: maps, saves...).
  addEntry(xml, setup) {
    const n = this.view.build(this.view.engine.resolve(xml), this, this.el);
    this.children.push(n);
    setup?.(n);
    if (this.box) this.layout(this.parent?.box?.w ?? this.box.w, this.parent?.box?.h ?? this.box.h);
    return n;
  }

  clear() {
    for (const c of [...this.children]) c.remove();
  }

  // Takes this element (and everything in it) out of the view.
  remove() {
    this.el.remove();
    const gone = new Set();
    const walk = (n) => { gone.add(n); n.children.forEach(walk); };
    walk(this);
    this.view.nodes = this.view.nodes.filter((n) => !gone.has(n));
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
  }

  // A named element inside this one (layouts repeat names like "Entity Name Label" per panel).
  find(name) {
    const n = String(name).trim().toLowerCase();
    for (const c of this.children) {
      if (c.name.trim().toLowerCase() === n) return c;
      const d = c.find(name);
      if (d) return d;
    }
    return null;
  }

  // UIMultiIcon: shows the <images> entry with this key (food level, conservation status...).
  setMultiIcon(key) {
    const k = String(key ?? '').toLowerCase();
    const entry = (kid(this.xml, 'images')?.children ?? []).find((c) => String(c.attrs.key).toLowerCase() === k);
    this.visible = Boolean(entry); this.applyVisibility();
    if (!entry || this.multiKey === k) return;
    this.multiKey = k;
    if (entry.attrs.id) this.el.title = this.view.engine.loc.text(entry.attrs.id);
    this.setImage(entry.attrs.image);
  }

  // Replaces the tint (BFColor) of the default aspect, e.g. a need bar's colour.
  setColor(r, g, b, a = 255) {
    const def = kid(this.ownAspect(), 'default');
    if (!def) return;
    const col = { name: 'BFColor', attrs: { r: String(r), g: String(g), b: String(b), a: String(a) }, children: [], text: '' };
    def.children = [...def.children.filter((c) => c.name !== 'BFColor'), col];
    this.applyAspect();
  }

  // Changes this element's region (e.g. a bar's length in percent) and lays it out again.
  setRegion(attrs) {
    this.regionOverride = { ...this.regionOverride, ...Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, String(v)])) };
    if (this.parent?.box) this.layout(this.parent.box.w, this.parent.box.h);
  }

  // Plain text (escaped; e.g. a zoo or map name).
  setText(text) { this.locid = null; this.string = String(text ?? ''); this.applyAspect(); }

  // A game string by locid with %s arguments (arguments are escaped by Loc.html).
  setLoc(locid, args = []) { this.locid = locid; this.locArgs = args; this.applyAspect(); }
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
