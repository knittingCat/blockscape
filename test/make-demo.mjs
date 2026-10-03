// Builds a demo diorama and prints its share-link payload (used for screenshots/tests).
import { World, encodeWorld } from '../src/world.js';

export function demoWorld() {
  const w = new World(32);
  const set = (x, y, z, id) => w.setMany([[x, y, z, id]], { record: false });
  const box = (a, b, id) => w.setMany(w.boxCells(a, b).map(([x, y, z]) => [x, y, z, id]), { record: false });
  box([0, 0, 0], [31, 0, 31], 1);
  box([20, 0, 6], [28, 0, 14], 9); // pond
  box([19, 0, 5], [29, 0, 5], 5);
  box([8, 1, 10], [14, 4, 16], 12); // house walls
  box([9, 1, 11], [13, 3, 15], 0);
  box([7, 5, 9], [15, 5, 17], 14); // roof
  box([9, 6, 10], [13, 6, 16], 14);
  box([10, 7, 11], [12, 7, 15], 14);
  box([10, 1, 10], [11, 2, 10], 0); // door
  box([13, 2, 10], [13, 3, 10], 15); // window
  set(12, 1, 17, 10);
  set(12, 2, 17, 16);
  for (let y = 1; y <= 4; y++) set(4, y, 6, 11);
  box([2, 5, 4], [6, 6, 8], 13);
  box([3, 7, 5], [5, 7, 7], 13);
  box([16, 1, 22], [20, 3, 24], 3);
  box([17, 4, 22], [19, 4, 24], 4);
  box([22, 1, 20], [22, 1, 24], 20);
  box([23, 1, 20], [23, 1, 24], 22);
  box([24, 1, 20], [24, 1, 24], 24);
  box([5, 1, 24], [8, 1, 27], 7);
  box([5, 0, 24], [8, 0, 27], 7);
  w.addPerson({ x: 11, y: 0, z: 19, rot: 0, name: 'Mia', shirt: '#ef4444', pants: '#1e3a8a', hair: '#7c4a1e', hairStyle: 'long', hat: 'none' });
  w.addPerson({ x: 14, y: 0, z: 19, rot: 1, name: 'The King', skin: '#8d5524', shirt: '#8b5cf6', sleeves: 'long', hat: 'crown', hatColor: '#facc15', hairStyle: 'none' });
  w.addPerson({ x: 17, y: 0, z: 19, rot: 0, skin: '#fde0c8', shirt: '#22c55e', bottoms: 'skirt', pants: '#f8fafc', hat: 'beanie', hatColor: '#06b6d4', hairStyle: 'short', hair: '#e5c07b' });
  w.addPerson({ x: 21, y: 0, z: 16, rot: 3, shirt: '#111827', bottoms: 'shorts', pants: '#475569', hat: 'tophat', hatColor: '#111827', sleeves: 'none' });
  w.addLabel(11, 8, 13, 'Chapter 3: The Little House');
  w.addLabel(24, 1, 9, 'The pond');
  w.meta.title = 'Chapter 3: The Little House';
  return w;
}

if (process.argv[1].endsWith('make-demo.mjs')) console.log(await encodeWorld(demoWorld()));
