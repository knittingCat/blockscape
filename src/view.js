import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { BLOCKS, BLOCK_BY_ID } from './blocks.js';
import { textureCanvas } from './textures.js';

const SKIES = {
  day: { top: '#5aa9ee', bottom: '#cfeaff', hemiSky: 0xdbeeff, hemiGround: 0x8a7a62, hemi: 2.6, sun: 0xfff2d6, sunI: 3.4, sunPos: [0.8, 1.2, 0.55], stars: false },
  sunset: { top: '#4a5aa8', bottom: '#ffae72', hemiSky: 0xffcfa6, hemiGround: 0x5b4060, hemi: 2.0, sun: 0xffa760, sunI: 3.0, sunPos: [1.5, 0.5, 0.35], stars: false },
  night: { top: '#050816', bottom: '#1b2a5c', hemiSky: 0x3a4a8c, hemiGround: 0x14142a, hemi: 1.6, sun: 0x9bb4ff, sunI: 0.9, sunPos: [-0.7, 1.2, 0.6], stars: true },
};

export class DioramaView {
  constructor(container, world) {
    this.container = container;
    this.world = world;
    this.typeMeshes = new Map(); // block id -> { mesh, capacity }
    this.labelSprites = new Map(); // label id -> Sprite
    this.textures = new Map();
    this.materials = new Map();
    this.geometry = new THREE.BoxGeometry(1, 1, 1);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    this.canvas = this.renderer.domElement;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 600);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.maxPolarAngle = Math.PI / 2 - 0.03;
    this.controls.autoRotateSpeed = 1.6;

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 1);
    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.hemi, this.sun, this.sun.target);

    this.stars = this.makeStars();
    this.scene.add(this.stars);

    this.helpers = new THREE.Group(); // hidden when taking pictures
    this.scene.add(this.helpers);
    this.makeCursor();

    this.buildStage();
    this.setSky(world.meta.sky || 'day');
    this.resetCamera();
    this.rebuildAll();
    this.rebuildLabels();

    this.onResize = () => this.resize();
    window.addEventListener('resize', this.onResize);
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();

    world.onChange((e) => {
      if (e.type === 'cells') this.rebuild(new Set(e.changes.flatMap((c) => [c.from, c.to])));
      else if (e.type === 'labels') this.rebuildLabels();
    });

    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  get offset() {
    return this.world.size / 2;
  }

  // ----- stage: stand, grid, lights sized to the world -----
  buildStage() {
    const size = this.world.size;
    if (this.stage) {
      this.scene.remove(this.stage);
      this.helpers.remove(this.grid);
    }
    this.stage = new THREE.Group();
    const dark = this.texture('planks');
    const floor = new THREE.MeshLambertMaterial({ map: this.texture('dirt'), color: 0xbbbbbb });
    const woodSide = new THREE.MeshLambertMaterial({ map: this.texture('logSide'), color: 0xb0a090 });
    const slab = (w, h, y, mats) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), mats);
      m.position.y = y;
      m.receiveShadow = true;
      m.castShadow = true;
      this.stage.add(m);
    };
    const frame = new THREE.MeshLambertMaterial({ map: dark, color: 0x8d6b45 });
    slab(size + 1.2, 1.4, -0.7, [woodSide, woodSide, floor, frame, woodSide, woodSide]);
    slab(size + 2.6, 0.6, -1.7, [frame, frame, frame, frame, frame, frame]);
    this.scene.add(this.stage);

    this.grid = new THREE.GridHelper(size, size, 0x000000, 0x000000);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.18;
    this.grid.position.y = 0.02;
    this.helpers.add(this.grid);

    const s = size * 0.95;
    Object.assign(this.sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: size * 6 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.controls.maxDistance = size * 3.2;
    this.controls.minDistance = 4;
  }

  makeStars() {
    const pts = [];
    let a = 12345;
    const r = () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 500; i++) {
      const u = r() * Math.PI * 2;
      const v = Math.acos(r() * 0.9 + 0.08);
      pts.push(Math.sin(v) * Math.cos(u) * 280, Math.cos(v) * 280, Math.sin(v) * Math.sin(u) * 280);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1.4, sizeAttenuation: false, fog: false }));
    stars.visible = false;
    return stars;
  }

  makeCursor() {
    this.ghost = new THREE.Mesh(this.geometry, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false }));
    this.ghost.scale.setScalar(1.002);
    this.ghostEdges = new THREE.LineSegments(new THREE.EdgesGeometry(this.geometry), new THREE.LineBasicMaterial({ color: 0x000000 }));
    this.ghost.add(this.ghostEdges);
    this.ghost.visible = false;
    this.ghost.renderOrder = 5;
    this.helpers.add(this.ghost);

    this.region = new THREE.LineSegments(new THREE.EdgesGeometry(this.geometry), new THREE.LineBasicMaterial({ color: 0xffd23f }));
    this.region.visible = false;
    this.helpers.add(this.region);
  }

  // ----- sky & lighting -----
  setSky(name) {
    const s = SKIES[name] || SKIES.day;
    this.world.meta.sky = SKIES[name] ? name : 'day';
    const c = document.createElement('canvas');
    c.width = 2;
    c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, s.top);
    g.addColorStop(1, s.bottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 2, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.scene.background?.dispose?.();
    this.scene.background = tex;
    this.hemi.color.set(s.hemiSky);
    this.hemi.groundColor.set(s.hemiGround);
    this.hemi.intensity = s.hemi;
    this.sun.color.set(s.sun);
    this.sun.intensity = s.sunI;
    const k = this.world.size;
    this.sun.position.set(s.sunPos[0] * k, s.sunPos[1] * k, s.sunPos[2] * k);
    this.stars.visible = s.stars;
    this.applyGlow();
    this.dirty = true;
  }

  applyGlow() {
    const night = this.world.meta.sky === 'night';
    for (const mats of this.materials.values()) for (const m of mats) if (m.userData.glow) m.emissiveIntensity = m.userData.glow * (night ? 1.4 : 0.8);
  }

  // ----- materials & textures -----
  texture(name) {
    if (!this.textures.has(name)) {
      const t = new THREE.CanvasTexture(textureCanvas(name));
      t.colorSpace = THREE.SRGBColorSpace;
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestMipmapLinearFilter;
      t.anisotropy = 4;
      this.textures.set(name, t);
    }
    return this.textures.get(name);
  }

  blockMaterials(block) {
    if (this.materials.has(block.id)) return this.materials.get(block.id);
    const tex = typeof block.tex === 'string' ? { top: block.tex, side: block.tex, bottom: block.tex } : block.tex;
    const make = (name) => {
      const m = new THREE.MeshLambertMaterial({ map: this.texture(name) });
      if (block.alpha) {
        m.transparent = true;
        m.opacity = block.alpha;
        m.depthWrite = false;
      }
      if (block.glow) {
        m.emissive = new THREE.Color(0xffffff);
        m.emissiveMap = this.texture(name);
        m.userData.glow = block.glow;
        m.emissiveIntensity = block.glow * 0.8;
      }
      return m;
    };
    // BoxGeometry face order: +x, -x, +y, -y, +z, -z
    const side = make(tex.side);
    const mats = [side, side, make(tex.top), make(tex.bottom), side, side];
    this.materials.set(block.id, mats);
    return mats;
  }

  // ----- voxel meshes -----
  rebuildAll() {
    this.rebuild(new Set(BLOCKS.map((b) => b.id)));
  }

  rebuild(types) {
    const w = this.world;
    const lists = new Map();
    for (const id of types) if (id) lists.set(id, []);
    const cells = w.cells;
    for (let i = 0; i < cells.length; i++) {
      const id = cells[i];
      if (id && lists.has(id)) lists.get(id).push(i);
    }
    const m = new THREE.Matrix4();
    const off = this.offset;
    for (const [id, idx] of lists) {
      const block = BLOCK_BY_ID.get(id);
      if (!block) continue;
      let entry = this.typeMeshes.get(id);
      if (!entry || entry.capacity < idx.length) {
        if (entry) {
          this.scene.remove(entry.mesh);
          entry.mesh.dispose();
        }
        const capacity = Math.max(256, 2 ** Math.ceil(Math.log2(Math.max(idx.length, 1))));
        const mesh = new THREE.InstancedMesh(this.geometry, this.blockMaterials(block), capacity);
        mesh.frustumCulled = false;
        mesh.castShadow = !block.alpha;
        mesh.receiveShadow = true;
        mesh.renderOrder = block.alpha ? 2 : 0;
        mesh.count = 0;
        this.scene.add(mesh);
        entry = { mesh, capacity };
        this.typeMeshes.set(id, entry);
      }
      for (let k = 0; k < idx.length; k++) {
        const [x, y, z] = w.coords(idx[k]);
        m.setPosition(x + 0.5 - off, y + 0.5, z + 0.5 - off);
        entry.mesh.setMatrixAt(k, m);
      }
      entry.mesh.count = idx.length;
      entry.mesh.instanceMatrix.needsUpdate = true;
    }
    this.applyGlow();
    this.dirty = true;
  }

  // Replace the world (new/open): stage and meshes are resized to match.
  setWorld(world) {
    for (const { mesh } of this.typeMeshes.values()) {
      this.scene.remove(mesh);
      mesh.dispose();
    }
    this.typeMeshes.clear();
    for (const s of this.labelSprites.values()) this.scene.remove(s);
    this.labelSprites.clear();
    this.world = world;
    this.buildStage();
    this.rebuildAll();
    this.rebuildLabels();
    this.setSky(world.meta.sky || 'day');
    this.resetCamera();
    world.onChange((e) => {
      if (world !== this.world) return;
      if (e.type === 'cells') this.rebuild(new Set(e.changes.flatMap((c) => [c.from, c.to])));
      else if (e.type === 'labels') this.rebuildLabels();
    });
  }

  // ----- labels (text signs) -----
  rebuildLabels() {
    this.dirty = true;
    const ids = new Set(this.world.labels.map((l) => l.id));
    for (const [id, sprite] of this.labelSprites) {
      if (!ids.has(id)) {
        this.scene.remove(sprite);
        sprite.material.map.dispose();
        sprite.material.dispose();
        this.labelSprites.delete(id);
      }
    }
    const off = this.offset;
    for (const l of this.world.labels) {
      if (this.labelSprites.has(l.id)) continue;
      const sprite = this.makeLabelSprite(l.text);
      sprite.position.set(l.x + 0.5 - off, l.y + 0.1, l.z + 0.5 - off);
      sprite.userData.labelId = l.id;
      this.scene.add(sprite);
      this.labelSprites.set(l.id, sprite);
    }
  }

  makeLabelSprite(text) {
    const font = 'bold 40px system-ui, -apple-system, "Segoe UI", sans-serif';
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    ctx.font = font;
    const tw = Math.ceil(ctx.measureText(text).width);
    const padX = 22;
    const w = tw + padX * 2;
    const h = 84;
    c.width = w;
    c.height = h + 22;
    ctx.font = font;
    ctx.fillStyle = 'rgba(20,20,30,0.88)';
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(2, 2, w - 4, h - 4, 16);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(w / 2 - 14, h - 4);
    ctx.lineTo(w / 2, h + 20);
    ctx.lineTo(w / 2 + 14, h - 4);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(text, w / 2, h / 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    const unit = 0.022;
    sprite.scale.set(c.width * unit, c.height * unit, 1);
    sprite.center.set(0.5, 0); // the tail tip sits on the anchor point
    sprite.renderOrder = 10;
    return sprite;
  }

  // ----- picking -----
  // Returns a ray in WORLD cell coordinates for a pointer position.
  rayFromPointer(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    const off = this.offset;
    return {
      origin: [rc.ray.origin.x + off, rc.ray.origin.y, rc.ray.origin.z + off],
      dir: [rc.ray.direction.x, rc.ray.direction.y, rc.ray.direction.z],
      ndc,
      raycaster: rc,
    };
  }

  labelAt(ray) {
    const hits = ray.raycaster.intersectObjects([...this.labelSprites.values()], false);
    return hits.length ? hits[0].object.userData.labelId : null;
  }

  // ----- cursor visuals -----
  showGhost(cell, { color = 0xffffff, opacity = 0.5, scale = 1.002 } = {}) {
    this.dirty = true;
    if (!cell) {
      this.ghost.visible = false;
      return;
    }
    const off = this.offset;
    this.ghost.position.set(cell[0] + 0.5 - off, cell[1] + 0.5, cell[2] + 0.5 - off);
    this.ghost.scale.setScalar(scale);
    this.ghost.material.color.set(color);
    this.ghost.material.opacity = opacity;
    this.ghost.visible = true;
  }

  showRegion(a, b) {
    this.dirty = true;
    if (!a || !b) {
      this.region.visible = false;
      return;
    }
    const off = this.offset;
    const lo = [0, 1, 2].map((i) => Math.min(a[i], b[i]));
    const hi = [0, 1, 2].map((i) => Math.max(a[i], b[i]) + 1);
    this.region.scale.set(hi[0] - lo[0] + 0.02, hi[1] - lo[1] + 0.02, hi[2] - lo[2] + 0.02);
    this.region.position.set((lo[0] + hi[0]) / 2 - off, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2 - off);
    this.region.visible = true;
  }

  setGhostTint(block) {
    // average colour of a block's top texture, used to tint the placement preview
    this.tints = this.tints || new Map();
    if (this.tints.has(block.id)) return this.tints.get(block.id);
    const canvas = textureCanvas(typeof block.tex === 'string' ? block.tex : block.tex.top);
    const d = canvas.getContext('2d').getImageData(0, 0, 16, 16).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
    }
    const n = d.length / 4;
    const tint = (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n);
    this.tints.set(block.id, tint);
    return tint;
  }

  // ----- camera -----
  resetCamera() {
    this.dirty = true;
    const k = this.world.size;
    this.controls.target.set(0, k * 0.1, 0);
    this.camera.position.set(k * 0.62, k * 0.58, k * 0.8);
    this.controls.update();
  }

  setHelpersVisible(v) {
    this.dirty = true;
    this.helpers.visible = v;
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  invalidate() {
    this.dirty = true;
  }

  // Renders only when something changed (camera moved, scene edited, cursor moved), so an idle
  // page uses almost no CPU/GPU.
  loop() {
    requestAnimationFrame(this.loop);
    const lim = this.world.size / 2 + 2;
    const t = this.controls.target;
    t.x = Math.max(-lim, Math.min(lim, t.x));
    t.z = Math.max(-lim, Math.min(lim, t.z));
    t.y = Math.max(0, Math.min(this.world.height, t.y));
    const moved = this.controls.update();
    if (moved || this.dirty) {
      this.dirty = false;
      this.renderer.render(this.scene, this.camera);
    }
  }

  // Render a clean picture (no grid/cursor) at the given size. Returns a 2D canvas.
  snapshot(width, height) {
    const oldSize = new THREE.Vector2();
    this.renderer.getSize(oldSize);
    const oldPR = this.renderer.getPixelRatio();
    const oldAspect = this.camera.aspect;
    const helpersWere = this.helpers.visible;
    this.helpers.visible = false;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    out.getContext('2d').drawImage(this.canvas, 0, 0);
    this.helpers.visible = helpersWere;
    this.renderer.setPixelRatio(oldPR);
    this.renderer.setSize(oldSize.x, oldSize.y, false);
    this.camera.aspect = oldAspect;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
    return out;
  }
}
