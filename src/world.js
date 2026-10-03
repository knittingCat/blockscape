// Pure voxel-world logic: no DOM, no three.js. Cell (x, y, z): x/z in [0, size), y in [0, HEIGHT).
// A cell occupies [x, x+1] x [y, y+1] x [z, z+1]; the diorama stand's top surface is the plane y = 0.

export const HEIGHT = 32;

// ---- people (decorative figures with a customizable outfit; not part of the block grid) ----
export const PERSON_CHOICES = {
  pose: ['standing', 'lying', 'lyingFront'], // lying = on their back, lyingFront = on their front
  hairStyle: ['none', 'short', 'long'],
  sleeves: ['short', 'long', 'none'],
  bottoms: ['pants', 'shorts', 'skirt'],
  hat: ['none', 'cap', 'beanie', 'tophat', 'crown'],
};
export const PERSON_DEFAULTS = {
  rot: 0,
  pose: 'standing',
  twist: 0, // whole person turned further, in 30 degree steps on top of rot (0..11)
  headTurn: 0, // head turned left/right in 30 degree steps (-6..6, a full turn)
  headTilt: 0, // head tilted up (+) or down (-) in 20 degree steps (-2..2)
  skin: '#f1c27d',
  hair: '#3b2a1a',
  hairStyle: 'short',
  shirt: '#3b82f6',
  pants: '#374151',
  shoes: '#111827',
  sleeves: 'short',
  bottoms: 'pants',
  hat: 'none',
  hatColor: '#e11d48',
  name: '',
};
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Keep only valid values (used for anything loaded from a file, link or the server).
export function cleanPerson(p) {
  const out = { ...PERSON_DEFAULTS };
  for (const key of ['skin', 'hair', 'shirt', 'pants', 'shoes', 'hatColor']) if (COLOR_RE.test(p[key])) out[key] = p[key].toLowerCase();
  for (const key of Object.keys(PERSON_CHOICES)) if (PERSON_CHOICES[key].includes(p[key])) out[key] = p[key];
  out.headTurn = Math.max(-6, Math.min(6, Math.round(Number(p.headTurn)) || 0));
  out.twist = ((Math.round(Number(p.twist)) || 0) % 12 + 12) % 12;
  out.headTilt = Math.max(-2, Math.min(2, Math.round(Number(p.headTilt)) || 0));
  out.rot = Number.isInteger(p.rot) ? ((p.rot % 4) + 4) % 4 : 0;
  out.name = typeof p.name === 'string' ? p.name.slice(0, 30) : '';
  out.x = Number(p.x);
  out.y = Number(p.y);
  out.z = Number(p.z);
  return out;
}
export const SIZES = { small: 24, medium: 32, large: 48 };

export class World {
  constructor(size = 32) {
    this.size = size;
    this.height = HEIGHT;
    this.cells = new Uint8Array(size * size * HEIGHT); // 0 = empty, otherwise a block id
    this.labels = []; // { id, x, y, z, text }
    this.people = []; // { id, x, y, z, rot, skin, hair, ... } see PERSON_DEFAULTS
    this.nextPersonId = 1;
    this.meta = { sky: 'day', title: '', subtitle: '' };
    this.undoStack = [];
    this.redoStack = [];
    this.nextLabelId = 1;
    this.listeners = new Set();
  }

  // ----- cells -----
  index(x, y, z) {
    return x + this.size * (z + this.size * y);
  }
  inBounds(x, y, z) {
    return x >= 0 && y >= 0 && z >= 0 && x < this.size && z < this.size && y < this.height;
  }
  get(x, y, z) {
    return this.inBounds(x, y, z) ? this.cells[this.index(x, y, z)] : 0;
  }
  coords(i) {
    const x = i % this.size;
    const z = Math.floor(i / this.size) % this.size;
    const y = Math.floor(i / (this.size * this.size));
    return [x, y, z];
  }
  count() {
    let n = 0;
    for (let i = 0; i < this.cells.length; i++) if (this.cells[i]) n++;
    return n;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(event) {
    for (const fn of this.listeners) fn(event);
  }

  // Set many cells in ONE undo step. list: [[x, y, z, id], ...]. Returns number of cells changed.
  setMany(list, { record = true } = {}) {
    const changes = [];
    for (const [x, y, z, id] of list) {
      if (!this.inBounds(x, y, z)) continue;
      const i = this.index(x, y, z);
      if (this.cells[i] === id) continue;
      changes.push({ i, from: this.cells[i], to: id });
      this.cells[i] = id;
    }
    if (!changes.length) return 0;
    if (record) {
      this.undoStack.push({ cells: changes });
      this.redoStack.length = 0;
      if (this.undoStack.length > 200) this.undoStack.shift();
    }
    this.emit({ type: 'cells', changes });
    return changes.length;
  }

  // Like setMany, but also adds text labels, all as ONE undo step (used by paste).
  setManyWithLabels(list, labelList) {
    const changes = [];
    for (const [x, y, z, id] of list) {
      if (!this.inBounds(x, y, z)) continue;
      const i = this.index(x, y, z);
      if (this.cells[i] === id) continue;
      changes.push({ i, from: this.cells[i], to: id });
      this.cells[i] = id;
    }
    const labelsAdd = [];
    for (const l of labelList) {
      if (!this.inBounds(l.x, l.y, l.z)) continue;
      const label = { id: this.nextLabelId++, x: l.x, y: l.y, z: l.z, text: String(l.text).slice(0, 80) };
      this.labels.push(label);
      labelsAdd.push(label);
    }
    if (!changes.length && !labelsAdd.length) return 0;
    this.undoStack.push({ cells: changes, labelsAdd });
    this.redoStack.length = 0;
    if (changes.length) this.emit({ type: 'cells', changes });
    if (labelsAdd.length) this.emit({ type: 'labels' });
    return changes.length + labelsAdd.length;
  }

  // Remove every block and sign inside the box (corners in any order) as ONE undo step.
  // keep(x, y, z, id) => true leaves that block alone (used so Clear keeps the automatic grass floor).
  clearRegion(a, b, { keep = null } = {}) {
    const lo = [0, 1, 2].map((i) => Math.min(a[i], b[i]));
    const hi = [0, 1, 2].map((i) => Math.max(a[i], b[i]));
    const changes = [];
    for (let y = Math.max(lo[1], 0); y <= Math.min(hi[1], this.height - 1); y++) {
      for (let z = Math.max(lo[2], 0); z <= Math.min(hi[2], this.size - 1); z++) {
        for (let x = Math.max(lo[0], 0); x <= Math.min(hi[0], this.size - 1); x++) {
          const i = this.index(x, y, z);
          if (this.cells[i] && !(keep && keep(x, y, z, this.cells[i]))) {
            changes.push({ i, from: this.cells[i], to: 0 });
            this.cells[i] = 0;
          }
        }
      }
    }
    const inside = (l) => l.x >= lo[0] && l.x <= hi[0] && l.y >= lo[1] && l.y <= hi[1] && l.z >= lo[2] && l.z <= hi[2];
    const labelsRemove = this.labels.filter(inside);
    this.labels = this.labels.filter((l) => !inside(l));
    const peopleRemove = this.people.filter(inside).map((p) => ({ ...p }));
    this.people = this.people.filter((p) => !inside(p));
    if (!changes.length && !labelsRemove.length && !peopleRemove.length) return { blocks: 0, labels: 0, people: 0 };
    this.undoStack.push({ cells: changes, labelsRemove, peopleRemove });
    this.redoStack.length = 0;
    if (changes.length) this.emit({ type: 'cells', changes });
    if (labelsRemove.length) this.emit({ type: 'labels' });
    if (peopleRemove.length) this.emit({ type: 'people' });
    return { blocks: changes.length, labels: labelsRemove.length, people: peopleRemove.length };
  }

  boxCells(a, b) {
    const out = [];
    const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
    const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
    const [z0, z1] = [Math.min(a[2], b[2]), Math.max(a[2], b[2])];
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) out.push([x, y, z]);
    return out;
  }

  fillBox(a, b, id) {
    return this.setMany(this.boxCells(a, b).map(([x, y, z]) => [x, y, z, id]));
  }

  // ----- labels -----
  addLabel(x, y, z, text, { record = true, id } = {}) {
    const label = { id: id ?? this.nextLabelId++, x, y, z, text };
    this.nextLabelId = Math.max(this.nextLabelId, label.id + 1);
    this.labels.push(label);
    if (record) {
      this.undoStack.push({ labelAdd: label });
      this.redoStack.length = 0;
    }
    this.emit({ type: 'labels' });
    return label;
  }
  removeLabel(id, { record = true } = {}) {
    const k = this.labels.findIndex((l) => l.id === id);
    if (k < 0) return false;
    const [label] = this.labels.splice(k, 1);
    if (record) {
      this.undoStack.push({ labelRemove: label });
      this.redoStack.length = 0;
    }
    this.emit({ type: 'labels' });
    return true;
  }

  // ----- flowing water and lava -----
  // Water and lava blocks are sources. Like in Minecraft they fall down through empty cells and, once they
  // rest on something, spread sideways (water 7 cells, lava 3), getting shallower with distance.
  // Flow is worked out from the sources each time (nothing extra is saved). Where water and lava flows
  // meet, the cell turns to cobblestone. Returns [{ x, y, z, id, r, fall, step }] (r = reach left, step = how
  // many steps from the source, used to animate the spreading).
  computeFlow(cap = 30000) {
    const result = new Map(); // fluid id -> Map(index -> cell)
    for (const [fid, R] of [[9, 7], [10, 3]]) {
      const best = new Map();
      let layer = [];
      for (let i = 0; i < this.cells.length; i++) if (this.cells[i] === fid) layer.push({ i, r: R, step: 0 });
      const improve = (next, x, y, z, r, fall, step) => {
        const i = this.index(x, y, z);
        const cur = best.get(i);
        if (cur && (r < cur.r || (r === cur.r && (!fall || cur.fall)))) return;
        best.set(i, { x, y, z, r, fall, step: cur ? Math.min(cur.step, step) : step });
        next.push({ i, r, step });
      };
      while (layer.length && best.size < cap) {
        const next = [];
        for (const c of layer) {
          const [x, y, z] = this.coords(c.i);
          if (y > 0 && this.get(x, y - 1, z) === 0) {
            improve(next, x, y - 1, z, R, true, c.step + 1);
            continue;
          }
          if (c.r < 1) continue;
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx;
            const nz = z + dz;
            if (this.inBounds(nx, y, nz) && this.get(nx, y, nz) === 0) improve(next, nx, y, nz, c.r - 1, false, c.step + 1);
          }
        }
        layer = next;
      }
      for (const cell of best.values()) {
        const above = this.get(cell.x, cell.y + 1, cell.z);
        if (above === fid || best.has(this.index(cell.x, cell.y + 1, cell.z))) cell.fall = true;
      }
      result.set(fid, best);
    }
    const out = [];
    const water = result.get(9);
    const lava = result.get(10);
    for (const [i, c] of water) {
      if (lava.has(i)) out.push({ x: c.x, y: c.y, z: c.z, id: 4, r: 0, fall: true, step: Math.max(c.step, lava.get(i).step) });
      else out.push({ ...c, id: 9 });
    }
    for (const [i, c] of lava) if (!water.has(i)) out.push({ ...c, id: 10 });
    return out;
  }

  // ----- people -----
  addPerson(props, { record = true, id } = {}) {
    const p = cleanPerson(props);
    if (!Number.isInteger(p.x) || !Number.isInteger(p.y) || !Number.isInteger(p.z) || !this.inBounds(p.x, p.y, p.z)) return null;
    p.id = id ?? this.nextPersonId++;
    this.nextPersonId = Math.max(this.nextPersonId, p.id + 1);
    this.people.push(p);
    if (record) {
      this.undoStack.push({ personAdd: { ...p } });
      this.redoStack.length = 0;
    }
    this.emit({ type: 'people' });
    return p;
  }
  removePerson(id, { record = true } = {}) {
    const k = this.people.findIndex((p) => p.id === id);
    if (k < 0) return false;
    const [p] = this.people.splice(k, 1);
    if (record) {
      this.undoStack.push({ personRemove: { ...p } });
      this.redoStack.length = 0;
    }
    this.emit({ type: 'people' });
    return true;
  }
  getPerson(id) {
    return this.people.find((p) => p.id === id) || null;
  }
  // Live edits while a customize window is open: not recorded; call recordPersonEdit when done.
  updatePerson(id, changes) {
    const p = this.getPerson(id);
    if (!p) return null;
    Object.assign(p, cleanPerson({ ...p, ...changes }), { id: p.id });
    this.emit({ type: 'people' });
    return p;
  }
  // One undo step for everything changed since `before` (a copy of the person taken when editing began).
  recordPersonEdit(id, before) {
    const now = this.getPerson(id);
    if (!now || JSON.stringify(before) === JSON.stringify(now)) return false;
    this.undoStack.push({ personUpdate: { before: { ...before }, after: { ...now } } });
    this.redoStack.length = 0;
    return true;
  }

  // ----- history -----
  undo() {
    const step = this.undoStack.pop();
    if (!step) return false;
    this.apply(step, true);
    this.redoStack.push(step);
    return true;
  }
  redo() {
    const step = this.redoStack.pop();
    if (!step) return false;
    this.apply(step, false);
    this.undoStack.push(step);
    return true;
  }
  apply(step, reverse) {
    if (step.cells) {
      const changes = [];
      for (const c of step.cells) {
        const value = reverse ? c.from : c.to;
        if (this.cells[c.i] !== value) {
          changes.push({ i: c.i, from: this.cells[c.i], to: value });
          this.cells[c.i] = value;
        }
      }
      this.emit({ type: 'cells', changes });
    }
    if (step.personAdd) {
      if (reverse) this.removePerson(step.personAdd.id, { record: false });
      else this.addPerson(step.personAdd, { record: false, id: step.personAdd.id });
    }
    if (step.personRemove) {
      if (reverse) this.addPerson(step.personRemove, { record: false, id: step.personRemove.id });
      else this.removePerson(step.personRemove.id, { record: false });
    }
    if (step.personUpdate) {
      const target = reverse ? step.personUpdate.before : step.personUpdate.after;
      this.updatePerson(target.id, target);
    }
    if (step.peopleRemove) {
      if (reverse) for (const p of step.peopleRemove) this.addPerson(p, { record: false, id: p.id });
      else for (const p of step.peopleRemove) this.removePerson(p.id, { record: false });
    }
    if (step.labelsRemove) {
      if (reverse) for (const l of step.labelsRemove) this.addLabel(l.x, l.y, l.z, l.text, { record: false, id: l.id });
      else for (const l of step.labelsRemove) this.removeLabel(l.id, { record: false });
    }
    if (step.labelsAdd) {
      if (reverse) for (const l of step.labelsAdd) this.removeLabel(l.id, { record: false });
      else for (const l of step.labelsAdd) this.addLabel(l.x, l.y, l.z, l.text, { record: false, id: l.id });
    }
    if (step.labelAdd) {
      if (reverse) this.removeLabel(step.labelAdd.id, { record: false });
      else this.addLabel(step.labelAdd.x, step.labelAdd.y, step.labelAdd.z, step.labelAdd.text, { record: false, id: step.labelAdd.id });
    }
    if (step.labelRemove) {
      if (reverse) this.addLabel(step.labelRemove.x, step.labelRemove.y, step.labelRemove.z, step.labelRemove.text, { record: false, id: step.labelRemove.id });
      else this.removeLabel(step.labelRemove.id, { record: false });
    }
  }
  clearHistory() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  // ----- ray casting (Amanatides & Woo voxel traversal) -----
  // origin/dir in world cell units. Returns null or:
  //   { cell: [x,y,z] | null, prev: [x,y,z] | null, floor: bool }
  // cell = first solid block hit; prev = the empty cell just before it (where a new block goes);
  // floor = the ray reached the stand's top surface (y = 0) first, and prev is the cell to build on.
  raycast(origin, dir, maxDist = 400) {
    const size = this.size;
    const lo = [0, 0, 0];
    const hi = [size, this.height, size];
    // clip the ray to the world box
    let tMin = 0;
    let tMax = maxDist;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(dir[a]) < 1e-9) {
        if (origin[a] < lo[a] || origin[a] > hi[a]) return null;
      } else {
        let t1 = (lo[a] - origin[a]) / dir[a];
        let t2 = (hi[a] - origin[a]) / dir[a];
        if (t1 > t2) [t1, t2] = [t2, t1];
        tMin = Math.max(tMin, t1);
        tMax = Math.min(tMax, t2);
        if (tMin > tMax) return null;
      }
    }
    const eps = 1e-6;
    const p = [0, 1, 2].map((a) => origin[a] + dir[a] * (tMin + eps));
    const cell = p.map((v, a) => Math.min(Math.max(Math.floor(v), 0), a === 1 ? this.height - 1 : size - 1));
    const step = dir.map((d) => (d > 0 ? 1 : d < 0 ? -1 : 0));
    const tDelta = dir.map((d) => (d === 0 ? Infinity : Math.abs(1 / d)));
    const tNext = [0, 1, 2].map((a) => {
      if (step[a] === 0) return Infinity;
      const boundary = step[a] > 0 ? cell[a] + 1 : cell[a];
      return (boundary - origin[a]) / dir[a];
    });
    let prev = null;
    for (let guard = 0; guard < size * 4 + this.height * 2; guard++) {
      if (this.get(cell[0], cell[1], cell[2])) return { cell: cell.slice(), prev, floor: false };
      prev = cell.slice();
      // advance along the axis with the nearest boundary
      let a = 0;
      if (tNext[1] < tNext[a]) a = 1;
      if (tNext[2] < tNext[a]) a = 2;
      if (tNext[a] > tMax) return null;
      cell[a] += step[a];
      tNext[a] += tDelta[a];
      if (cell[1] < 0) return { cell: null, prev, floor: true };
      if (!this.inBounds(cell[0], cell[1], cell[2])) return null;
    }
    return null;
  }

  // ----- serialisation -----
  // Binary layout: [version, size, height] + RLE (varint run length, block id) + UTF-8 JSON {labels, meta}
  toBytes() {
    const out = [1, this.size, this.height];
    const varint = (n) => {
      while (n >= 128) {
        out.push((n & 127) | 128);
        n >>>= 7;
      }
      out.push(n);
    };
    let run = 0;
    let cur = this.cells[0];
    for (let i = 0; i < this.cells.length; i++) {
      if (this.cells[i] === cur) run++;
      else {
        varint(run);
        out.push(cur);
        cur = this.cells[i];
        run = 1;
      }
    }
    varint(run);
    out.push(cur);
    const json = new TextEncoder().encode(JSON.stringify({ labels: this.labels, meta: this.meta, people: this.people }));
    const header = [];
    let n = json.length;
    while (n >= 128) {
      header.push((n & 127) | 128);
      n >>>= 7;
    }
    header.push(n);
    return Uint8Array.from([...out, ...header, ...json]);
  }

  static fromBytes(bytes) {
    if (bytes[0] !== 1) throw new Error('Unknown scene version');
    const size = bytes[1];
    const height = bytes[2];
    if (!(size >= 8 && size <= 96) || height !== HEIGHT) throw new Error('Bad scene size');
    const world = new World(size);
    let pos = 3;
    const varint = () => {
      let result = 0;
      let shift = 0;
      for (;;) {
        const b = bytes[pos++];
        if (b === undefined) throw new Error('Scene data is cut off');
        result |= (b & 127) << shift;
        if (b < 128) return result >>> 0;
        shift += 7;
      }
    };
    let i = 0;
    while (i < world.cells.length) {
      const run = varint();
      const id = bytes[pos++];
      if (id === undefined || i + run > world.cells.length) throw new Error('Scene data is damaged');
      if (id) world.cells.fill(id, i, i + run);
      i += run;
    }
    const jsonLen = varint();
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(pos, pos + jsonLen)));
    for (const l of json.labels || []) world.addLabel(l.x, l.y, l.z, String(l.text).slice(0, 80), { record: false, id: l.id });
    for (const p of json.people || []) world.addPerson({ ...p }, { record: false, id: Number.isInteger(p.id) ? p.id : undefined });
    Object.assign(world.meta, json.meta || {});
    return world;
  }
}

// ----- text form (URL hash / files) -----
const b64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64 = (str) => {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

// "z" = deflate-compressed, "r" = raw (used when CompressionStream is missing)
export async function encodeWorld(world) {
  const bytes = world.toBytes();
  if (typeof CompressionStream === 'function') return 'z' + b64(await pipe(bytes, new CompressionStream('deflate-raw')));
  return 'r' + b64(bytes);
}

export async function decodeWorld(text) {
  const kind = text[0];
  const body = unb64(text.slice(1));
  if (kind === 'r') return World.fromBytes(body);
  if (kind !== 'z') throw new Error('Not a Blockscape link');
  if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot open compressed scenes');
  return World.fromBytes(await pipe(body, new DecompressionStream('deflate-raw')));
}
