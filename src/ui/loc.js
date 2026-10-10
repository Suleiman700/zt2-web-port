// The game's text strings (lang/<language>/*.xml LOC_STRING entries) and their markup:
// <font name size shadowx shadowy shadowa>, <color r g b>, <b>, <i>, <u>, <br>, <p>, <img src sx sy
// sw sh width height>, <cell>. Markup becomes safe HTML (only these tags, attributes rebuilt);
// images are resolved through `sprite(path, x, y, w, h)` -> Promise<dataURL>.

export class Loc {
  constructor() { this.strings = new Map(); this.versions = new Map(); } // locID (lowercase) -> raw markup

  async load(fs, language = '1033') {
    const files = fs.list((k) => k.toLowerCase().startsWith(`lang/${language}/`) && /\.xml$/i.test(k));
    const texts = await Promise.all(files.map((p) => fs.read(p).then((b) => decodeText(b)).catch(() => '')));
    for (const text of texts) {
      // Patches and expansions repeat strings with a higher version="" (the newest wins).
      for (const m of text.matchAll(/<LOC_STRING\s+_locID="([^"]+)"([^>]*)>([\s\S]*?)<\/LOC_STRING>/g)) {
        const id = m[1].toLowerCase(), version = Number(/version="(\d+)"/.exec(m[2])?.[1] ?? 0);
        if ((this.versions.get(id) ?? -1) > version) continue;
        this.strings.set(id, m[3]);
        this.versions.set(id, version);
      }
    }
    return this;
  }

  has(id) { return this.strings.has(String(id).toLowerCase()); }
  raw(id) { return this.strings.get(String(id).toLowerCase()) ?? null; }

  // Plain text (markup removed, whitespace collapsed).
  text(id, ...args) {
    const raw = this.raw(id);
    if (raw === null) return '';
    return fill(decode(raw.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t\r\n]+/g, (s) => (s.includes('\n') && /<br/i.test(raw) ? '\n' : ' ')).trim(), args);
  }

  // HTML for the string, or '' when unknown. `args` fill %s / %1s / %d placeholders.
  html(id, args = [], sprite = null) {
    const raw = this.raw(id);
    return raw === null ? '' : markupToHtml(fill(raw, args), sprite);
  }
}

// Language files are UTF-8 (some with a byte-order mark); a few older ones may be UTF-16.
function decodeText(b) {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  return new TextDecoder('utf-8').decode(b);
}

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+);/gi, (m, e) => (e[0] === '#' ? String.fromCharCode(Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m));
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// %s, %1s, %2s, %d, %1d ... filled in order (numbered ones by number).
function fill(s, args) {
  if (!args?.length) return s;
  let next = 0;
  return s.replace(/%(\d)?([sdf])/g, (m, n) => {
    const v = n ? args[Number(n) - 1] : args[next++];
    return v === undefined ? m : esc(String(v));
  });
}

const attrsOf = (s) => Object.fromEntries([...s.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1].toLowerCase(), m[2]]));
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function markupToHtml(raw, sprite = null) {
  let out = '';
  const open = [];
  // Leading/trailing layout whitespace in the files is not meaningful.
  const src = raw.replace(/^\s+|\s+$/g, '');
  const re = /<(\/?)([a-zA-Z]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m, lastCell = false;
  while ((m = re.exec(src))) {
    if (m[5] !== undefined) {
      // Layout whitespace next to cells would add a gap and push a row of cells onto two lines.
      if (!m[5].trim() && (lastCell || /^<\/?cell/i.test(src.slice(re.lastIndex)))) continue;
      out += esc(decode(m[5].replace(/\s+/g, ' ')));
      lastCell = false;
      continue;
    }
    const closing = m[1] === '/', tag = m[2].toLowerCase(), a = attrsOf(m[3]), selfClose = m[4] === '/';
    lastCell = tag === 'cell';
    if (closing) {
      const i = open.lastIndexOf(tag);
      if (i >= 0) { for (let k = open.length - 1; k >= i; k--) out += `</${htmlTag(open[k])}>`; open.length = i; }
      continue;
    }
    switch (tag) {
      case 'br': out += '<br>'; break;
      case 'p': out += selfClose ? '<br>' : ''; if (!selfClose) { out += '<p>'; open.push('p'); } break;
      case 'b': case 'i': case 'u': if (!selfClose) { out += `<${tag}>`; open.push(tag); } break;
      case 'color': {
        const c = `rgb(${num(a.r, 255)},${num(a.g, 255)},${num(a.b, 255)})`;
        if (!selfClose) { out += `<span style="color:${c}">`; open.push('color'); }
        break;
      }
      case 'font': {
        const shadow = a.shadowx || a.shadowy ? `;text-shadow:${num(a.shadowx)}px ${num(a.shadowy)}px 0 rgba(0,0,0,${num(a.shadowa, 128) / 255})` : '';
        const size = a.size ? `;font-size:${num(a.size, 10) + 3}px` : '';
        if (!selfClose) { out += `<span style="font-family:Arial,sans-serif${size}${shadow}">`; open.push('font'); }
        break;
      }
      case 'img': {
        if (!a.src || !sprite) break;
        const id = `img${Math.random().toString(36).slice(2)}`;
        out += `<img data-locimg="${id}" alt="" width="${num(a.width, num(a.sw, 16))}" height="${num(a.height, num(a.sh, 16))}" style="vertical-align:middle">`;
        Promise.resolve(sprite(a.src.replace(/\\/g, '/'), num(a.sx), num(a.sy), num(a.sw, 64), num(a.sh, 64))).then((url) => {
          const img = url && document.querySelector(`img[data-locimg="${id}"]`);
          if (img) img.src = url;
        });
        break;
      }
      // <cell width height padx pady bgimg>: a box in a row of boxes (zoopedia page layout).
      case 'cell': {
        const w = a.width ? `width:${num(a.width)}px;` : '', h = a.height ? `min-height:${num(a.height)}px;` : '';
        const pad = `padding:${num(a.pady)}px ${num(a.padx)}px;`;
        const id = a.bgimg && sprite ? `cell${Math.random().toString(36).slice(2)}` : '';
        out += `<div${id ? ` data-locbg="${id}"` : ''} style="display:inline-block;vertical-align:top;box-sizing:border-box;max-width:100%;${w}${h}${pad}background-size:100% 100%">`;
        if (id) {
          Promise.resolve(sprite(a.bgimg.replace(/\\/g, '/'), 0, 0, 0, 0)).then((url) => {
            const el = url && document.querySelector(`[data-locbg="${id}"]`);
            if (el) el.style.backgroundImage = `url(${url})`;
          });
        }
        if (selfClose) out += '</div>'; else open.push('cell');
        break;
      }
      // <a href="zoopedia:zoopedia_lion:entry">: a link to another zoopedia entry (handled by the page).
      case 'a': {
        if (selfClose) break;
        const href = /^zoopedia:[\w:]+$/i.test(a.href ?? '') ? a.href : '';
        out += `<a href="#"${href ? ` data-link="${esc(href)}"` : ''} style="color:inherit;text-decoration:underline">`;
        open.push('a');
        break;
      }
      default: break; // ZT..., names: layout hints the web version does not need
    }
  }
  for (let k = open.length - 1; k >= 0; k--) out += `</${htmlTag(open[k])}>`;
  return out;
}

const htmlTag = (t) => (t === 'color' || t === 'font' ? 'span' : t === 'cell' ? 'div' : t);
