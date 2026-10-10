// Opens an original layout as a window over the game (Zoo Status, in-game options...): mounted
// in the 4:3 design space, its main element (`show`) shown, closed when that element hides itself
// (its own close button) or on Esc. A running interface (the in-game shell) can lend its engine's
// templates and images so nothing is loaded again.
import { UIEngine } from './ui/layout.js';

export async function openWindow({ fs, loc, shared, layout, show, onMessage = () => {}, onClose }) {
  const host = document.createElement('div');
  host.className = 'zt-frontend';
  document.body.append(host);
  let view = null, closed = false;
  const engine = new UIEngine({ fs, loc, onMessage: (msg, attrs, node) => onMessage(msg, attrs, node, view) });
  try {
    if (shared) { engine.templates = shared.templates; engine.images = shared.images; engine.layouts = shared.layouts; }
    else await engine.init();
    view = engine.mount(await engine.layout(layout), host, { width: 1024, height: 768 });
  } catch (err) { host.remove(); throw err; }
  const panel = view.find(show) ?? view.root;
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); panel.message('UI_HIDE'); } };
  function close() {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', onKey, true);
    view.destroy(); host.remove();
    onClose?.();
  }
  const applyVis = panel.applyVisibility.bind(panel);
  panel.applyVisibility = () => { applyVis(); if (!panel.visible) close(); };
  panel.message('UI_SHOW');
  window.addEventListener('keydown', onKey, true);
  return { view, close, get closed() { return closed; } };
}
