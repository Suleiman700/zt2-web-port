// Minimal XML parser for the game's data files (elements, attributes, text). The game's XML is
// simple: no namespaces or DTDs; comments and processing instructions are skipped.
// Returns the root element { name, attrs, children, text }; a file with several top-level
// elements returns a synthetic root named '#document'.

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENTITIES[e.toLowerCase()] ?? m;
});

export function parseXml(text) {
  const doc = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [doc];
  const tagRe = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!(?:[^>]*)>|<\/\s*([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))*)\s*(\/?)>/g;
  let last = 0, m;
  while ((m = tagRe.exec(text))) {
    const top = stack[stack.length - 1];
    if (m.index > last) top.text += decode(text.slice(last, m.index));
    last = tagRe.lastIndex;
    if (m[1] !== undefined) { top.text += m[1]; continue; }
    if (m[2]) {
      // Closing tag: pop to the matching element (tolerates small nesting mistakes).
      const name = m[2].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name.toLowerCase() === name) { stack.length = i; break; }
      }
      continue;
    }
    if (!m[3]) continue; // comment, PI, doctype
    const attrs = {};
    for (const a of m[4].matchAll(/([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs[a[1]] = decode(a[3] ?? a[4] ?? a[5]);
    const el = { name: m[3], attrs, children: [], text: '' };
    top.children.push(el);
    if (!m[5]) stack.push(el);
  }
  const elements = doc.children;
  return elements.length === 1 ? elements[0] : doc;
}

// Helpers for walking parsed elements (names compared case-insensitively).
export const child = (el, name) => el?.children.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? null;
export const childrenNamed = (el, name) => el?.children.filter((c) => c.name.toLowerCase() === name.toLowerCase()) ?? [];
export function find(el, name) {
  if (!el) return null;
  for (const c of el.children) {
    if (c.name.toLowerCase() === name.toLowerCase()) return c;
    const f = find(c, name);
    if (f) return f;
  }
  return null;
}
export function findAll(el, name, out = []) {
  for (const c of el?.children ?? []) {
    if (c.name.toLowerCase() === name.toLowerCase()) out.push(c);
    findAll(c, name, out);
  }
  return out;
}
