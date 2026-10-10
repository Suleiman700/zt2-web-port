// The original Zoo Status window (ui/layout/zoostatus.xml): zoo name, admission price, open or
// closed, this month's money by category, the balance sheet of the last months, and the zoo
// fame bars. The game fills its lists; here they are filled from getData() once a second.
// Graphs, awards, the building list and donations come with the guests (Phase 5).
import { openWindow } from './windows.js';

const el = (name, attrs = {}, children = []) => ({ name, attrs, children, text: '' });
// A text line for the lists the engine fills (category names, amounts, month headers).
const textRow = (w, h, align = 'left') => el('UIText', {}, [
  el('UIRegion', { x: '0', y: '0', w: String(w), h: String(h) }),
  el('UIAspect', {}, [el('default', {}, [el('BFFont', { align })])]),
]);
const column = (w, h) => el('UIListBox', { rows: '-1', columns: '1' }, [el('UIRegion', { x: '0', y: '0', w: String(w), h: String(h) })]);

// data: { name, admissionIndex, admission (text), open, guests, totals: [{ locid, value, text }],
//   months: [{ label, values: [{ value, text }] }], categories: [locid], bars: { name: [value, max] },
//   graphs: { labels: [month label], series: { 'profit zoo': [number], ... } } }
export async function openZooStatus({ fs, loc, shared, getData, onMessage, onClose }) {
  let timer = 0;
  // Graphs tab: which statistic (ZT_GRAPH_SELECTION "profit Zoo ui/layout/moneygraphlabel.xml")
  // and how (bar or line).
  const graph = { key: 'profit zoo', label: 'ui/layout/moneygraphlabel.xml', type: 'line' };
  let drawGraph = () => {};
  const win = await openWindow({ fs, loc, shared, layout: 'ui/layout/zoostatus.xml', show: 'zoo status layout',
    onMessage: (msg, attrs) => {
      if (msg === 'ZT_GRAPH_SELECTION') { const [stat, cat, label] = String(attrs.string ?? '').split(/\s+/); graph.key = `${stat} ${cat}`.toLowerCase(); graph.label = label; drawGraph(); return; }
      if (msg === 'ZT_GRAPHTYPE_SELECTION') { graph.type = attrs.string === 'bar' ? 'bar' : 'line'; drawGraph(); return; }
      onMessage(msg, attrs);
    },
    onClose: () => { clearInterval(timer); onClose?.(); } });
  const { view } = win;

  const first = getData();
  // Zoo name: typed into the original field, kept by the game.
  const nameField = view.find('userstring_zooname');
  if (nameField?.input) { nameField.input.value = first.name; nameField.onInput = (v) => onMessage('ZT_SET_ZOO_NAME', { string: v }); }
  // Current admission price and open/closed state on the toggles.
  const priceSet = view.find('Admission Price ToggleSet');
  const priceButton = priceSet?.children[first.admissionIndex];
  if (priceButton && !priceButton.toggled) priceButton.activate();
  const openSet = view.find('zoo open toggle set');
  const openButton = openSet?.children[first.open ? 0 : 1];
  if (openButton && !openButton.toggled) openButton.activate();

  const fill = (data) => {
    const text = (name, value) => { const n = view.find(name); if (n && n.lastText !== value) { n.lastText = value; n.setText(value); } };
    const price = view.find('Admission Price Display');
    if (price && price.lastText !== data.admission) { price.lastText = data.admission; price.format = price.xml.attrs.posformat; price.setText(data.admission); }
    text('num guest  num', String(data.guests));
    // This month's money by category, with the total.
    const sig = data.totals.map((t) => `${t.locid}=${t.text}`).join();
    const cats = view.find('econ totals categories'), items = view.find('econ totals items');
    if (cats && items && cats.sig !== sig) {
      cats.sig = sig;
      cats.clear(); items.clear();
      for (const t of data.totals) {
        cats.addEntry(textRow(cats.box.w - 70, 20, 'left'), (row) => { row.format = 'zoostatus:misc_label_format'; row.setLoc(t.locid); });
        items.addEntry(textRow(items.box.w, 20, 'right'), (row) => { row.format = t.value < 0 ? 'zoostatus:negformat' : 'zoostatus:posformat'; row.setText(t.text); });
      }
    }
    // Balance sheet: a column per month, a row per category.
    const bsig = data.months.map((m) => m.label + m.values.map((v) => v.text).join()).join('|');
    const bcats = view.find('balance sheet categories'), heads = view.find('balance sheet months'), cols = view.find('balance sheet items');
    if (bcats && heads && cols && bcats.sig !== bsig) {
      bcats.sig = bsig;
      bcats.clear(); heads.clear(); cols.clear();
      for (const locid of data.categories) bcats.addEntry(textRow(bcats.box.w, 20), (row) => { row.format = 'zoostatus:misc_label_format'; row.setLoc(locid); });
      for (const m of data.months) {
        heads.addEntry(textRow(85, 24, 'right'), (row) => { row.format = 'zoostatus:months_label_format'; row.setText(m.label); });
        cols.addEntry(column(85, 340), (col) => {
          for (const v of m.values) col.addEntry(textRow(85, 20, 'right'), (row) => { row.format = v.value < 0 ? 'zoostatus:negformat' : 'zoostatus:posformat'; row.setText(v.text); });
        });
      }
    }
    // Fame: each bar as long as its part of the zoo's fame.
    for (const [name, [value, max]] of Object.entries(data.bars)) {
      const bar = view.find(name)?.find('bar');
      const pct = Math.round(Math.max(0, Math.min(1, max ? value / max : 0)) * 100);
      if (bar && bar.pct !== pct) { bar.pct = pct; bar.setRegion({ w: pct }); }
    }
  };
  // Draws the chosen statistic for the last months in the graph window, with ten y labels in the
  // game's label style (money or plain numbers).
  const labelXml = { money: await win.view.engine.layout('ui/layout/moneygraphlabel.xml'), plain: await win.view.engine.layout('ui/layout/graphlabel.xml') };
  let latest = first;
  drawGraph = () => {
    const fame = graph.key === 'fame fame';
    const g = view.find(fame ? 'graph_fame' : 'graph'), other = view.find(fame ? 'graph' : 'graph_fame');
    if (!g) return;
    if (other?.visible) { other.visible = false; other.applyVisibility(); }
    if (!g.visible) { g.visible = true; g.applyVisibility(); }
    const area = g.find('graphwindow'), ylabels = g.find('y labels');
    if (!area?.box) return;
    const values = latest.graphs.series[graph.key] ?? [];
    const money = /money/i.test(graph.label ?? '');
    // The graph's own axis settings (graphtmpl: 10 labels from 0..10 at least; the fame graph
    // 6 labels over 0..5 stars), widened to fit the values.
    const ga = g.xml.attrs, forced = ga.forceYAxisValues === 'true';
    let max = Math.max(forced ? Number(ga.forcedMaxY ?? 10) : 0, ...values), min = Math.min(forced ? Number(ga.forcedMinY ?? 0) : 0, ...values);
    if (max === min) max = min + 10;
    const W = area.box.w, H = area.box.h - 20;
    let canvas = area.el.querySelector('canvas');
    if (!canvas) {
      canvas = document.createElement('canvas');
      Object.assign(canvas.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', pointerEvents: 'none' });
      area.el.append(canvas);
    }
    canvas.width = W * 2; canvas.height = area.box.h * 2;
    const c = canvas.getContext('2d');
    c.scale(2, 2);
    const y = (v) => H - ((v - min) / (max - min)) * (H - 8);
    c.strokeStyle = 'rgba(255,255,255,0.25)'; c.lineWidth = 1;
    const steps = Math.max(1, Number(ga.numYLabels ?? 10) - 1); // a grid line at each label
    for (let i = 0; i <= steps; i++) { const yy = y(max - (max - min) * i / steps); c.beginPath(); c.moveTo(0, yy); c.lineTo(W, yy); c.stroke(); }
    const n = Math.max(values.length, 1), step = W / Math.max(n, 12);
    c.fillStyle = 'rgba(0,255,0,0.75)'; c.strokeStyle = '#00ff00'; c.lineWidth = 2;
    if (graph.type === 'bar') values.forEach((v, i) => { const top = y(Math.max(v, 0)), bottom = y(Math.min(v, 0)); c.fillStyle = v < 0 ? 'rgba(255,60,60,0.8)' : 'rgba(0,255,0,0.75)'; c.fillRect(i * step + 2, top, step - 4, Math.max(1, bottom - top)); });
    else { c.beginPath(); values.forEach((v, i) => { const px = i * step + step / 2; if (i) c.lineTo(px, y(v)); else c.moveTo(px, y(v)); }); c.stroke(); }
    c.fillStyle = '#fff'; c.font = '10px Arial'; c.textAlign = 'center';
    latest.graphs.labels.forEach((l, i) => c.fillText(l, i * step + step / 2, H + 14));
    // Y labels: ten steps from the top.
    if (ylabels) {
      ylabels.clear();
      const xml = money ? labelXml.money : labelXml.plain;
      for (let i = 0; i <= steps; i++) {
        const v = max - (max - min) * i / steps;
        ylabels.addEntry(xml, (row) => {
          // Level with its grid line (the labels' box starts above the graph window).
          row.setRegion({ y: Math.round(area.box.y - ylabels.box.y + y(v) - 12) });
          if (money) row.format = v < 0 ? row.xml.attrs.negformat : row.xml.attrs.posformat;
          const plain = Math.abs(max - min) < 20 ? String(Math.round(v * 10) / 10) : String(Math.round(v));
          row.setText(money ? `${v < 0 ? '-' : ''}$${Math.abs(Math.round(v)).toLocaleString('en-US')}` : plain);
        });
      }
    }
  };
  fill(first);
  timer = setInterval(() => { if (win.closed) return; latest = getData(); fill(latest); if (view.find('graphs tab layout')?.visible) drawGraph(); }, 1000);
  // The graphs tab draws when it is opened.
  const graphsTab = view.find('graphs tab');
  if (graphsTab) { const prev = graphsTab.onActivate; graphsTab.onActivate = () => { prev?.(); requestAnimationFrame(drawGraph); }; }
  return { close: win.close };
}
