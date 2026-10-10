// Asset viewer: browse every model in the game files and inspect it in 3D.
// Game files are read locally in the browser and never uploaded anywhere.
import { openGameFS, usesLocalGameFiles, Assets } from './assets.js';
import { Renderer } from './renderer.js';
import { Camera } from './camera.js';
import { mat4 } from './math.js';

const $ = (id) => document.getElementById(id);
const renderer = new Renderer($('view'));
const camera = new Camera();
const IDENTITY = mat4.identity();
let assets = null;
let allModels = [];
let current = null;
let dirty = true;

$('files').addEventListener('change', (e) => start(e.target.files));
// Local builds load orgfiles/ straight away; production builds wait for the player's files.
if (usesLocalGameFiles()) start(null);
$('backLink').href = 'index.html' + location.search;

async function start(files) {
  try {
    const fs = await openGameFS(files, setStatus);
    assets = new Assets(fs, renderer);
    allModels = fs.list((k) => k.endsWith('.nif') || k.endsWith('.bfb'));
    setStatus(`${fs.files.size.toLocaleString()} files loaded, ${allModels.length.toLocaleString()} models`);
    $('picker').hidden = true;
    $('browser').hidden = false;
    renderList();
    const pick = new URLSearchParams(location.search).get('model');
    if (pick) { $('search').value = pick; renderList(); $('list').firstChild?.click(); }
  } catch (err) {
    console.error(err);
    setStatus(err.message);
  }
}

$('search').addEventListener('input', renderList);
$('hideLow').addEventListener('change', renderList);

function renderList() {
  const q = $('search').value.toLowerCase().trim();
  const hideLow = $('hideLow').checked;
  const list = allModels.filter((p) => {
    const k = p.toLowerCase();
    return (!q || k.includes(q)) && (!hideLow || !k.includes('/low/'));
  });
  const ul = $('list');
  ul.replaceChildren();
  for (const p of list.slice(0, 500)) {
    const li = document.createElement('li');
    const parts = p.split('/');
    const name = document.createElement('b');
    const folder = document.createElement('small');
    name.textContent = parts.at(-1).replace(/\.nif$/i, '');
    folder.textContent = parts.slice(0, -1).join('/');
    li.append(name, folder);
    li.title = p;
    li.onclick = () => {
      ul.querySelector('.active')?.classList.remove('active');
      li.classList.add('active');
      openModel(p);
    };
    ul.append(li);
  }
  $('count').textContent = list.length > 500 ? `Showing 500 of ${list.length.toLocaleString()}` : `${list.length.toLocaleString()} models`;
}

async function openModel(path) {
  setStatus(`Loading ${path}…`);
  try {
    const { gpu, nif, model, missing } = await assets.model(path);
    current = gpu;
    camera.target = [...gpu.center];
    camera.distance = Math.max(0.5, gpu.radius * 2.2);
    camera.pitch = 0.35;
    dirty = true;
    const tris = model.meshes.reduce((s, m) => s + m.indices.length / 3, 0);
    const notes = [];
    if (!nif.complete) notes.push(`partial: ${nif.error}`);
    if (missing.length) notes.push(`missing textures: ${missing.join(', ')}`);
    setStatus(`${path} — ${model.meshes.length} meshes, ${tris.toLocaleString()} triangles${notes.length ? ' — ' + notes.join('; ') : ''}`);
  } catch (err) {
    console.error(err);
    setStatus(`${path}: ${err.message}`);
  }
}

function setStatus(text) { $('status').textContent = text; }

// --- camera controls: drag to orbit, wheel / pinch to zoom -------------------------------
const pointers = new Map();
let pinchDist = 0;
const canvas = $('view');
canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]); });
canvas.addEventListener('pointerup', (e) => { pointers.delete(e.pointerId); pinchDist = 0; });
canvas.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); pinchDist = 0; });
canvas.addEventListener('pointermove', (e) => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size === 1) {
    camera.orbit(-(e.clientX - prev[0]) * 0.01, (e.clientY - prev[1]) * 0.01);
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (pinchDist) camera.zoom(pinchDist / d);
    pinchDist = d;
  }
  dirty = true;
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  camera.zoom(Math.exp(e.deltaY * 0.001));
  dirty = true;
}, { passive: false });
window.addEventListener('resize', () => { dirty = true; });

function frame(now) {
  // Scrolling textures need every frame; still models redraw only when something changed.
  renderer.time = now / 1000;
  if (dirty || current?.meshes.some((m) => m.uvAnim)) {
    const aspect = renderer.begin();
    renderer.eye = camera.eye?.() ?? null;
    if (current) renderer.draw([{ model: current, matrix: IDENTITY }], camera.viewProj(aspect));
    dirty = false;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
