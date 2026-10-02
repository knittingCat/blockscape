import { World, SIZES, encodeWorld, decodeWorld } from './world.js';
import { BLOCKS, BLOCK_BY_ID } from './blocks.js';
import { textureCanvas, topTextureName } from './textures.js';
import { DioramaView } from './view.js';
import { initAccount } from './account.js';
import { extract, rotate90, originFor, placement } from './clipboard.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- storage (best effort) ----------
const store = {
  get(key) {
    try {
      return localStorage.getItem('blockscape:' + key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('blockscape:' + key, value);
    } catch {}
  },
};

// ---------- starter scenes ----------
function makeScene(size = 32, kind = 'grass') {
  const w = new World(size);
  const set = (x, y, z, id) => w.setMany([[x, y, z, id]], { record: false });
  const c = size / 2;
  if (kind === 'grass') {
    for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) set(x, 0, z, 1);
    const tx = Math.floor(c) - 6;
    const tz = Math.floor(c) - 4;
    for (let y = 1; y <= 4; y++) set(tx, y, tz, 11);
    for (let y = 4; y <= 6; y++) {
      const r = y === 6 ? 1 : 2;
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) if (!(dx === 0 && dz === 0 && y < 5)) set(tx + dx, y, tz + dz, 13);
    }
  } else if (kind === 'island') {
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x + 0.5 - c, z + 0.5 - c);
        if (d < size * 0.3) set(x, 0, z, 1);
        else if (d < size * 0.37) set(x, 0, z, 5);
        else set(x, 0, z, 9);
      }
    }
  }
  return w;
}

// ---------- state ----------
let world;
let view;
let tool = 'build';
let selected = 1;
let boxA = null;
let sharedMode = false;
let spinning = false;
let hoverInfo = null;
let selA = null; // first corner of a selection in progress
let selection = null; // { a, b } finished selection
let clip = null; // copied blocks (kept when you open another diorama)
let lastTapKey = null; // touch: first tap previews the paste, second tap places it
let cloud = null; // the saved-online diorama we are looking at, if any
let accountApi = null;

const stage = $('#stage');
const toastEl = $('#toast');
let toastTimer;
function toast(msg, ms = 2600) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// ---------- palette ----------
const palette = $('#palette');
for (const block of BLOCKS) {
  const btn = document.createElement('button');
  btn.className = 'swatch';
  btn.dataset.id = block.id;
  btn.title = block.name + (block.id <= 9 ? ` (${block.id})` : '');
  btn.setAttribute('aria-label', block.name);
  const cv = document.createElement('canvas');
  cv.width = cv.height = 16;
  cv.getContext('2d').drawImage(textureCanvas(topTextureName(block)), 0, 0);
  btn.appendChild(cv);
  if (block.id <= 9) {
    const k = document.createElement('kbd');
    k.textContent = block.id;
    btn.appendChild(k);
  }
  btn.addEventListener('click', () => {
    selectBlock(block.id);
    if (tool !== 'build' && tool !== 'box' && tool !== 'label') setTool('build');
  });
  palette.appendChild(btn);
}

function selectBlock(id) {
  selected = id;
  $$('.swatch').forEach((b) => b.classList.toggle('selected', Number(b.dataset.id) === id));
  updateStatus();
  refreshHover();
}

function setTool(t) {
  tool = t;
  boxA = null;
  selA = null;
  lastTapKey = null;
  view?.showRegion(null, null);
  if (t !== 'paste') view?.showFootprint(null);
  $('#pasteBar').hidden = t !== 'paste';
  $$('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  updateStatus();
  refreshHover();
}

function updateStatus() {
  const names = { build: 'Build', erase: 'Erase', box: 'Box fill', pick: 'Pick', label: 'Sign', select: 'Select', paste: 'Paste' };
  let hint = tool === 'box' ? (boxA ? ' — click the opposite corner' : ' — click a first corner') : '';
  if (tool === 'select') hint = selA ? ' — click the opposite corner' : selection ? ' — copied — press 📌 Paste' : ' — click one corner of the area';
  if (tool === 'paste') hint = clip ? ` — ${clip.w}×${clip.h}×${clip.d} footprint: move it, then click to place` : '';
  $('#status').textContent = `${world.count()} blocks · ${names[tool]}${hint} · ${BLOCK_BY_ID.get(selected).name}`;
  $('#undo').disabled = !world.undoStack.length;
  $('#redo').disabled = !world.redoStack.length;
}

// ---------- world wiring ----------
let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      store.set(sharedMode ? 'shared' : 'scene', await encodeWorld(world));
    } catch {}
  }, 500);
}

function attachWorld(w) {
  world = w;
  world.onChange(() => {
    updateStatus();
    scheduleSave();
  });
  $$('[data-sky]').forEach((b) => b.classList.toggle('active', b.dataset.sky === (world.meta.sky || 'day')));
  updateStatus();
}

function updateBanner(shared) {
  const banner = $('#banner');
  const viewingOthers = cloud && !cloud.mine;
  banner.hidden = !(shared || viewingOthers);
  $('#bannerText').textContent = viewingOthers
    ? `Looking at “${cloud.title}” by ${cloud.owner}. Your own diorama is safe.`
    : "You're looking at a shared diorama. Your own diorama is safe.";
  $('#reportBtn').hidden = !(viewingOthers && accountApi);
}

async function loadFromText(text, { shared = false, cloud: cloudInfo = null } = {}) {
  const w = await decodeWorld(text.trim());
  sharedMode = shared;
  cloud = cloudInfo;
  attachWorld(w);
  view.setWorld(w);
  selection = null;
  view.showSelection(null);
  setTool(tool);
  updateBanner(shared);
}

// ---------- pointer handling ----------
function currentHit(e) {
  const ray = view.rayFromPointer(e.clientX, e.clientY);
  return { ray, hit: world.raycast(ray.origin, ray.dir) };
}

function refreshHover(e) {
  if (e) hoverInfo = e;
  if (!hoverInfo || !view) return;
  const { hit } = currentHit(hoverInfo);
  const erasing = tool === 'erase' || hoverInfo.shiftKey;
  const block = BLOCK_BY_ID.get(selected);
  if (tool === 'paste') {
    view.showGhost(null);
    if (!hit || !clip || !hit.prev) return view.showFootprint(null);
    const origin = originFor(clip, hit.prev);
    view.showFootprint([clip.w, clip.h, clip.d], origin, placement(world, clip, origin).fits);
    return;
  }
  if (!hit) {
    view.showGhost(null);
    view.showRegion(null, null);
    return;
  }
  if (tool === 'select') {
    const corner = hit.cell || hit.prev;
    view.showGhost(corner, { color: 0x4dd0e1, opacity: 0.3, scale: 1.03 });
    if (selA && corner) view.showRegion(selA, corner);
    return;
  }
  if (tool === 'pick') {
    view.showGhost(hit.cell, { color: 0xffffff, opacity: 0.25, scale: 1.03 });
  } else if (tool === 'label') {
    view.showGhost(hit.prev, { color: 0xffffff, opacity: 0.2 });
  } else if (erasing && !(tool === 'box' && !boxA && !hoverInfo.shiftKey)) {
    view.showGhost(hit.cell, { color: 0xff4d4d, opacity: 0.45, scale: 1.03 });
  } else {
    view.showGhost(hit.prev, { color: view.setGhostTint(block), opacity: block.alpha ? 0.4 : 0.55 });
  }
  if (tool === 'box' && boxA) {
    const target = erasing ? hit.cell : hit.prev;
    view.showRegion(boxA, target || boxA);
  }
}

async function actAt(e, button) {
  const { ray, hit } = currentHit(e);
  const erasing = tool === 'erase' || button === 2 || e.shiftKey;
  if (erasing && !['box', 'select', 'paste'].includes(tool)) {
    const labelId = view.labelAt(ray);
    if (labelId != null) {
      world.removeLabel(labelId);
      return;
    }
  }
  if (!hit) return;
  if (tool === 'select') {
    const corner = hit.cell || hit.prev;
    if (!corner) return;
    if (!selA) {
      selA = corner;
      selection = null;
      view.showSelection(null);
    } else {
      selection = { a: selA, b: corner };
      selA = null;
      view.showRegion(null, null);
      view.showSelection(selection.a, selection.b);
      const w = Math.abs(selection.a[0] - selection.b[0]) + 1;
      const h = Math.abs(selection.a[1] - selection.b[1]) + 1;
      const d = Math.abs(selection.a[2] - selection.b[2]) + 1;
      copySelection(`Selected ${w}×${h}×${d}`); // selecting copies automatically
    }
    updateStatus();
    return;
  }
  if (tool === 'paste') {
    if (!clip) {
      toast('Nothing to paste yet — use ⬚ Select on an area first.');
      return;
    }
    if (!hit.prev) return;
    const origin = originFor(clip, hit.prev);
    const key = origin.join(',');
    if (e.pointerType === 'touch' && lastTapKey !== key) {
      lastTapKey = key; // first tap just shows where it would go
      toast('Tap the same spot again to place it, or tap elsewhere to move it.');
      return;
    }
    lastTapKey = null;
    const p = placement(world, clip, origin);
    if (!p.fits) {
      toast("That doesn't fit inside the diorama — move the footprint or 🔄 Rotate it.");
      return;
    }
    world.setManyWithLabels(p.cells, p.labels);
    toast(`Pasted ${p.cells.length} blocks. Click again to paste another, or press Done.`);
    return;
  }
  if (tool === 'pick') {
    if (hit.cell) {
      selectBlock(world.get(...hit.cell));
      setTool('build');
    }
    return;
  }
  if (tool === 'label') {
    if (!hit.prev) return;
    const text = await askLabel();
    if (text) world.addLabel(hit.prev[0], hit.prev[1], hit.prev[2], text);
    return;
  }
  if (tool === 'box') {
    const target = erasing ? hit.cell : hit.prev;
    if (!target) return;
    if (!boxA) {
      boxA = target;
      updateStatus();
      return;
    }
    const cells = world.boxCells(boxA, target);
    world.setMany(cells.map(([x, y, z]) => [x, y, z, erasing ? 0 : selected]));
    boxA = null;
    view.showRegion(null, null);
    updateStatus();
    return;
  }
  if (erasing) {
    if (hit.cell) world.setMany([[...hit.cell, 0]]);
  } else if (hit.prev) {
    world.setMany([[...hit.prev, selected]]);
  }
}

function copySelection(prefix = '') {
  if (!selection) {
    toast('Select an area first: ⬚ Select, then click one corner and the opposite corner.');
    setTool('select');
    return;
  }
  const copied = extract(world, selection.a, selection.b);
  if (!copied.cells.length) {
    clip = null;
    toast(`${prefix ? prefix + ' — but' : ''} that area is empty, so there is nothing to paste.`.trim());
    return;
  }
  clip = copied;
  toast(`${prefix ? prefix + ' and copied' : 'Copied'} ${clip.cells.length} blocks. Press 📌 Paste to place them.`);
  updateStatus();
}

function deleteSelection() {
  if (!selection) return false;
  const r = world.clearRegion(selection.a, selection.b);
  if (!r.blocks && !r.labels) {
    toast('Nothing to delete in that area.');
    return true;
  }
  selection = null;
  view.showSelection(null);
  toast(`Deleted ${r.blocks} blocks${r.labels ? ` and ${r.labels} sign${r.labels > 1 ? 's' : ''}` : ''}. Cmd/Ctrl+Z brings them back.`);
  updateStatus();
  return true;
}

function rotateClip() {
  if (!clip) return;
  clip = rotate90(clip);
  updateStatus();
  refreshHover();
}

function wirePointer(canvas) {
  let down = null;
  const pointers = new Set();
  canvas.addEventListener('pointerdown', (e) => {
    pointers.add(e.pointerId);
    if (pointers.size > 1) {
      down = null; // a second finger means pinch/pan, not a tap
      return;
    }
    down = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button };
  });
  const finish = (e) => {
    pointers.delete(e.pointerId);
    const d = down;
    down = null;
    if (!d || e.type === 'pointercancel') return;
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    if (moved < 6 && performance.now() - d.t < 700 && (d.button === 0 || d.button === 2)) {
      hoverInfo = e;
      actAt(e, d.button).finally(() => refreshHover(e));
    }
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons === 0 && e.pointerType === 'mouse') refreshHover(e);
  });
  canvas.addEventListener('pointerleave', () => {
    hoverInfo = null;
    view.showGhost(null);
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ---------- dialogs ----------
function askLabel() {
  const dlg = $('#labelDialog');
  const input = $('#labelText');
  input.value = '';
  return new Promise((resolve) => {
    dlg.addEventListener(
      'close',
      () => resolve(dlg.returnValue === 'ok' ? input.value.trim().slice(0, 60) : ''),
      { once: true },
    );
    dlg.showModal();
    input.focus();
  });
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const slug = (s) => (s || 'diorama').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'diorama';

function composePicture({ preview = false } = {}) {
  let [w, h] = $('#picSize').value.split('x').map(Number);
  if (preview) {
    h = Math.round((h * 640) / w);
    w = 640;
  }
  const canvas = view.snapshot(w, h);
  const title = $('#picTitle').value.trim();
  const sub = $('#picSub').value.trim();
  if ($('#picBar').checked && (title || sub)) {
    const ctx = canvas.getContext('2d');
    const barH = Math.round(h * (sub ? 0.17 : 0.12));
    const g = ctx.createLinearGradient(0, h - barH * 1.4, 0, h);
    g.addColorStop(0, 'rgba(10,12,24,0)');
    g.addColorStop(0.35, 'rgba(10,12,24,0.78)');
    g.addColorStop(1, 'rgba(10,12,24,0.9)');
    ctx.fillStyle = g;
    ctx.fillRect(0, h - barH * 1.4, w, barH * 1.4);
    const pad = Math.round(w * 0.035);
    const fit = (text, weight, size) => {
      let s = size;
      do {
        ctx.font = `${weight} ${s}px system-ui, -apple-system, "Segoe UI", sans-serif`;
        s -= 2;
      } while (ctx.measureText(text).width > w - pad * 2 && s > 10);
    };
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'alphabetic';
    let y = h - pad * 0.7;
    if (sub) {
      fit(sub, 400, Math.round(h * 0.036));
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(sub, pad, y);
      y -= Math.round(h * 0.055);
    }
    if (title) {
      fit(title, 700, Math.round(h * 0.062));
      ctx.fillStyle = '#fff';
      ctx.fillText(title, pad, y);
    }
  }
  return canvas;
}

let previewTimer;
function updatePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    world.meta.title = $('#picTitle').value;
    world.meta.subtitle = $('#picSub').value;
    const c = composePicture({ preview: true });
    $('#picPreview').src = c.toDataURL('image/jpeg', 0.8);
    scheduleSave();
  }, 120);
}

// ---------- toolbar ----------
function wireUI() {
  // Cancel/Close must not be the form's default button, or pressing Enter would cancel the dialog
  $$('dialog button[value=cancel]').forEach((b) => {
    b.type = 'button';
    b.addEventListener('click', () => b.closest('dialog').close('cancel'));
  });
  $$('[data-tool]').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.tool === 'paste' && !clip) {
        toast('Nothing to paste yet — use ⬚ Select on an area first.');
        return;
      }
      setTool(b.dataset.tool);
    }),
  );
  $('#copyBtn').addEventListener('click', copySelection);
  $('#rotateBtn').addEventListener('click', rotateClip);
  $('#cancelPasteBtn').addEventListener('click', () => setTool('build'));
  $$('[data-sky]').forEach((b) =>
    b.addEventListener('click', () => {
      view.setSky(b.dataset.sky);
      $$('[data-sky]').forEach((x) => x.classList.toggle('active', x === b));
      scheduleSave();
    }),
  );
  $('#undo').addEventListener('click', () => world.undo());
  $('#redo').addEventListener('click', () => world.redo());
  $('#spin').addEventListener('click', toggleSpin);
  $('#resetView').addEventListener('click', () => view.resetCamera());

  $('#newBtn').addEventListener('click', () => $('#newDialog').showModal());
  $('#newDialog').addEventListener('close', () => {
    const dlg = $('#newDialog');
    if (dlg.returnValue !== 'ok') return;
    sharedMode = false;
    cloud = null;
    updateBanner(false);
    history.replaceState(null, '', location.pathname + location.search);
    const w = makeScene(Number($('#newSize').value), $('#newKind').value);
    attachWorld(w);
    view.setWorld(w);
    scheduleSave();
  });

  $('#saveBtn').addEventListener('click', async () => {
    const text = await encodeWorld(world);
    download(new Blob([text], { type: 'text/plain' }), `${slug(world.meta.title)}.blockscape`);
    toast('Saved a file. Use 📂 Open to load it again.');
  });
  $('#openBtn').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      await loadFromText(await file.text());
      scheduleSave();
      toast('Opened ' + file.name);
    } catch (err) {
      toast("That file isn't a Blockscape diorama.");
    }
  });

  $('#linkBtn').addEventListener('click', async () => {
    const url = location.href.split('#')[0] + '#s=' + (await encodeWorld(world));
    let copied = false;
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch {}
    if (!copied) window.prompt('Copy this link:', url);
    else if (url.length > 8000) toast('Link copied, but it is very long — some apps may cut it off. 💾 Save is safer for big scenes.', 5000);
    else toast('Link copied! Anyone can open it and look around your diorama.');
  });

  $('#picBtn').addEventListener('click', () => {
    $('#picTitle').value = world.meta.title || '';
    $('#picSub').value = world.meta.subtitle || '';
    $('#picDialog').showModal();
    updatePreview();
  });
  ['picTitle', 'picSub', 'picSize', 'picBar'].forEach((id) => $('#' + id).addEventListener('input', updatePreview));
  $('#picDownload').addEventListener('click', (e) => {
    e.preventDefault();
    composePicture().toBlob((blob) => {
      download(blob, `${slug($('#picTitle').value)}.png`);
      toast('Picture saved to your Downloads folder.');
    }, 'image/png');
  });

  $('#helpBtn').addEventListener('click', () => $('#helpDialog').showModal());
  $('#reportBtn').addEventListener('click', () => cloud && accountApi && accountApi.report(cloud.id, cloud.title));
  $('#ownBtn').addEventListener('click', async () => {
    history.replaceState(null, '', location.pathname + location.search);
    await loadStart(false);
  });

  window.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea, select') || document.querySelector('dialog[open]')) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z') {
      e.preventDefault();
      e.shiftKey ? world.redo() : world.undo();
    } else if (mod && key === 'y') {
      e.preventDefault();
      world.redo();
    } else if (mod && key === 'c') {
      if (selection) {
        e.preventDefault();
        copySelection();
      }
    } else if (mod && key === 'v') {
      if (clip) {
        e.preventDefault();
        setTool('paste');
      }
    } else if (mod) {
      return;
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selection) {
      e.preventDefault();
      deleteSelection();
    } else if (/^[1-9]$/.test(e.key)) {
      selectBlock(Number(e.key));
    } else if (key === 'b') setTool('build');
    else if (key === 'e') setTool('erase');
    else if (key === 'x') setTool('box');
    else if (key === 's') setTool('select');
    else if (key === 'c') copySelection();
    else if (key === 'p') clip ? setTool('paste') : toast('Nothing to paste yet — use ⬚ Select on an area first.');
    else if (key === 'q') rotateClip();
    else if (key === 'i') setTool('pick');
    else if (key === 't') setTool('label');
    else if (key === 'r') toggleSpin();
    else if (e.key === 'Escape') {
      boxA = null;
      selA = null;
      selection = null;
      view.showRegion(null, null);
      view.showSelection(null);
      if (tool === 'paste' || tool === 'select') setTool('build');
      updateStatus();
    }
  });
  window.addEventListener('keyup', () => refreshHover());
  window.addEventListener('hashchange', () => {
    if (location.hash.startsWith('#s=')) loadStart(true);
  });
}

function toggleSpin() {
  spinning = !spinning;
  view.controls.autoRotate = spinning;
  $('#spin').classList.toggle('active', spinning);
}

// ---------- start ----------
async function loadStart(allowHash = true) {
  if (allowHash && location.hash.startsWith('#s=')) {
    try {
      await loadFromText(location.hash.slice(3), { shared: true });
      toast('Opened a shared diorama — look around!');
      return;
    } catch {
      toast("That link didn't work — showing your own diorama instead.");
    }
  }
  const saved = store.get('scene');
  if (saved) {
    try {
      await loadFromText(saved);
      return;
    } catch {}
  }
  await loadFromText(await encodeWorld(makeScene(32, 'grass')));
}

async function main() {
  world = makeScene(32, 'grass');
  attachWorld(world);
  view = new DioramaView(stage, world);
  wirePointer(view.canvas);
  wireUI();
  selectBlock(1);
  setTool('build');
  await loadStart(true);
  accountApi = await initAccount({
    getWorld: () => world,
    loadScene: loadFromText,
    makeThumb: () => view.snapshot(320, 200).toDataURL('image/jpeg', 0.72),
    toast,
    getCloud: () => cloud,
    setCloud: (c) => {
      cloud = c;
      updateBanner(sharedMode);
    },
  });
  updateBanner(sharedMode);
  const askToSignIn = () => {
    // not when someone just opened a shared link: let them look first
    if (accountApi && !location.hash.startsWith('#s=') && !location.search.includes('nosignin')) accountApi.promptIfSignedOut();
  };
  if (!store.get('seen-help') && !location.search.includes('nohelp')) {
    store.set('seen-help', '1');
    $('#helpDialog').addEventListener('close', askToSignIn, { once: true });
    $('#helpDialog').showModal();
  } else {
    askToSignIn();
  }
  window.blockscape = { get world() { return world; }, get view() { return view; }, setTool, selectBlock, loadFromText, composePicture };
}

window.addEventListener('error', (e) => {
  document.title = 'ERROR: ' + e.message;
});
window.addEventListener('unhandledrejection', (e) => {
  document.title = 'ERROR: ' + (e.reason && e.reason.message ? e.reason.message : e.reason);
});

main();
