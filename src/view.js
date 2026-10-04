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
    this.personGroups = new Map(); // person id -> { sig, group }
    this.personMats = new Map(); // colour -> material (shared)
    this.textures = new Map();
    this.flowMeshes = new Map();
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

    this.initGlow();
    this.initFire();
    this.helpers = new THREE.Group(); // hidden when taking pictures
    this.scene.add(this.helpers);
    this.makeCursor();

    this.buildStage();
    this.setSky(world.meta.sky || 'day');
    this.resetCamera();
    this.rebuildAll();
    this.rebuildLabels();
    this.rebuildPeople();

    this.onResize = () => this.resize();
    window.addEventListener('resize', this.onResize);
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();

    world.onChange((e) => {
      if (e.type === 'cells') this.rebuild(new Set(e.changes.flatMap((c) => [c.from, c.to])));
      else if (e.type === 'labels') this.rebuildLabels();
      else if (e.type === 'people') this.rebuildPeople();
      else if (e.type === 'fire') this.scheduleFire();
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

    // selected area (cyan) and paste footprint (green/red plate + outline)
    this.selection = new THREE.Group();
    this.selection.add(
      new THREE.LineSegments(new THREE.EdgesGeometry(this.geometry), new THREE.LineBasicMaterial({ color: 0x4dd0e1 })),
      new THREE.Mesh(this.geometry, new THREE.MeshBasicMaterial({ color: 0x4dd0e1, transparent: true, opacity: 0.14, depthWrite: false })),
    );
    this.selection.visible = false;
    this.footprint = new THREE.Group();
    this.footprintEdges = new THREE.LineSegments(new THREE.EdgesGeometry(this.geometry), new THREE.LineBasicMaterial({ color: 0xffffff }));
    this.footprintBody = new THREE.Mesh(this.geometry, new THREE.MeshBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.12, depthWrite: false }));
    this.footprintPlate = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }));
    this.footprintPlate.rotation.x = -Math.PI / 2;
    this.footprint.add(this.footprintEdges, this.footprintBody, this.footprintPlate);
    this.footprint.visible = false;
    this.helpers.add(this.selection, this.footprint);

    // extra ghosts for the mirrored copies, and the two symmetry planes
    this.mirrorGhosts = [];
    this.planeX = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x7c9cff, transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide }));
    this.planeZ = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x7c9cff, transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide }));
    this.planeX.rotation.y = Math.PI / 2; // the plane x = centre
    this.planeX.visible = this.planeZ.visible = false;
    this.helpers.add(this.planeX, this.planeZ);

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

  // ----- glow: a faint halo around glowstone and lava blocks -----
  initGlow() {
    this.glowKinds = new Map(); // block id -> { material, points }
    // glowstone and lava: wide, faint halos (tinted by each material's colour), so overlapping ones stay soft instead of blowing out
    const soft = document.createElement('canvas');
    soft.width = soft.height = 64;
    const sg = soft.getContext('2d');
    const sgrad = sg.createRadialGradient(32, 32, 0, 32, 32, 32);
    sgrad.addColorStop(0, 'rgba(255,255,255,0.55)');
    sgrad.addColorStop(0.5, 'rgba(255,255,255,0.18)');
    sgrad.addColorStop(1, 'rgba(255,255,255,0)');
    sg.fillStyle = sgrad;
    sg.fillRect(0, 0, 64, 64);
    const softTex = new THREE.CanvasTexture(soft);
    softTex.colorSpace = THREE.SRGBColorSpace;
    for (const [id, color, size, map, day, night] of [[16, 0xffd070, 4.2, softTex, 0.3, 0.55], [10, 0xff7a30, 4.2, softTex, 0.3, 0.55]]) {
      const material = new THREE.PointsMaterial({ map, size, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: day });
      material.userData.day = day;
      material.userData.night = night;
      const points = new THREE.Points(new THREE.BufferGeometry(), material);
      points.frustumCulled = false;
      points.visible = false;
      this.scene.add(points);
      this.glowKinds.set(id, { material, points });
    }
    // a fixed number of soft lights (changing the count would make the shaders rebuild); they sit over the biggest
    // groups of glowstone and lava and gently light the blocks around them
    this.glowLights = [];
    for (let i = 0; i < 8; i++) {
      const l = new THREE.PointLight(0xffc766, 0, 9, 1.6);
      l.userData.base = 0;
      this.scene.add(l);
      this.glowLights.push(l);
    }
    // halos for flowing lava (follows the animated flow, see updateFlowReveal)
    this.lavaFlowPoints = new THREE.Points(new THREE.BufferGeometry(), this.glowKinds.get(10).material);
    this.lavaFlowPoints.frustumCulled = false;
    this.lavaFlowPoints.visible = false;
    this.scene.add(this.lavaFlowPoints);
  }

  rebuildGlow() {
    const w = this.world;
    const off = this.offset;
    const ptsById = new Map([...this.glowKinds.keys()].map((id) => [id, []]));
    const buckets = new Map();
    for (let i = 0; i < w.cells.length; i++) {
      const id = w.cells[i];
      const pts = ptsById.get(id);
      if (!pts) continue;
      const [x, y, z] = w.coords(i);
      const p = [x + 0.5 - off, y + 0.5, z + 0.5 - off];
      pts.push(...p);
      const k = `${id}:${Math.floor(x / 6)},${Math.floor(y / 6)},${Math.floor(z / 6)}`;
      const b = buckets.get(k) || { id, n: 0, x: 0, y: 0, z: 0 };
      b.n++;
      b.x += p[0];
      b.y += p[1];
      b.z += p[2];
      buckets.set(k, b);
    }
    for (const [id, { points }] of this.glowKinds) {
      const pts = ptsById.get(id);
      points.geometry.dispose();
      points.geometry = new THREE.BufferGeometry();
      points.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      points.visible = pts.length > 0;
    }
    const top = [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, this.glowLights.length);
    this.glowLights.forEach((l, i) => {
      const b = top[i];
      if (b) {
        l.position.set(b.x / b.n, b.y / b.n + 0.7, b.z / b.n);
        l.color.setHex(b.id === 10 ? 0xff7a30 : 0xffd070);
        l.userData.base = Math.min(1.1, 0.35 + 0.1 * b.n);
      } else l.userData.base = 0;
    });
    this.applyGlow();
    this.dirty = true;
  }

  applyGlow() {
    const night = this.world.meta.sky === 'night';
    for (const { material } of this.glowKinds.values()) material.opacity = night ? material.userData.night : material.userData.day;
    for (const l of this.glowLights || []) l.intensity = l.userData.base * (night ? 2 : 0.7);
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
        mesh.castShadow = !block.alpha && !block.glow; // glowing blocks are light sources: no dark shadow under them
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
    if (this.glowKinds && (types.has(16) || types.has(10) || !this.glowBuilt)) {
      this.glowBuilt = true;
      this.rebuildGlow();
    }
    this.applyGlow();
    this.dirty = true;
    this.scheduleFlow();
    this.scheduleFire();
  }

  // ----- fire: flickering flames on burning blocks (the burning cells live in the world and are saved) -----
  initFire() {
    // four frames of pixel flames stacked in one texture
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 64;
    const g = c.getContext('2d');
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let f = 0; f < 4; f++) {
      for (let x = 0; x < 16; x++) {
        const edge = 1 - Math.abs(x - 7.5) / 9; // taller in the middle
        const h = Math.max(5, Math.min(16, Math.round(6 + edge * 7 + rnd() * 5)));
        for (let k = 0; k < h; k++) {
          const t = k / 15; // 0 at the bottom of the flame, 1 at the very top
          const col = t < 0.22 ? [255, 226, 90] : t < 0.55 ? [255, 150, 28] : [226, 56, 16];
          g.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
          g.fillRect(x, f * 16 + 15 - k, 1, 1);
        }
      }
    }
    this.fireTexture = new THREE.CanvasTexture(c);
    this.fireTexture.colorSpace = THREE.SRGBColorSpace;
    this.fireTexture.magFilter = THREE.NearestFilter;
    this.fireTexture.minFilter = THREE.NearestFilter;
    this.fireTexture.repeat.set(1, 0.25);
    this.fireTexture.offset.set(0, 0);
    this.fireMaterial = new THREE.MeshBasicMaterial({ map: this.fireTexture, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide });
    // two crossed flame planes standing on a cell's floor
    const pos = [-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0, 0, 0, -0.5, 0, 0, 0.5, 0, 1, 0.5, 0, 1, -0.5];
    const crossed = new THREE.BufferGeometry();
    crossed.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    crossed.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1], 2));
    crossed.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    this.fireGeometries = { top: crossed, side: new THREE.PlaneGeometry(1, 1) };
    this.fireMeshes = {};
    this.fireCount = 0;
    this.fireFrame = 0;
    // a soft orange glow over the flames
    this.fireHalo = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ map: this.glowKinds.get(10).material.map, size: 3, color: 0xff8a30, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.3 }));
    this.fireHalo.frustumCulled = false;
    this.fireHalo.visible = false;
    this.scene.add(this.fireHalo);
  }

  scheduleFire() {
    if (this.firePending) return;
    this.firePending = true;
    requestAnimationFrame(() => {
      this.firePending = false;
      this.rebuildFire();
    });
  }

  rebuildFire() {
    const w = this.world;
    const off = this.offset;
    const tops = [];
    const sides = [];
    const halo = [];
    for (const [x, y, z] of w.burningCells()) {
      halo.push(x + 0.5 - off, y + 0.7, z + 0.5 - off);
      if (w.inBounds(x, y + 1, z) && w.get(x, y + 1, z) === 0) tops.push([x + 0.5 - off, y + 1, z + 0.5 - off, 0]);
      for (const [dx, dz, rot] of [[1, 0, Math.PI / 2], [-1, 0, Math.PI / 2], [0, 1, 0], [0, -1, 0]]) {
        if (w.get(x + dx, y, z + dz) === 0) sides.push([x + 0.5 - off + dx * 0.51, y + 0.5, z + 0.5 - off + dz * 0.51, rot]);
      }
    }
    this.fireCount = tops.length + sides.length;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    for (const [kind, list] of [['top', tops], ['side', sides]]) {
      let entry = this.fireMeshes[kind];
      if (!entry || entry.capacity < list.length) {
        if (entry) {
          this.scene.remove(entry.mesh);
          entry.mesh.dispose();
        }
        const capacity = Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(list.length, 1))));
        const mesh = new THREE.InstancedMesh(this.fireGeometries[kind], this.fireMaterial, capacity);
        mesh.frustumCulled = false;
        mesh.count = 0;
        this.scene.add(mesh);
        entry = { mesh, capacity };
        this.fireMeshes[kind] = entry;
      }
      list.forEach(([x, y, z, rot], k) => {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot);
        m.compose(new THREE.Vector3(x, y, z), q, one);
        entry.mesh.setMatrixAt(k, m);
      });
      entry.mesh.count = list.length;
      entry.mesh.instanceMatrix.needsUpdate = true;
    }
    this.fireHalo.geometry.dispose();
    this.fireHalo.geometry = new THREE.BufferGeometry();
    this.fireHalo.geometry.setAttribute('position', new THREE.Float32BufferAttribute(halo, 3));
    this.fireHalo.visible = halo.length > 0;
    this.dirty = true;
  }

  // ----- flowing water and lava (worked out from the source blocks; see World.computeFlow) -----
  scheduleFlow() {
    if (this.flowPending) return;
    this.flowPending = true;
    requestAnimationFrame(() => {
      this.flowPending = false;
      this.rebuildFlow();
    });
  }

  rebuildFlow() {
    const fresh = this.world.computeFlow();
    const STEP_TIME = { 9: 0.6, 10: 0.6, 4: 0.8 }; // seconds per step: lava and water spread, drain from the far end
    const key = (c) => `${c.id}:${c.x},${c.y},${c.z}`;
    const elapsed = (performance.now() - (this.flowStart || 0)) / 1000;
    // what is on screen right now (including cells still draining), so interrupted animations carry on smoothly
    const shown = new Map();
    for (const { items } of this.flowMeshes.values()) for (const it of items || []) if (it.t <= elapsed && elapsed < it.until) shown.set(key(it.c), it.c);
    const now = new Map(fresh.map((c) => [key(c), c]));
    const items = [];
    const newOnes = fresh.filter((c) => !shown.has(key(c)));
    const firstStep = newOnes.length ? Math.min(...newOnes.map((c) => c.step)) : 0;
    for (const c of fresh) items.push({ c, t: shown.has(key(c)) ? 0 : (c.step - firstStep + 1) * STEP_TIME[c.id], until: Infinity });
    // cells that lost their source drain away slowly, starting next to where the source was and moving outward
    // and downward (the way liquid runs off), not back up toward it
    const gone = [...shown].filter(([k]) => !now.has(k)).map(([, c]) => c);
    const firstGone = gone.length ? Math.min(...gone.map((c) => c.step)) : 0;
    for (const c of gone) items.push({ c, t: 0, until: (c.step - firstGone + 1) * STEP_TIME[c.id] * 1.2 });
    const byId = new Map();
    for (const it of items) {
      if (!byId.has(it.c.id)) byId.set(it.c.id, []);
      byId.get(it.c.id).push(it);
    }
    const m = new THREE.Matrix4();
    const off = this.offset;
    for (const id of new Set([...this.flowMeshes.keys(), ...byId.keys()])) {
      const list = byId.get(id) || [];
      let entry = this.flowMeshes.get(id);
      if (!entry || entry.capacity < list.length) {
        if (entry) {
          this.scene.remove(entry.mesh);
          entry.mesh.dispose();
        }
        const capacity = Math.max(256, 2 ** Math.ceil(Math.log2(Math.max(list.length, 1))));
        const block = BLOCK_BY_ID.get(id);
        const mesh = new THREE.InstancedMesh(this.geometry, this.blockMaterials(block), capacity);
        mesh.frustumCulled = false;
        mesh.castShadow = !block.alpha && !block.glow; // glowing blocks are light sources: no dark shadow under them
        mesh.receiveShadow = true;
        mesh.renderOrder = block.alpha ? 2 : 0;
        mesh.count = 0;
        this.scene.add(mesh);
        entry = { mesh, capacity, id };
        this.flowMeshes.set(id, entry);
      }
      for (const it of list) {
        const c = it.c;
        const R = c.id === 10 ? 3 : 7;
        const h = c.id === 4 || c.fall ? 1 : 0.14 + (0.74 * (c.r + 1)) / (R + 1); // shallower further from the source
        it.mat = new THREE.Matrix4().makeScale(1, h, 1).setPosition(c.x + 0.5 - off, c.y + h / 2, c.z + 0.5 - off);
      }
      entry.items = list;
      entry.nextChange = 0;
    }
    this.flowStart = performance.now();
    this.updateFlowReveal();
    this.applyGlow();
  }

  // Show the flow cells whose turn has come and hide the ones that have drained (cells appear and
  // disappear a little at a time, like liquid spreading or running out).
  updateFlowReveal(all = false) {
    const t = (performance.now() - (this.flowStart || 0)) / 1000;
    let waiting = false;
    for (const entry of this.flowMeshes.values()) {
      const { mesh, items } = entry;
      if (!all && t < entry.nextChange) {
        waiting = true;
        continue;
      }
      let k = 0;
      let next = Infinity;
      const halo = [];
      const off = this.offset;
      for (const it of items) {
        if (all ? it.until !== Infinity : false) continue;
        const visible = all || (it.t <= t && t < it.until);
        if (visible) {
          mesh.setMatrixAt(k++, it.mat);
          if (entry.id === 10) halo.push(it.c.x + 0.5 - off, it.c.y + 0.4, it.c.z + 0.5 - off);
          if (it.until !== Infinity) next = Math.min(next, it.until);
        } else if (it.t > t) next = Math.min(next, it.t);
      }
      entry.nextChange = next;
      if (entry.id === 10) {
        this.lavaFlowPoints.geometry.dispose();
        this.lavaFlowPoints.geometry = new THREE.BufferGeometry();
        this.lavaFlowPoints.geometry.setAttribute('position', new THREE.Float32BufferAttribute(halo, 3));
        this.lavaFlowPoints.visible = halo.length > 0;
      }
      if (next !== Infinity && !all) waiting = true;
      if (mesh.count !== k || !all) {
        mesh.count = k;
        mesh.instanceMatrix.needsUpdate = true;
        this.dirty = true;
      }
    }
    this.flowWaiting = waiting;
  }

  // Replace the world (new/open): stage and meshes are resized to match.
  setWorld(world) {
    for (const { mesh } of this.typeMeshes.values()) {
      this.scene.remove(mesh);
      mesh.dispose();
    }
    this.typeMeshes.clear();
    for (const { mesh } of this.flowMeshes.values()) {
      this.scene.remove(mesh);
      mesh.dispose();
    }
    this.flowMeshes.clear();
    this.lavaFlowPoints.visible = false;
    for (const s of this.labelSprites.values()) this.scene.remove(s);
    this.labelSprites.clear();
    for (const { group } of this.personGroups.values()) {
      this.scene.remove(group);
      this.disposePerson(group);
    }
    this.personGroups.clear();
    this.world = world;
    this.buildStage();
    this.rebuildAll();
    this.rebuildLabels();
    this.rebuildPeople();
    this.setSky(world.meta.sky || 'day');
    this.resetCamera();
    this.showSymmetry(this.symMode || 'off'); // planes follow the new stand size
    world.onChange((e) => {
      if (world !== this.world) return;
      if (e.type === 'cells') this.rebuild(new Set(e.changes.flatMap((c) => [c.from, c.to])));
      else if (e.type === 'labels') this.rebuildLabels();
      else if (e.type === 'people') this.rebuildPeople();
      else if (e.type === 'fire') this.scheduleFire();
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

  // ----- people -----
  mat(hex) {
    if (!this.personMats.has(hex)) this.personMats.set(hex, new THREE.MeshLambertMaterial({ color: hex }));
    return this.personMats.get(hex);
  }

  faceTexture(skin) {
    // 8x8 pixel face: two eyes and a mouth on the skin colour
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    const ctx = c.getContext('2d');
    ctx.fillStyle = skin;
    ctx.fillRect(0, 0, 8, 8);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(1, 3, 2, 1);
    ctx.fillRect(5, 3, 2, 1);
    ctx.fillStyle = '#2b2118';
    ctx.fillRect(2, 3, 1, 1);
    ctx.fillRect(5, 3, 1, 1);
    ctx.fillStyle = 'rgba(120, 40, 40, 0.85)';
    ctx.fillRect(3, 5, 2, 1);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    return t;
  }

  // A blocky figure standing on the floor of its cell. Total height is about 1.7 cells.
  buildPerson(p) {
    const g = new THREE.Group();
    let part = g; // where new pieces go (the head pivot once we reach the head)
    let lower = 0; // height of that pivot
    const add = (w, h, d, x, y, z, hex, face) => {
      const m = new THREE.Mesh(this.geometry, face ? [this.mat(hex), this.mat(hex), this.mat(hex), this.mat(hex), face, this.mat(hex)] : this.mat(hex));
      m.scale.set(w, h, d);
      m.position.set(x, y - lower + h / 2, z);
      m.castShadow = true;
      m.receiveShadow = true;
      part.add(m);
      return m;
    };
    // legs and shoes
    for (const sx of [-0.13, 0.13]) {
      if (p.bottoms === 'pants') add(0.24, 0.7, 0.28, sx, 0, 0, p.pants);
      else if (p.bottoms === 'shorts') {
        add(0.24, 0.36, 0.28, sx, 0.34, 0, p.pants);
        add(0.24, 0.34, 0.28, sx, 0, 0, p.skin);
      } else add(0.24, 0.7, 0.28, sx, 0, 0, p.skin);
      add(0.26, 0.1, 0.36, sx, 0, 0.04, p.shoes);
    }
    if (p.bottoms === 'skirt') add(0.62, 0.34, 0.36, 0, 0.5, 0, p.pants);
    // torso and arms
    add(0.52, 0.7, 0.3, 0, 0.7, 0, p.shirt);
    for (const sx of [-0.36, 0.36]) {
      if (p.sleeves === 'long') add(0.2, 0.7, 0.26, sx, 0.7, 0, p.shirt);
      else if (p.sleeves === 'short') {
        add(0.2, 0.3, 0.26, sx, 1.1, 0, p.shirt);
        add(0.2, 0.4, 0.26, sx, 0.7, 0, p.skin);
      } else add(0.2, 0.7, 0.26, sx, 0.7, 0, p.skin);
    }
    // everything from here up turns and tilts together, around the neck
    const head = new THREE.Group();
    head.position.set(0, 1.4, 0);
    head.rotation.order = 'YXZ';
    head.rotation.y = (p.headTurn * Math.PI) / 6;
    head.rotation.x = -p.headTilt * 0.35;
    g.add(head);
    part = head;
    lower = 1.4;
    // head with a face on the front
    const face = new THREE.MeshLambertMaterial({ map: this.faceTexture(p.skin) });
    face.userData.own = true; // not shared, so it can be freed with the figure
    add(0.5, 0.5, 0.5, 0, 1.4, 0, p.skin, face);
    // hair
    if (p.hairStyle !== 'none') {
      add(0.54, 0.12, 0.54, 0, 1.84, 0, p.hair);
      add(0.54, p.hairStyle === 'long' ? 0.7 : 0.3, 0.08, 0, p.hairStyle === 'long' ? 1.2 : 1.6, -0.23, p.hair);
      if (p.hairStyle === 'long') for (const sx of [-0.26, 0.26]) add(0.06, 0.55, 0.3, sx, 1.35, -0.08, p.hair);
      else for (const sx of [-0.26, 0.26]) add(0.06, 0.22, 0.4, sx, 1.62, -0.03, p.hair);
    }
    // hats
    if (p.hat === 'cap') {
      add(0.58, 0.16, 0.58, 0, 1.86, 0, p.hatColor);
      add(0.5, 0.04, 0.26, 0, 1.86, 0.36, p.hatColor);
    } else if (p.hat === 'beanie') {
      add(0.58, 0.26, 0.58, 0, 1.86, 0, p.hatColor);
      add(0.14, 0.14, 0.14, 0, 2.12, 0, p.hatColor);
    } else if (p.hat === 'tophat') {
      add(0.84, 0.04, 0.84, 0, 1.88, 0, p.hatColor);
      add(0.46, 0.42, 0.46, 0, 1.92, 0, p.hatColor);
      add(0.48, 0.07, 0.48, 0, 1.97, 0, '#e5e7eb');
    } else if (p.hat === 'crown') {
      add(0.56, 0.14, 0.56, 0, 1.88, 0, p.hatColor);
      for (const [sx, sz] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2], [0, 0]]) add(0.1, 0.14, 0.1, sx, 2.02, sz, p.hatColor);
    }
    g.scale.setScalar(0.9);
    g.rotation.order = 'YXZ'; // lie down first, then turn around the vertical
    g.rotation.y = ((p.rot * 3 + p.twist) * Math.PI) / 6; // rot is quarter turns, twist is 30 degree steps
    const lying = p.pose !== 'standing';
    if (lying) {
      // on their back (face up) or on their front (face down); head toward the back of the cell
      g.rotation.x = p.pose === 'lyingFront' ? Math.PI / 2 : -Math.PI / 2;
      g.position.y = 0.25; // raise so they rest on the floor
      if (p.pose === 'lyingFront') g.rotation.y += Math.PI; // keep the head at the same end
    }
    const holder = new THREE.Group();
    holder.add(g);
    if (p.name) {
      const tag = this.makeLabelSprite(p.name);
      tag.scale.multiplyScalar(0.7);
      if (lying) {
        const a = ((p.rot * 3 + p.twist) * Math.PI) / 6; // head is at -z of the figure, turned by rot
        tag.position.set(-1.3 * Math.sin(a), 0.9, -1.3 * Math.cos(a));
      } else tag.position.set(0, 2.25, 0);
      holder.add(tag);
    }
    return holder;
  }

  // Free the textures a figure owns (shared colour materials are kept).
  disposePerson(group) {
    group.traverse((o) => {
      if (o.isSprite) {
        o.material.map?.dispose();
        o.material.dispose();
      } else if (o.material) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (m.userData.own) {
            m.map?.dispose();
            m.dispose();
          }
        }
      }
    });
  }

  rebuildPeople() {
    this.dirty = true;
    const alive = new Set(this.world.people.map((p) => p.id));
    for (const [id, entry] of this.personGroups) {
      if (!alive.has(id)) {
        this.scene.remove(entry.group);
        this.disposePerson(entry.group);
        this.personGroups.delete(id);
      }
    }
    const off = this.offset;
    for (const p of this.world.people) {
      const sig = JSON.stringify({ ...p, x: 0, y: 0, z: 0 });
      let entry = this.personGroups.get(p.id);
      if (!entry || entry.sig !== sig) {
        if (entry) {
          this.scene.remove(entry.group);
          this.disposePerson(entry.group);
        }
        entry = { sig, group: this.buildPerson(p) };
        entry.group.userData.personId = p.id;
        this.scene.add(entry.group);
        this.personGroups.set(p.id, entry);
      }
      entry.group.position.set(p.x + 0.5 - off, p.y, p.z + 0.5 - off);
    }
  }

  // Which way (0-3) a figure on this cell should face to look toward the camera.
  facingRot(cell) {
    const off = this.offset;
    const dx = this.camera.position.x - (cell[0] + 0.5 - off);
    const dz = this.camera.position.z - (cell[2] + 0.5 - off);
    return (((Math.round(Math.atan2(dx, dz) / (Math.PI / 2))) % 4) + 4) % 4;
  }

  // ----- looking through a person's eyes -----
  // Drag (or arrow keys) to look around; the person ends up facing the way you were looking.
  enterPerson(p) {
    const entry = this.personGroups.get(p.id);
    if (!entry || this.looking) return false;
    const off = this.offset;
    const a = ((p.rot * 3 + p.twist) * Math.PI) / 6; // the figure faces (sin a, 0, cos a)
    const lying = p.pose !== 'standing';
    const at = new THREE.Vector3(p.x + 0.5 - off, p.y + (lying ? 0.55 : 1.4), p.z + 0.5 - off);
    if (lying) at.add(new THREE.Vector3(-1.1 * Math.sin(a), 0, -1.1 * Math.cos(a))); // head end
    this.saved = { pos: this.camera.position.clone(), target: this.controls.target.clone(), fov: this.camera.fov };
    this.looking = { id: p.id, lying, yaw: a + (lying ? 0 : (p.headTurn * Math.PI) / 6) + Math.PI, pitch: lying ? -1.1 : -p.headTilt * 0.35, group: entry.group };
    entry.group.visible = false; // do not look at the inside of their own head
    this.controls.enabled = false;
    this.camera.fov = 70;
    this.camera.updateProjectionMatrix();
    this.camera.rotation.order = 'YXZ';
    this.camera.position.copy(at);
    this.applyLook();
    const L = this.looking;
    L.down = (e) => {
      L.drag = { x: e.clientX, y: e.clientY };
      this.canvas.setPointerCapture?.(e.pointerId);
    };
    L.move = (e) => {
      if (!L.drag) return;
      L.yaw += (e.clientX - L.drag.x) * 0.006;
      L.pitch += (e.clientY - L.drag.y) * 0.006;
      L.drag = { x: e.clientX, y: e.clientY };
      this.applyLook();
    };
    L.up = () => (L.drag = null);
    L.key = (e) => {
      const step = 0.12;
      if (e.key === 'ArrowLeft') L.yaw += step;
      else if (e.key === 'ArrowRight') L.yaw -= step;
      else if (e.key === 'ArrowUp') L.pitch -= step;
      else if (e.key === 'ArrowDown') L.pitch += step;
      else return;
      e.preventDefault();
      this.applyLook();
    };
    this.canvas.addEventListener('pointerdown', L.down);
    this.canvas.addEventListener('pointermove', L.move);
    this.canvas.addEventListener('pointerup', L.up);
    this.canvas.addEventListener('pointercancel', L.up);
    window.addEventListener('keydown', L.key);
    return true;
  }

  applyLook() {
    const L = this.looking;
    L.pitch = Math.max(-1.4, Math.min(1.4, L.pitch));
    this.camera.rotation.set(-L.pitch, L.yaw, 0);
    this.dirty = true;
  }

  // Leave the person's eyes; returns { id, rot } with the way they were looking (0-3).
  exitPerson() {
    const L = this.looking;
    if (!L) return null;
    this.canvas.removeEventListener('pointerdown', L.down);
    this.canvas.removeEventListener('pointermove', L.move);
    this.canvas.removeEventListener('pointerup', L.up);
    this.canvas.removeEventListener('pointercancel', L.up);
    window.removeEventListener('keydown', L.key);
    L.group.visible = true;
    this.looking = null;
    this.camera.rotation.order = 'XYZ';
    this.camera.fov = this.saved.fov;
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(this.saved.pos);
    this.controls.target.copy(this.saved.target);
    this.controls.enabled = true;
    this.controls.update();
    this.dirty = true;
    const turn = L.yaw - Math.PI; // the way they now look, as an angle
    const rot = ((Math.round(turn / (Math.PI / 2)) % 4) + 4) % 4;
    if (L.lying) return { id: L.id, rot, twist: 0 }; // lying down: only the body direction follows the view
    // whatever is left over (up to 45 degrees) turns the head, and looking up/down tilts it
    const rest = turn - Math.round(turn / (Math.PI / 2)) * (Math.PI / 2);
    return { id: L.id, rot, twist: 0, headTurn: Math.round(rest / (Math.PI / 6)), headTilt: -Math.round(L.pitch / 0.35) };
  }

  // id of the person under the pointer, or null
  personAt(ray) {
    const roots = [...this.personGroups.values()].map((e) => e.group);
    const hits = ray.raycaster.intersectObjects(roots, true);
    for (const h of hits) {
      let o = h.object;
      while (o && o.userData.personId === undefined) o = o.parent;
      if (o) return o.userData.personId;
    }
    return null;
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

  // mode: 'off' | 'x' | 'z' | 'xz' - draws the mirror plane(s) through the middle of the stand
  showSymmetry(mode) {
    this.symMode = mode;
    this.dirty = true;
    const size = this.world.size;
    const tall = 14;
    this.planeX.visible = mode === 'x' || mode === 'xz';
    this.planeZ.visible = mode === 'z' || mode === 'xz';
    this.planeX.scale.set(size, tall, 1);
    this.planeX.position.set(0, tall / 2, 0);
    this.planeZ.scale.set(size, tall, 1);
    this.planeZ.position.set(0, tall / 2, 0);
  }

  // Preview of the mirrored copies of the cell under the pointer.
  showMirrorGhosts(cells, { color = 0xffffff, opacity = 0.35, scale = 1.002 } = {}) {
    this.dirty = true;
    const off = this.offset;
    while (this.mirrorGhosts.length < cells.length) {
      const g = new THREE.Mesh(this.geometry, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
      g.add(new THREE.LineSegments(new THREE.EdgesGeometry(this.geometry), new THREE.LineBasicMaterial({ color: 0x000000 })));
      g.renderOrder = 5;
      this.helpers.add(g);
      this.mirrorGhosts.push(g);
    }
    this.mirrorGhosts.forEach((g, i) => {
      const c = cells[i];
      g.visible = !!c;
      if (!c) return;
      g.position.set(c[0] + 0.5 - off, c[1] + 0.5, c[2] + 0.5 - off);
      g.scale.setScalar(scale);
      g.material.color.set(color);
      g.material.opacity = opacity;
    });
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

  showSelection(a, b) {
    this.dirty = true;
    if (!a || !b) {
      this.selection.visible = false;
      return;
    }
    const off = this.offset;
    const lo = [0, 1, 2].map((i) => Math.min(a[i], b[i]));
    const hi = [0, 1, 2].map((i) => Math.max(a[i], b[i]) + 1);
    this.selection.scale.set(hi[0] - lo[0] + 0.03, hi[1] - lo[1] + 0.03, hi[2] - lo[2] + 0.03);
    this.selection.position.set((lo[0] + hi[0]) / 2 - off, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2 - off);
    this.selection.visible = true;
  }

  // Where a pasted clip (w x h x d) would land with its corner at `origin`; ok=false turns it red.
  showFootprint(size, origin, ok) {
    this.dirty = true;
    if (!size || !origin) {
      this.footprint.visible = false;
      return;
    }
    const off = this.offset;
    const [w, h, d] = size;
    this.footprint.position.set(origin[0] + w / 2 - off, origin[1] + h / 2, origin[2] + d / 2 - off);
    this.footprintEdges.scale.set(w + 0.02, h + 0.02, d + 0.02);
    this.footprintBody.scale.set(w, h, d);
    this.footprintPlate.scale.set(w, d, 1);
    this.footprintPlate.position.set(0, -h / 2 + 0.04, 0);
    const color = ok ? 0x34d399 : 0xff5c5c;
    this.footprintBody.material.color.set(color);
    this.footprintPlate.material.color.set(color);
    this.footprintEdges.material.color.set(ok ? 0xffffff : 0xff8a8a);
    this.footprint.visible = true;
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
    if (this.flowWaiting) this.updateFlowReveal();
    if (this.fireCount) {
      const frame = Math.floor(performance.now() / 120) % 4; // flames flicker
      if (frame !== this.fireFrame) {
        this.fireFrame = frame;
        this.fireTexture.offset.y = frame * 0.25;
        this.dirty = true;
      }
    }
    const moved = this.looking ? false : this.controls.update(); // the camera is driven by the person view while looking
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
    this.updateFlowReveal(true);
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
