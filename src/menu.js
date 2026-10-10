// The front end, from the original layouts: main menu (ui/layout/mainmenu.xml) and map selection
// (ui/layout/freeformselection.xml), run by the layout interpreter. This file only answers the
// engine messages those layouts send: fill the map list (ZT_POPULATE_SCENARIO_UI), filter it by
// world location / expansion, and start the chosen map (ZT_LOADGAME).
import { UIEngine } from './ui/layout.js';

// Header of a map save: <ZTMapData name="mapname:x" size="mapsize:large" biome location xpack/>.
async function mapInfo(fs, path) {
  const head = new TextDecoder('latin1').decode(await fs.readPrefix(path, 700));
  const tag = /<ZTMapData\b([^>]*)>/.exec(head)?.[1] ?? '';
  const a = Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const file = path.split('/').pop().replace(/\.zt2$/i, '');
  return { file, path, name: a.name ?? `mapname:${file}`, size: a.size ?? '', biome: (a.biome ?? '').toLowerCase(), location: a.location ?? '', xpack: Number(a.xpack ?? 0) };
}

export async function openFrontEnd({ fs, loc, container, onPlay, onClose, onLoadMenu }) {
  let maps = null;
  // Zoo locations (locations/zoolocations.xml): name -> region text id and globe coordinates.
  const locations = new Map();
  if (fs.has('locations/zoolocations.xml')) {
    const text = new TextDecoder('latin1').decode(await fs.read('locations/zoolocations.xml'));
    for (const m of text.matchAll(/<ZTLocationEntry\s+name="([^"]+)"\s+locid="([^"]+)"[^>]*>(?:\s*<coordinate\s+long="([^"]+)"\s+lat="([^"]+)")?/g)) {
      locations.set(m[1].toLowerCase(), { locid: m[2], long: Number(m[3]), lat: Number(m[4]) });
    }
  }
  const locationText = (name) => loc.text(locations.get(String(name).toLowerCase())?.locid ?? '') || name;
  const filter = { location: 'all', xpack: null };
  let selected = null;
  let view = null;

  const engine = new UIEngine({
    fs, loc,
    onMessage(msg, attrs, node) {
      switch (msg) {
        case 'ZT_POPULATE_SCENARIO_UI': populate(); break;
        case 'ZT_SET_WORLD_LOCATION': filter.location = (attrs.string || 'all').toLowerCase(); filter.xpack = null; populate(); break;
        case 'ZT_SET_XPACK_FILTER': filter.xpack = Number(attrs.value); filter.location = 'all'; populate(); break;
        case 'ZT_LOADGAME': if (attrs.string) { close(); onPlay(attrs.string); } break;
        case 'ZT_SETMODE': if (attrs.string === 'mode_mainload') onLoadMenu?.(); break;
        case 'ZT_EXIT_GAME': case 'ZT_QUIT': break;
        default: break; // other engine messages come with their features
      }
    },
  });
  await engine.init();
  const [main, select] = await Promise.all([engine.layout('ui/layout/mainmenu.xml'), engine.layout('ui/layout/freeformselection.xml')]);
  const rowTemplate = await engine.layout('ui/layout/scenariobutton.xml');
  // One tree, as in the game: the main menu's buttons show and hide map selection panels by name.
  const root = { name: 'UILayout', attrs: { name: 'Front End' }, text: '', children: [
    { name: 'UIRegion', attrs: { x: '0', y: '0', w: '1024', h: '768' }, children: [], text: '' },
    { name: 'children', attrs: {}, text: '', children: [main, select] },
  ] };
  const host = document.createElement('div');
  host.className = 'zt-frontend';
  container.append(host);
  view = engine.mount(root, host, { width: 1024, height: 768 });

  async function populate() {
    const list = view.find('Map List');
    if (!list) return;
    maps ??= await Promise.all(fs.list((k) => /^maps\/default\/[^/]+\.zt2$/i.test(k)).map((p) => mapInfo(fs, p).catch(() => null))).then((l) => l.filter(Boolean));
    const shown = maps.filter((m) => (filter.xpack !== null ? m.xpack === filter.xpack : filter.location === 'all' || m.biome === filter.location))
      .sort((a, b) => loc.text(a.name).localeCompare(loc.text(b.name)));
    list.clear();
    for (const m of shown) {
      list.addEntry(rowTemplate, (row) => {
        row.value = m.file;
        row.setText(loc.text(m.name) || m.file);
        row.onActivate = () => choose(m);
      });
    }
  }

  async function choose(m) {
    selected = m;
    const set = (name, text) => view.find(name)?.setText(text);
    view.find('Selected Scenario Map').value = m.file;
    set('Map Name Label', loc.text(m.name));
    set('Map Name Field', loc.text(m.name));
    set('Map Biome', loc.text(`${m.biome}:icon_stt`) || m.biome);
    set('Map Biome Field', loc.text(`${m.biome}:icon_stt`) || m.biome);
    set('Map Location', locationText(m.location));
    set('Map Location Field', locationText(m.location));
    set('Map Size', loc.text(m.size));
    view.find('Play Map')?.message('UI_ENABLE');
    // Thumbnail: maps/default/<map>.jpg.
    const img = view.find('Map Image');
    const jpg = `maps/default/${m.file}.jpg`;
    if (img && fs.has(jpg)) {
      const url = URL.createObjectURL(new Blob([await fs.read(jpg)], { type: 'image/jpeg' }));
      if (selected !== m) return;
      Object.assign(img.el.style, { backgroundImage: `url(${url})`, backgroundSize: '100% 100%', backgroundPosition: '0 0' });
    }
  }

  function close() {
    view?.destroy();
    host.remove();
    onClose?.();
  }

  return { view, close };
}
