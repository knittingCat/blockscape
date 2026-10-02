import assert from 'node:assert/strict';
import { World, encodeWorld, decodeWorld } from '../src/world.js';

let n = 0;
const test = async (name, fn) => {
  await fn();
  n++;
  console.log('ok -', name);
};

await test('set/get and bounds', () => {
  const w = new World(8);
  assert.equal(w.setMany([[1, 2, 3, 5], [99, 0, 0, 1], [0, -1, 0, 1]]), 1);
  assert.equal(w.get(1, 2, 3), 5);
  assert.equal(w.get(99, 0, 0), 0);
  assert.deepEqual(w.coords(w.index(1, 2, 3)), [1, 2, 3]);
});

await test('undo / redo one step per edit', () => {
  const w = new World(8);
  w.fillBox([0, 0, 0], [1, 1, 1], 3);
  assert.equal(w.count(), 8);
  w.setMany([[5, 5, 5, 2]]);
  assert.equal(w.count(), 9);
  assert.ok(w.undo());
  assert.equal(w.count(), 8);
  assert.ok(w.undo());
  assert.equal(w.count(), 0);
  assert.equal(w.undo(), false);
  assert.ok(w.redo());
  assert.equal(w.count(), 8);
  w.setMany([[7, 7, 7, 1]]); // a new edit clears redo
  assert.equal(w.redo(), false);
});

await test('no-op edits are not recorded', () => {
  const w = new World(8);
  w.setMany([[0, 0, 0, 1]]);
  assert.equal(w.setMany([[0, 0, 0, 1]]), 0);
  assert.equal(w.undoStack.length, 1);
});

await test('raycast hits the first block and reports the cell to build on', () => {
  const w = new World(8);
  w.setMany([[4, 0, 4, 1]]);
  // from above-left looking straight along +x at y=0.5, z=4.5
  const hit = w.raycast([-3, 0.5, 4.5], [1, 0, 0]);
  assert.deepEqual(hit.cell, [4, 0, 4]);
  assert.deepEqual(hit.prev, [3, 0, 4]);
  // from above, straight down onto the block
  const top = w.raycast([4.5, 20, 4.5], [0, -1, 0]);
  assert.deepEqual(top.cell, [4, 0, 4]);
  assert.deepEqual(top.prev, [4, 1, 4]);
});

await test('raycast reaches the floor and builds at y = 0', () => {
  const w = new World(8);
  const hit = w.raycast([2.5, 10, 2.5], [0, -1, 0]);
  assert.equal(hit.floor, true);
  assert.equal(hit.cell, null);
  assert.deepEqual(hit.prev, [2, 0, 2]);
});

await test('raycast diagonal and misses', () => {
  const w = new World(16);
  w.setMany([[8, 3, 8, 1]]);
  const dir = [0.5, -0.5, 0.5].map((v) => v / Math.hypot(0.5, 0.5, 0.5));
  const hit = w.raycast([8.5 - 5, 3.5 + 5, 8.5 - 5], dir);
  assert.deepEqual(hit.cell, [8, 3, 8]);
  assert.equal(w.raycast([-5, 5, -5], [-1, 0, 0]), null); // pointing away
  assert.equal(w.raycast([100, 5, 100], [0, 1, 0]), null);
});

await test('raycast inside the world starts from the camera cell', () => {
  const w = new World(8);
  w.setMany([[6, 2, 4, 1]]);
  const hit = w.raycast([1.5, 2.5, 4.5], [1, 0, 0]);
  assert.deepEqual(hit.cell, [6, 2, 4]);
  assert.deepEqual(hit.prev, [5, 2, 4]);
});

await test('labels with undo', () => {
  const w = new World(8);
  const l = w.addLabel(1, 2, 3, 'Hello');
  assert.equal(w.labels.length, 1);
  w.undo();
  assert.equal(w.labels.length, 0);
  w.redo();
  assert.equal(w.labels[0].id, l.id);
  w.removeLabel(l.id);
  assert.equal(w.labels.length, 0);
  w.undo();
  assert.equal(w.labels[0].text, 'Hello');
});

await test('encode/decode round trip (compressed)', async () => {
  const w = new World(24);
  w.fillBox([0, 0, 0], [23, 0, 23], 1);
  w.fillBox([3, 1, 3], [6, 4, 6], 12);
  w.setMany([[10, 5, 10, 28], [11, 5, 10, 27]]);
  w.addLabel(5, 6, 5, 'Chapter 3 — “The Door”');
  w.meta.sky = 'night';
  w.meta.title = 'My scene';
  const text = await encodeWorld(w);
  assert.match(text, /^z[A-Za-z0-9_-]+$/);
  const back = await decodeWorld(text);
  assert.equal(back.size, 24);
  assert.deepEqual(back.cells, w.cells);
  assert.equal(back.labels[0].text, 'Chapter 3 — “The Door”');
  assert.equal(back.meta.sky, 'night');
  assert.ok(text.length < 400, `link too long: ${text.length}`);
});

await test('decode rejects garbage', async () => {
  await assert.rejects(() => decodeWorld('zAAAA'));
  await assert.rejects(() => decodeWorld('qq'));
});

await test('random scene survives a round trip', async () => {
  const w = new World(32);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 4000; i++) w.setMany([[Math.floor(rnd() * 32), Math.floor(rnd() * 32), Math.floor(rnd() * 32), 1 + Math.floor(rnd() * 28)]], { record: false });
  const back = await decodeWorld(await encodeWorld(w));
  assert.deepEqual(back.cells, w.cells);
});

const { extract, rotate90, originFor, placement, normalizeBox } = await import('../src/clipboard.js');

await test('extract copies only blocks and labels inside the box', () => {
  const w = new World(16);
  w.setMany([[2, 0, 2, 5], [3, 1, 2, 6], [9, 0, 9, 7]]);
  w.addLabel(3, 2, 3, 'in');
  w.addLabel(12, 0, 12, 'out');
  const clip = extract(w, [3, 1, 3], [2, 0, 2]); // corners in any order
  assert.deepEqual([clip.w, clip.h, clip.d], [2, 2, 2]);
  assert.equal(clip.cells.length, 2);
  assert.ok(clip.cells.some(([x, y, z, id]) => x === 0 && y === 0 && z === 0 && id === 5));
  assert.ok(clip.cells.some(([x, y, z, id]) => x === 1 && y === 1 && z === 0 && id === 6));
  assert.equal(clip.labels.length, 0); // label at y=2 is above the box
  assert.deepEqual(normalizeBox([5, 1, 9], [2, 4, 3]), { min: [2, 1, 3], max: [5, 4, 9] });
});

await test('rotate90 four times returns the original; dimensions swap', () => {
  const w = new World(16);
  w.setMany([[0, 0, 0, 1], [2, 0, 0, 2], [0, 1, 1, 3]]);
  w.addLabel(2, 0, 1, 'sign');
  const clip = extract(w, [0, 0, 0], [2, 1, 1]);
  const r1 = rotate90(clip);
  assert.deepEqual([r1.w, r1.h, r1.d], [2, 2, 3]);
  let r = clip;
  for (let i = 0; i < 4; i++) r = rotate90(r);
  const key = (c) => JSON.stringify([c.w, c.h, c.d, [...c.cells].sort(), c.labels]);
  assert.equal(key(r), key(clip));
  // every rotated cell stays inside the new box
  for (const [x, y, z] of r1.cells) assert.ok(x >= 0 && x < r1.w && y >= 0 && y < r1.h && z >= 0 && z < r1.d);
});

await test('paste: placement, fit check, one undo step including labels', () => {
  const w = new World(16);
  w.fillBox([0, 0, 0], [2, 1, 2], 4);
  w.addLabel(1, 2, 1, 'house');
  const clip = extract(w, [0, 0, 0], [2, 2, 2]);
  const origin = originFor(clip, [8, 0, 8]);
  assert.deepEqual(origin, [7, 0, 7]);
  const p = placement(w, clip, origin);
  assert.equal(p.fits, true);
  const before = w.count();
  w.setManyWithLabels(p.cells, p.labels);
  assert.equal(w.count(), before + clip.cells.length);
  assert.equal(w.labels.length, 2);
  assert.equal(w.get(8, 1, 8), 4);
  assert.ok(w.undo()); // a single undo removes blocks AND the copied label
  assert.equal(w.count(), before);
  assert.equal(w.labels.length, 1);
  assert.ok(w.redo());
  assert.equal(w.labels.length, 2);
  assert.equal(placement(w, clip, [14, 0, 14]).fits, false); // sticks out of the world
  assert.equal(placement(w, clip, [7, 31, 7]).fits, false); // too tall
});

console.log(`${n} tests passed`);
