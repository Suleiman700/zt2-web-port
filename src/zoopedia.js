// The Zoopedia (ui/layout/zoopedia.xml): the contents tree from ui/zoopedia/entries/*.xml
// (BFHelpEntry trees, merged by entry), each entry's page from the language files
// ("<entry>:entry" title, "<entry>:text" page with cells, pictures and links), back / forward
// history and the home button.
import { openWindow } from './windows.js';
import { parseXml } from './xml.js';

let contents = null; // Promise<root node>: { entry, order, children }
function loadContents(fs) {
  contents ??= (async () => {
    const nodes = new Map();
    const node = (entry) => { if (!nodes.has(entry)) nodes.set(entry, { entry, order: null, children: [] }); return nodes.get(entry); };
    const files = fs.list((k) => /^ui\/zoopedia\/entries\/[^/]+\.xml$/i.test(k));
    const texts = await Promise.all(files.map((p) => fs.read(p).then((b) => new TextDecoder('latin1').decode(b))));
    for (const text of texts) {
      const root = parseXml(text);
      const walk = (el, parent) => {
        for (const c of el.children ?? []) {
          if (c.name !== 'BFHelpEntry' || !c.attrs.entry) { walk(c, parent); continue; }
          const n = node(c.attrs.entry.toLowerCase());
          if (c.attrs.order) n.order = c.attrs.order.toLowerCase();
          if (parent && !parent.children.includes(n)) parent.children.push(n);
          walk(c, n);
        }
      };
      walk(root, null);
    }
    for (const n of nodes.values()) n.children.sort((a, b) => (a.order ?? a.entry).localeCompare(b.order ?? b.entry));
    return node('zoopedia_home');
  })();
  return contents;
}

// "zoopedia:zoopedia_lion:entry" (links, s_Zoopedia) -> "zoopedia_lion"
const entryKey = (id) => String(id ?? '').replace(/^zoopedia:/i, '').replace(/:(entry|text)$/i, '').toLowerCase();

export async function openZoopedia({ fs, loc, shared, entry = 'zoopedia_home', onClose }) {
  const tocRows = new Map();
  const back = [], forward = [];
  let current = null, win = null;
  const title = (key) => loc.text(`${key}:entry`) || key.replace(/^zoopedia_/, '');

  function show(id, record = true) {
    const key = entryKey(id) || 'zoopedia_home';
    if (!loc.has(`${key}:entry`) && !loc.has(`${key}:text`)) return;
    if (record && current) { back.push(current); forward.length = 0; }
    current = key;
    const { view } = win;
    view.find('entry name')?.setText(title(key));
    const page = view.find('entry text page 1');
    page?.setLoc(`${key}:text`);
    const list = view.find('text');
    if (list) { list.el.scrollTop = 0; requestAnimationFrame(() => list.layout(list.parent.box.w, list.parent.box.h)); }
    view.find('entry prev name')?.setText(back.length ? title(back.at(-1)) : '');
    view.find('entry next name')?.setText(forward.length ? title(forward.at(-1)) : '');
    for (const [k, el] of tocRows) el.style.background = k === key ? 'rgba(255,255,255,0.18)' : '';
  }

  win = await openWindow({
    fs, loc, shared, layout: 'ui/layout/zoopedia.xml', show: 'ztzoopedia', onClose,
    onMessage(msg, attrs) {
      if (msg === 'UI_HYPERLINK') show(attrs.string);
      else if (msg === 'ZT_ZOOPEDIA_BACK' && back.length) { forward.push(current); show(back.pop(), false); }
      else if (msg === 'ZT_ZOOPEDIA_FORWARD' && forward.length) { back.push(current); show(forward.pop(), false); }
    },
  });

  // Contents: a tree of entries, sections open and close with their arrow (filled once the
  // entry files are read; the page shows at once).
  const toc = win.view.find('TOC');
  loadContents(fs).then((root) => {
    if (!toc || win.closed) return;
    const box = document.createElement('div');
    Object.assign(box.style, { position: 'absolute', inset: '8px', overflowY: 'auto', pointerEvents: 'auto', font: '12px Arial, sans-serif', color: '#fff8b2' });
    const build = (n, depth, parent) => {
      const row = document.createElement('div');
      Object.assign(row.style, { padding: `2px 4px 2px ${depth * 12 + 4}px`, cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
      const kids = document.createElement('div');
      const arrow = n.children.length ? '▸ ' : '';
      row.textContent = arrow + title(n.entry);
      row.title = title(n.entry);
      kids.hidden = depth > 0;
      row.onclick = (e) => {
        e.stopPropagation();
        if (n.children.length) { kids.hidden = !kids.hidden; row.textContent = `${kids.hidden ? '▸' : '▾'} ${title(n.entry)}`; }
        show(n.entry);
      };
      if (n.children.length && !kids.hidden) row.textContent = `▾ ${title(n.entry)}`;
      tocRows.set(n.entry, row);
      parent.append(row, kids);
      for (const c of n.children) build(c, depth + 1, kids);
    };
    build(root, 0, box);
    toc.el.append(box);
    for (const [k, el] of tocRows) el.style.background = k === current ? 'rgba(255,255,255,0.18)' : '';
    // Open the sections down to the shown entry.
    for (let el = tocRows.get(current)?.parentElement; el && el !== box; el = el.parentElement) {
      if (!el.hidden) continue;
      el.hidden = false;
      const head = el.previousElementSibling;
      if (head) head.textContent = head.textContent.replace(/^▸/, '▾');
    }
    tocRows.get(current)?.scrollIntoView({ block: 'center' });
  }).catch((err) => console.warn(`Zoopedia contents: ${err.message}`));
  // Links inside pages.
  const page = win.view.find('entry text page 1');
  page?.el.addEventListener('click', (e) => {
    const a = e.target.closest?.('[data-link]');
    if (a) { e.preventDefault(); e.stopPropagation(); show(a.dataset.link); }
  });
  show(entry, false);
  return win;
}
