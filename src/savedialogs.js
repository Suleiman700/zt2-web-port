// Save and Load screens from the original layouts (ui/layout/save.xml, load.xml, with the
// confirmation dialogs of confirm.xml), over this browser's save slots (saves.js).
import { UIEngine } from './ui/layout.js';
import { listSaves, deleteSave } from './saves.js';

async function openDialog({ fs, loc, layout, onMessage, setup, shared }) {
  const host = document.createElement('div');
  host.className = 'zt-frontend';
  document.body.append(host);
  let view;
  const engine = new UIEngine({ fs, loc, onMessage: (msg, attrs, node) => onMessage(msg, attrs, node, view, close) });
  // A running interface (the in-game shell) lends its templates and images: no reloading.
  if (shared) { engine.templates = shared.templates; engine.images = shared.images; engine.layouts = shared.layouts; }
  else await engine.init();
  const [main, confirm] = await Promise.all([layout ? engine.layout(layout) : null, engine.layout('ui/layout/confirm.xml')]);
  const root = { name: 'UILayout', attrs: { name: 'Dialog Root' }, text: '', children: [
    { name: 'UIRegion', attrs: { x: '0', y: '0', w: '1024', h: '768' }, children: [], text: '' },
    { name: 'children', attrs: {}, text: '', children: [main, confirm].filter(Boolean) },
  ] };
  view = engine.mount(root, host, { width: 1024, height: 768 });
  // The confirmation dialogs start hidden; buttons show the one they need.
  const dialogs = view.find('Confirm Dialog');
  if (dialogs) { dialogs.visible = false; dialogs.applyVisibility(); for (const d of dialogs.children) { d.visible = false; d.applyVisibility(); } }
  function close() { view.destroy(); host.remove(); }
  await setup(view, close);
  return { close };
}

const formatDate = (t) => new Date(t).toLocaleString();

async function fillList(view, listName, rowXml, onPick) {
  const list = view.find(listName);
  if (!list) return [];
  const saves = await listSaves();
  list.clear();
  for (const s of saves) {
    list.addEntry(rowXml, (row) => {
      row.value = s.name;
      row.setText(s.name);
      row.el.title = `${s.map} · ${formatDate(s.date)}`;
      row.onActivate = () => onPick(s);
    });
  }
  return saves;
}

export async function openLoadDialog({ fs, loc, onLoad, onClose, shared }) {
  let selected = null;
  const row = await new UIEngine({ fs, loc }).layout('ui/layout/loadentry.xml');
  return openDialog({
    fs, loc, layout: 'ui/layout/load.xml', shared,
    async onMessage(msg, attrs, node, view, close) {
      if (msg === 'ZT_LOADGAME' && attrs.string === 'cancel') { close(); onClose?.(); }
      if (msg === 'ZT_LOADGAME' && attrs.string === 'load' && selected) { close(); onLoad(selected.name); }
      if (msg === 'ZT_DELETEGAME' && attrs.string) {
        await deleteSave(attrs.string);
        selected = null;
        view.find('LoadGameName')?.setText('');
        await refresh(view);
      }
    },
    async setup(view) { await refresh(view); },
  });
  async function refresh(view) {
    await fillList(view, 'SavedGamesList', row, (s) => {
      selected = s;
      const name = view.find('LoadGameName');
      if (name) { name.value = s.name; name.setText(s.name); }
      const pic = view.find('LoadGamePreview');
      if (pic && s.preview) Object.assign(pic.el.style, { backgroundImage: `url(${s.preview})`, backgroundSize: '100% 100%' });
    });
  }
}

export async function openSaveDialog({ fs, loc, onSave, onClose, shared }) {
  let existing = [];
  const row = await new UIEngine({ fs, loc }).layout('ui/layout/saveentry.xml');
  const nameOf = (view) => (view.find('SaveName')?.value ?? '').trim();
  return openDialog({
    fs, loc, layout: 'ui/layout/save.xml', shared,
    async onMessage(msg, attrs, node, view, close) {
      if (msg !== 'ZT_SAVEGAME' && msg !== 'ZT_DELETEGAME') return;
      if (msg === 'ZT_DELETEGAME') { if (attrs.string) { await deleteSave(attrs.string); existing = await refresh(view); } return; }
      if (attrs.string === 'cancel') { close(); onClose?.(); return; }
      const name = nameOf(view) || loc.text('savegame:untitled') || 'Untitled';
      if (attrs.string === 'save' && existing.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
        const ask = view.find('overwrite save');
        if (ask) { ask.visible = true; ask.applyVisibility(); }
        return;
      }
      if (attrs.string === 'save' || attrs.string === 'confirmed') { close(); onSave(name); }
    },
    async setup(view) {
      const ask = view.find('overwrite save');
      if (ask) { ask.visible = false; ask.applyVisibility(); }
      existing = await refresh(view);
    },
  });
  async function refresh(view) {
    return fillList(view, 'SavedGamesList1', row, (s) => {
      const field = view.find('SaveName');
      if (field?.input) { field.input.value = s.name; field.value = s.name; }
      const gamename = view.find('gamename');
      if (gamename) gamename.value = s.name;
    });
  }
}

// "Would you like to sell X?" (confirm.xml delete_object_confirmation) with the refund.
export async function openSellConfirm({ fs, loc, name, refund, onSell, onClose, shared }) {
  return openDialog({
    fs, loc, layout: null, shared,
    onMessage(msg, attrs, node, view, close) {
      if (msg === 'ZT_SELL_ENTITY') { close(); onSell(); }
    },
    setup(view, close) {
      const dialogs = view.find('Confirm Dialog');
      if (dialogs) { dialogs.visible = true; dialogs.applyVisibility(); }
      const d = view.find('delete_object_confirmation');
      if (!d) { close(); onSell(); return; }
      d.message('UI_SHOW');
      d.find('Sell Item Label')?.setLoc('confirm:sell_selected_item', [name]);
      const r = d.find('Sell Item Refund');
      if (r) { r.format = r.xml.attrs.posformat ?? r.format; r.setText(refund); }
      // Closing the dialog any other way (cancel, Esc) is a "no".
      const hideOrig = d.applyVisibility.bind(d);
      d.applyVisibility = () => { hideOrig(); if (!d.visible) { close(); onClose?.(); } };
    },
  });
}
