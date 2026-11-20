// The hangar: assemble a plane from parts.
import * as THREE from 'three';
import { OrbitControls } from '../vendor/addons/OrbitControls.js';
import { RoomEnvironment } from '../vendor/addons/RoomEnvironment.js';
import { PARTS, CATEGORIES, PAINTS, partInfo } from './parts.js';
import { isRocketDesign, analyze, partMatrix, partScale, sizeAxes, mirroredOf, newPart, subtree, removeParts, cloneDesign, SYM_MODES, symAxis, symMakers, offAxis, sameSpot } from './design.js';
import { assemble, ControlPreview } from './planeDetail.js';
import { HangarEnv, HW, HD, EAVE } from './hangarEnv.js';
import { M } from './materials.js';
import { Bag, bar } from './partDetail.js';
import { bikeStand } from './bikeParts.js';

// the hour the flight settings will fly at: the hangar's daylight follows it
const flightHour = () => { try { const t = JSON.parse(localStorage.getItem('skywright.flight'))?.time; return Number.isFinite(t) ? t : 10; } catch { return 10; } };

const ghostMat = new THREE.MeshBasicMaterial({ color: 0x4fc3ff, transparent: true, opacity: 0.45, depthWrite: false });

export class Hangar {
  constructor(renderer, ui, audio) {
    this.renderer = renderer; this.ui = ui; this.audio = audio;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
    this.camera.position.set(14, 7, 16);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true; this.controls.maxPolarAngle = Math.PI * 0.97; // can swing under the plane: the floor is one-sided, so it vanishes from below
    this.controls.minDistance = 3; this.controls.maxDistance = 150; // (fitted to the vehicle on every rebuild: fitOrbit)
    this.sphere = new THREE.Sphere(new THREE.Vector3(0, 1.5, 0), 4);
    this.controls.enabled = false;
    this.symMode = 2; this.showBalance = true; // symmetry: 0 off, 2 mirror, 3 / 4 round the long axis (SYM_MODES)
    this.design = { name: 'My Vehicle', parts: [] };
    this.undoStack = []; this.redoStack = [];
    this.sel = -1; this.placing = null; this.ghost = null;
    this.buildEnv();
    this.designGroup = new THREE.Group(); this.scene.add(this.designGroup);
    this.markers = this.buildMarkers();
    this.selBox = new THREE.BoxHelper(undefined, 0xffd400); this.selBox.visible = false; this.scene.add(this.selBox);
    this.raycaster = new THREE.Raycaster();
    this.bindPointer();
    this.onChange = () => {};
    this.preview = new ControlPreview(); // control check: arrows/WASD, Q/E, F
  }

  // The building, props, lighting and the view outside live in hangarEnv.js; the plane is the only thing you can pick.
  buildEnv() {
    const env = new HangarEnv(this.renderer, this.scene); this.env = env;
    env.viewCamera = this.camera;
    env.onChange = () => { this.envDirty = true; this.shadowsDirty(); this.needsRender = true; };
    env.setupReflection(() => [this.markers, this.selBox, this.ghost].filter(Boolean));
    this.key = env.sun;
    env.setHour(flightHour());
    this.envDirty = true;
  }
  shadowsDirty() { if (!this.env) return; this.env.sun.shadow.needsUpdate = true; this.env.key.shadow.needsUpdate = true; }
  bakeEnv() { this.env.bakeEnvironment([this.designGroup, this.markers, this.selBox, this.ghost].filter(Boolean)); this.renderer.compile(this.scene, this.camera); this.envDirty = false; this.shadowsDirty(); this.needsRender = true; } // compile: no shader hitches when props come into view // (the bake drew the shadow maps without the plane)

  buildMarkers() {
    const g = new THREE.Group();
    const mk = (color) => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.28, 20, 14), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 })); m.renderOrder = 10; g.add(m); return m; };
    this.comM = mk(0xffd400); this.colM = mk(0x3ab0ff);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.05, 8, 24), new THREE.MeshBasicMaterial({ color: 0x111111, depthTest: false })); ring.renderOrder = 11; this.comM.add(ring);
    this.thrustArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(), 3, 0xff5a36, 0.6, 0.35);
    this.thrustArrow.traverse((o) => { if (o.material) { o.material.depthTest = false; o.renderOrder = 10; } });
    g.add(this.thrustArrow);
    this.scene.add(g);
    return g;
  }

  activate(on) {
    this.controls.enabled = on; this.needsRender = true; this.preview.enabled = on;
    const cv = this.renderer.domElement;
    if (on) {
      // back from a flight: re-upload the hangar a few textures per frame behind a hidden canvas, then fade it in
      if (this.env.beginRestore()) { cv.style.transition = 'none'; cv.style.opacity = '0'; }
      if (this.env.setHour(flightHour())) this.envDirty = true;
      this.rebuild();
    } else {
      cv.style.transition = 'none'; cv.style.opacity = ''; // the flight shares the canvas
      this.env.release(); // none of the hangar's GPU memory stays around during the flight
    }
  }

  // ---------- design editing ----------
  pushUndo() { this.undoStack.push(JSON.stringify(this.design)); if (this.undoStack.length > 80) this.undoStack.shift(); this.redoStack = []; }
  undo() { if (!this.undoStack.length) return; this.redoStack.push(JSON.stringify(this.design)); this.design = JSON.parse(this.undoStack.pop()); this.sel = -1; this.rebuild(); }
  redo() { if (!this.redoStack.length) return; this.undoStack.push(JSON.stringify(this.design)); this.design = JSON.parse(this.redoStack.pop()); this.sel = -1; this.rebuild(); }
  load(design, frame = true) { this.design = cloneDesign(design); this.sel = -1; this.undoStack = []; this.redoStack = []; this.rebuild(); if (frame) this.frame(); this.preview.playCheck(); }

  get symmetry() { return this.symMode > 0; }
  set symmetry(on) { this.symMode = on ? this.symMode || 2 : 0; }
  setSymmetry(n) { if (SYM_MODES.includes(n)) this.symMode = n; }
  // The symmetric set the part belongs to: [{ j, make }] for each copy j, make(edited original) = the copy's new part.
  // Tries the selected symmetry first, then the others, and takes the first whose copies are all there, so editing an
  // existing set moves all of it (a pair of wings stays a pair while 4-way is selected for some new fins); with
  // symmetry off a part is on its own. Mirror pairs are found the way they always were (partner()).
  symGroup(i) {
    const parts = this.design.parts, p = parts[i]; if (!p || !this.symMode) return [];
    const axis = symAxis(this.design), out = {};
    for (const n of [this.symMode, ...[4, 3, 2].filter((m) => m !== this.symMode)]) {
      if (n === 2) { const j = this.partner(i); out[n] = j >= 0 ? [{ j, make: (q) => mirroredOf(q) }] : []; }
      else if (offAxis(p, n, axis) < 0.12) out[n] = [];
      else out[n] = symMakers(n, axis).map((make) => ({ j: parts.findIndex((q, j) => j !== i && sameSpot(make(p), q)), make })).filter((c) => c.j >= 0);
      if (out[n].length === n - 1) return out[n];
    }
    return out[this.symMode];
  }
  partner(i) {
    // centreline-rooted pairs (wings/tailplanes mounted at x=0) count too: the mirror flag tells the twins apart
    const p = this.design.parts[i]; if (!p) return -1;
    return this.design.parts.findIndex((q, j) => j !== i && q.id === p.id && q.mirror !== p.mirror && Math.abs(q.pos[0] + p.pos[0]) < 0.02 && Math.abs(q.pos[1] - p.pos[1]) < 0.02 && Math.abs(q.pos[2] - p.pos[2]) < 0.02);
  }
  edit(fn, undo = true) {
    if (this.sel < 0) return;
    if (undo) this.pushUndo();
    const i = this.sel, parts = this.design.parts, grp = this.symGroup(i);
    fn(parts[i]);
    for (const { j, make } of grp) { const m = make(parts[i]); m.parent = parts[j].parent; m.color = parts[i].color; parts[j] = m; }
    this.rebuild();
  }
  // Fine placement. Move/rotate take absolute values so the inspector can drive them with sliders;
  // pass undo=false for follow-up steps of one slider drag or button hold.
  setPos(axis, v, undo = true) { this.edit((p) => { p.pos[axis] = +v.toFixed(3); }, undo); }
  // Line the selected part up with its parent part or the whole vehicle: axis 0 = side to side, 1 = up and down, as
  // shown (display frame: a standing rocket's up is along it). Puts the middle of the part's box on the middle of the
  // target's box; the symmetry copies follow. A mirrored / radial set moved onto the axis it is copied about becomes
  // one part (its copies would sit inside it).
  alignSel(axis, to = 'parent') {
    const i = this.sel, parts = this.design.parts, p = parts[i]; if (!p) return false;
    // a part's own shape (not the dressing the assembly adds round it) as a box in the display frame
    const R = new THREE.Matrix4().makeRotationFromQuaternion(this.displayQuat()), m = new THREE.Matrix4(), c = new THREE.Vector3();
    const boxOf = (k, box = new THREE.Box3()) => { const q = parts[k], b = partInfo(q.id).box; partMatrix(q, m).premultiply(R);
      for (let n = 0; n < 8; n++) box.expandByPoint(c.set(n & 1 ? b.max.x : b.min.x, n & 2 ? b.max.y : b.min.y, n & 4 ? b.max.z : b.min.z).applyMatrix4(m)); return box; };
    const tb = new THREE.Box3();
    if (to === 'parent' && p.parent >= 0) boxOf(p.parent, tb); else parts.forEach((_, k) => boxOf(k, tb));
    const a = boxOf(i).getCenter(new THREE.Vector3()), b = tb.getCenter(new THREE.Vector3());
    const d = new THREE.Vector3(); d.setComponent(axis, b.getComponent(axis) - a.getComponent(axis));
    if (d.length() < 0.002) return false;
    const dd = this.toDesign(d), grp = this.symGroup(i);
    this.pushUndo();
    this.edit((q) => { q.pos = q.pos.map((v, n) => +(v + dd.getComponent(n)).toFixed(3)); }, false);
    if (grp.length) { // a mirrored / radial set moved onto the axis it is copied about would sit inside itself: keep one
      const n = grp.length + 1, ax = symAxis(this.design), mid = this.toDesign(boxOf(i).getCenter(new THREE.Vector3()));
      if ((n === 2 ? Math.abs(mid.x) : Math.hypot(mid.x - ax[0], mid.y - ax[1])) < 0.05) {
        let idxs = []; for (const { j } of grp) idxs = idxs.concat(subtree(this.design.parts, j));
        const keep = this.design.parts[i]; removeParts(this.design, [...new Set(idxs)]); this.sel = this.design.parts.indexOf(keep); this.rebuild();
      }
    }
    return true;
  }
  setPosVec(pos, undo = true) { this.edit((p) => { p.pos = pos.map((v) => +v.toFixed(3)); }, undo); }
  // The way the vehicle is shown (a vertical launcher stands nose-up): the design group's rotation. The Move and Turn
  // pads work in this display frame, so Up is up on screen whatever way the vehicle stands; positions stay stored in
  // the design frame (saved designs don't change).
  displayQuat() { return this.designGroup.quaternion.clone(); }
  toDesign(v) { return v.clone().applyQuaternion(this.displayQuat().invert()); } // a display-frame direction in the design frame
  toDisplay(v) { return v.clone().applyQuaternion(this.displayQuat()); }
  // Rotation as yaw/pitch/roll Euler degrees (order YXZ: yaw about Y, then pitch about X, then roll about Z).
  euler() {
    const p = this.design.parts[this.sel]; if (!p) return [0, 0, 0];
    const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...p.quat), 'YXZ');
    return [e.x, e.y, e.z].map((r) => +THREE.MathUtils.radToDeg(r).toFixed(1));
  }
  setEuler(deg, undo = true) {
    this.edit((p) => {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...deg.map((d) => THREE.MathUtils.degToRad(d)), 'YXZ'));
      p.quat = [q.x, q.y, q.z, q.w];
    }, undo);
  }
  // Turn a part about the plane's own axes (0 = pitch about X, 1 = yaw about Y, 2 = roll about Z), starting from
  // a saved quaternion so a held button can apply its running total without drift or gimbal lock.
  rotateFrom(baseQuat, axis, deg, undo = true) {
    this.edit((p) => {
      const ax = this.toDesign(new THREE.Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0)); // (display axes)
      const q = new THREE.Quaternion().setFromAxisAngle(ax, THREE.MathUtils.degToRad(deg)).multiply(new THREE.Quaternion(...baseQuat));
      p.quat = [q.x, q.y, q.z, q.w];
    }, undo);
  }
  resetRotation() { this.edit((p) => { p.quat = [0, 0, 0, 1]; }); }
  // Part sizing. axis is a sizeSliders() key (len/dia/span/chord/size). Pass undo=false for follow-up steps of one slider drag.
  // Engine tuning (power multiplier, rocket burn seconds); a value equal to stock is stored as absent.
  setTune(key, v, stock, undo = true) { this.edit((p) => { if (Math.abs(v - stock) < 1e-6) delete p[key]; else p[key] = +v.toFixed(2); }, undo); }
  resizePart(axis, v, undo = true) {
    if (this.sel < 0) return;
    if (undo) this.pushUndo();
    for (const k of [this.sel, ...this.symGroup(this.sel).map((c) => c.j)]) this.scalePart(k, axis, v);
    this.rebuild();
  }
  scalePart(i, axis, v) {
    const parts = this.design.parts, p = parts[i];
    const oldM = partMatrix(p), s = [...partScale(p)];
    for (const k of sizeAxes(p.id, axis)) s[k] = v;
    if (s.every((x) => Math.abs(x - 1) < 1e-6)) delete p.scale; else p.scale = s;
    // attached parts ride the surface: map each direct child's origin through old->new body scale, carry its subtree along rigidly
    const toNew = partMatrix(p).multiply(oldM.invert()), a = new THREE.Vector3(), b = new THREE.Vector3();
    parts.forEach((c, ci) => {
      if (c.parent !== i || ci === i) return;
      a.fromArray(c.pos); b.copy(a).applyMatrix4(toNew).sub(a);
      for (const k of subtree(parts, ci)) if (k !== i) parts[k].pos = parts[k].pos.map((x, n) => +(x + b.getComponent(n)).toFixed(4));
    });
  }
  flip() { this.edit((p) => { p.mirror = !p.mirror; }); }
  paint(color) { this.edit((p) => { p.color = color; }); this.audio.play('paint'); }
  deleteSel() {
    if (this.sel < 0) return;
    this.pushUndo();
    let idxs = subtree(this.design.parts, this.sel);
    for (const { j } of this.symGroup(this.sel)) idxs = idxs.concat(subtree(this.design.parts, j));
    if (this.sel === 0) idxs = this.design.parts.map((_, k) => k);
    removeParts(this.design, [...new Set(idxs)]);
    this.sel = -1; this.rebuild(); this.audio.play('remove');
  }
  clear() { this.pushUndo(); this.design.parts = []; this.sel = -1; this.rebuild(); }

  startPlacing(id) {
    this.placing = id; this.sel = -1;
    if (this.ghost) { this.scene.remove(this.ghost); this.ghost = null; }
    const g = PARTS[id].build(PARTS[id].color);
    g.traverse((o) => { if (o.isMesh) { o.material = ghostMat; o.castShadow = false; } });
    g.visible = false; this.ghost = g; this.scene.add(g);
    if (!this.design.parts.length) { this.place(null); }
    this.onChange();
  }
  cancelPlacing() { this.placing = null; if (this.ghost) { this.scene.remove(this.ghost); this.ghost = null; } this.onChange(); }

  // compute placement transform for current part at a hit
  placement(hit) {
    const id = this.placing;
    if (!hit) return newPart(id, [0, 0, 0]);
    const p = this.designGroup.worldToLocal(hit.point.clone());
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).transformDirection(this.designGroup.matrixWorld.clone().invert()); // in design space (an upright rocket stands turned)
    return placePart(id, p, n);
  }
  place(hit) {
    const id = this.placing; if (!id) return;
    this.pushUndo();
    const part = this.placement(hit);
    const parentIdx = hit ? this.partIndexOf(hit.object) : -1;
    part.parent = this.design.parts.length ? Math.max(0, parentIdx) : -1;
    this.design.parts.push(part);
    const i = this.design.parts.length - 1;
    this.addCopies(i, this.symMode);
    this.cancelPlacing();
    this.sel = i;
    this.rebuild();
    this.audio.play('place');
    if (this.design.parts.length === 1) this.frame();
  }
  // Add the symmetry copies of part i for symmetry n (2 mirror, 3 / 4 round the long axis). Everything attached to the
  // part (its ailerons, lights, fins on a booster) is copied with it.
  addCopies(i, n) {
    const parts = this.design.parts, part = parts[i], axis = symAxis(this.design), sub = subtree(parts, i);
    let makers = [];
    // (wings and tailplanes are rooted on the centreline: their twin is told apart by the mirror flag)
    if (n === 2 && (Math.abs(part.pos[0]) > 0.12 || (PARTS[part.id]?.attach === 'wing' && this.partner(i) < 0))) makers = [(q) => mirroredOf(q)];
    else if (n > 2 && offAxis(part, n, axis) > 0.12) makers = symMakers(n, axis);
    const par = parts[part.parent];
    for (const make of makers) {
      // the copy hangs on the matching copy of the parent when there is one (a wing's twin on its mirrored pod, fins on
      // a set of boosters), else on the same parent (fins on the core)
      const pc = par && make(par), pj = pc ? parts.findIndex((q) => sameSpot(pc, q)) : n === 2 && part.parent >= 0 ? this.partner(part.parent) : -1;
      const map = new Map();
      for (const k of sub) {
        const m = make(parts[k]);
        m.parent = k === i ? (pj >= 0 ? pj : part.parent) : map.get(parts[k].parent);
        map.set(k, parts.length); parts.push(m);
      }
    }
  }
  // 3- and 4-way symmetry only make sense round a rocket; anything else falls back to the mirror.
  symAllowed(n) { return n <= 2 || isRocketDesign(this.design); }
  // Pick a symmetry. With a part selected it also changes that part's set to the new rule: its current copies (a mirror
  // twin, or 3 / 4 round the body) go and the new ones are added. The part itself stays where it is.
  applySymmetry(n) {
    if (!SYM_MODES.includes(n) || !this.symAllowed(n)) return;
    this.symMode = n;
    let i = this.sel; if (i < 0 || !this.design.parts[i]) return;
    this.pushUndo();
    const cur = this.symMode; this.symMode = 4; const grp = this.symGroup(i); this.symMode = cur; // whatever set it is in now
    const drop = new Set(); for (const { j } of grp) for (const k of subtree(this.design.parts, j)) if (k !== i) drop.add(k);
    const before = this.design.parts[i];
    removeParts(this.design, [...drop]);
    i = this.design.parts.indexOf(this.design.parts.find((p) => p.id === before.id && sameSpot(p, before)));
    if (i < 0) { this.rebuild(); return; }
    if (n) this.addCopies(i, n);
    this.sel = i;
    this.rebuild();
  }
  partIndexOf(obj) { let o = obj; while (o && o.userData.partIndex === undefined) o = o.parent; return o ? o.userData.partIndex : -1; }

  // ---------- rendering the design ----------
  // Back-to-back rebuilds (a size/position slider being dragged) get a coarse skin blend and no small fittings; the full
  // build follows a moment after the last one.
  rebuild({ full = false } = {}) {
    const now = performance.now(), quick = !full && now - (this.lastRebuild || -1e9) < 140; this.lastRebuild = now;
    clearTimeout(this.fullT); if (quick) this.fullT = setTimeout(() => { this.lastRebuild = -1e9; this.rebuild({ full: true }); }, 200);
    this.designGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); o.skeleton?.dispose(); }); // (skeleton: the crew's bone texture)
    this.designGroup.clear();
    const t0 = performance.now(), objs = buildDesign(this.design, this.designGroup, { quick, near: !quick }).parts; this.rebuildMs = performance.now() - t0; this.rebuildQuick = quick;
    // rest on the floor: lowest point at y=0 (gear touching); a vertical launcher stands on its tail on a launch stand
    this.stats = analyze(this.design);
    if (this.stand) { this.scene.remove(this.stand); this.stand.traverse((o) => o.geometry?.dispose()); this.stand = null; }
    const up = uprightStage(this.design, this.designGroup, this.stats);
    if (up) { this.designGroup.position.y = up.y; this.stand = up.stand; this.scene.add(this.stand); }
    else {
      const box = new THREE.Box3().setFromObject(this.designGroup);
      this.designGroup.position.y = box.isEmpty() ? 2 : -box.min.y + 0.02;
    }
    this.designGroup.updateMatrixWorld(true);
    this.shadowsDirty(); // shadows are only redrawn when something changed
    const vbox = new THREE.Box3().setFromObject(this.designGroup); if (this.stand) vbox.expandByObject(this.stand);
    this.env.setPlaneFootprint(vbox);
    this.fitOrbit(vbox);
    this.preview.attach(this.design, objs, this.stats.com);
    // markers
    const show = this.showBalance && this.design.parts.length > 0;
    this.markers.visible = show;
    if (show) {
      this.comM.position.copy(this.stats.com).applyMatrix4(this.designGroup.matrixWorld);
      this.colM.position.copy(this.stats.col).applyMatrix4(this.designGroup.matrixWorld); this.colM.visible = this.stats.wingArea > 0.5;
      this.thrustArrow.setDirection(new THREE.Vector3(0, 0, -1).transformDirection(this.designGroup.matrixWorld));
      this.thrustArrow.visible = this.stats.thrust > 0;
      this.thrustArrow.position.copy(this.comM.position);
      this.thrustArrow.setLength(1.5 + Math.min(6, this.stats.tw * 4), 0.6, 0.35);
    }
    this.updateSelection();
    this.onChange();
  }
  updateSelection() {
    this.needsRender = true;
    const o = this.designGroup.children.find((c) => c.userData.partIndex === this.sel);
    if (o) { this.selBox.setFromObject(o); this.selBox.visible = true; } else this.selBox.visible = false;
  }
  // The orbit fits the vehicle's bounding sphere: the camera can't be zoomed in through big planes (it stops a little
  // way inside the sphere, about where the skin is), can't be zoomed out past where the whole vehicle is a small thing
  // in the middle, and the near plane follows the camera's distance to the sphere (close to it: fine detail without
  // clipping; far from it: better depth precision).
  fitOrbit(box) {
    if (box.isEmpty()) return;
    box.getBoundingSphere(this.sphere);
    const R = this.sphere.radius, c = this.controls;
    c.minDistance = Math.max(1.2, R * 0.55); c.maxDistance = Math.max(30, this.fitDistance() * 2.5);
    this.updateNear(true);
  }
  fitDistance() { // camera distance at which the bounding sphere just fills the narrower field of view
    const cam = this.camera, v = THREE.MathUtils.degToRad(cam.fov), h = 2 * Math.atan(Math.tan(v / 2) * cam.aspect);
    return this.sphere.radius / Math.sin(Math.min(v, h) / 2) * 1.04;
  }
  updateNear(force = false) {
    const cam = this.camera, d = cam.position.distanceTo(this.sphere.center), R = this.sphere.radius;
    const near = THREE.MathUtils.clamp((d - R) * 0.35, 0.05, 1.5);
    if (force || Math.abs(near - cam.near) > cam.near * 0.08) { cam.near = near; cam.updateProjectionMatrix(); return true; }
    return false;
  }
  frame() {
    const box = new THREE.Box3().setFromObject(this.designGroup); if (this.stand) box.expandByObject(this.stand);
    if (box.isEmpty()) { this.controls.target.set(0, 1.5, 0); return; }
    this.fitOrbit(box);
    this.controls.target.copy(this.sphere.center);
    // the usual 3/4 view from above; a vehicle too big to fit from there inside the hangar is framed from lower down,
    // so the camera isn't pushed up into the roof trusses and lamps by the walls
    // (the box's sphere is generous, so 85 % of its fit distance still shows the whole vehicle)
    const want = Math.max(8, this.fitDistance() * 0.85), c = this.sphere.center, room = (d) => { // how far the camera can go along d
      let t = Infinity; const lim = [HW - 3, EAVE - 3, HD - 3];
      for (let k = 0; k < 3; k++) { const o = c.getComponent(k), v = d.getComponent(k); if (Math.abs(v) < 1e-6) continue; t = Math.min(t, ((v > 0 ? lim[k] : k === 1 ? 0.5 : -lim[k]) - o) / v); }
      const q = c.clone().addScaledVector(d, Math.min(t, want)); if (q.x > 15 && q.z > 24) t = Math.min(t, 0); // not in the office block
      return t; };
    let dir = null, best = -1;
    search: for (const sx of [0.75, -0.75]) for (const e of [0.45, 0.32, 0.22, 0.14]) { const d = new THREE.Vector3(sx, e, 0.85).normalize(), t = room(d); if (t >= want) { dir = d; break search; } if (t > best) { best = t; dir = d; } }
    this.camera.position.copy(c).addScaledVector(dir, Math.min(want, Math.max(room(dir), 1)));
    this.controls.update(); this.updateNear(true);
  }

  // ---------- pointer ----------
  bindPointer() {
    const el = this.renderer.domElement;
    let down = null;
    const ndc = (e) => { const r = el.getBoundingClientRect(); return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); };
    el.addEventListener('pointerdown', (e) => { if (!this.controls.enabled) return; down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    el.addEventListener('pointermove', (e) => {
      if (!this.controls.enabled || !this.placing || !this.ghost) return;
      const hit = this.pick(ndc(e));
      if (hit) {
        const part = this.placement(hit); const m = partMatrix(part, new THREE.Matrix4());
        m.premultiply(this.designGroup.matrixWorld); m.decompose(this.ghost.position, this.ghost.quaternion, this.ghost.scale);
        this.ghost.visible = true;
      } else this.ghost.visible = false;
    });
    el.addEventListener('pointerup', (e) => {
      if (!this.controls.enabled || !down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = performance.now() - down.t; down = null;
      if (moved > 8 || dt > 600) return;
      const hit = this.pick(ndc(e));
      if (this.placing) { if (hit) this.place(hit); else this.ui.hint('Tap on your vehicle to attach the part'); return; }
      this.sel = hit ? this.partIndexOf(hit.object) : -1;
      this.updateSelection(); this.onChange();
      if (this.sel >= 0) this.audio.play('select');
    });
  }
  pick(v) {
    this.raycaster.setFromCamera(v, this.camera);
    const hits = this.raycaster.intersectObject(this.designGroup, true).filter((h) => h.object.visible && !h.object.userData.isDisc && h.face);
    return hits[0] || null;
  }
  // Returns true when the view changed and needs drawing (the hangar only renders on demand).
  update(dt) {
    if (this.env.restoring) {
      if (!this.env.restoreStep()) return false;
      const cv = this.renderer.domElement; requestAnimationFrame(() => { cv.style.transition = 'opacity 0.25s'; cv.style.opacity = ''; });
      this.shadowsDirty(); this.needsRender = true;
    }
    if (this.controls.update()) this.needsRender = true;
    if (this.preview.update(dt)) this.needsRender = true;
    if (this.env.clampCamera(this.camera, this.controls.target)) this.needsRender = true; // walls, office block
    if (this.updateNear()) this.needsRender = true;
    if (this.envDirty && !this.env.loading && this.env.tier) this.bakeEnv();
    if (this.env.animating) { this.env.update(dt); this.needsRender = true; } // Ultra: dust in the sunbeams
    if (this.selBox.visible) this.updateSelection();
    if (this.placing && this.ghost) { ghostMat.opacity = 0.35 + Math.sin(performance.now() / 200) * 0.15; this.needsRender = true; }
    const r = this.needsRender; this.needsRender = false; return r;
  }
  setQuality(tier) { this.env.setTier(tier); this.envDirty = true; this.needsRender = true; }
  resize(w, h) { this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.controls.maxDistance = Math.max(30, this.fitDistance() * 2.5); this.needsRender = true; }
  render() { this.renderer.render(this.scene, this.camera); }
}

// A part placed where a tap's ray met the vehicle: p, n (the surface point and its normal, design space). Wings and fins
// go 4 cm into the surface, gear 5 cm, anything else rests on it by its box (sunk 10 %), all snapped to 5 cm and centred
// within 15 cm of the middle. The box is the part's solid one: a jet's or rocket's exhaust flame and a prop disc count
// for nothing (with them a jet tapped onto a nose sat metres off it in mid-air). Placement only: physics reads partInfo.
const _solid = new Map();
function solidBox(id) {
  if (!_solid.has(id)) { const b = new THREE.Box3().setFromPoints(partInfo(id).hull); _solid.set(id, { center: b.getCenter(new THREE.Vector3()), size: b.getSize(new THREE.Vector3()) }); }
  return _solid.get(id);
}
export function placePart(id, p, n) {
  const att = PARTS[id].attach;
  let pos, mirror = false, rot = null;
  if (att === 'wing') {
    pos = p.clone().addScaledVector(n, -0.04);
    mirror = n.x < -0.3 || (Math.abs(n.x) <= 0.3 && p.x < -0.1);
  } else if (att === 'fin') {
    pos = p.clone().addScaledVector(n, -0.04);
    // stood square to the skin round the body, in 45° steps (top 0°, an X tail 45°, sides ±90°, underneath 180°)
    if (Math.hypot(n.x, n.y) > 0.5) { const a = Math.round(THREE.MathUtils.radToDeg(Math.atan2(-n.x, n.y)) / 45) * 45; if (a) rot = [0, 0, a]; }
  } else if (att === 'gear') {
    pos = p.clone().addScaledVector(n, -0.05);
  } else {
    const { center: c, size } = solidBox(id), h = size.clone().multiplyScalar(0.5);
    const ext = Math.abs(n.x) * h.x + Math.abs(n.y) * h.y + Math.abs(n.z) * h.z;
    pos = p.clone().addScaledVector(n, ext * 0.9).sub(c);
  }
  const snap = (v) => Math.round(v * 20) / 20;
  pos.set(Math.abs(pos.x) < 0.15 ? 0 : snap(pos.x), snap(pos.y), snap(pos.z));
  return newPart(id, pos.toArray(), { mirror, rot: rot || undefined });
}

// Build a design's parts under `root` and join them up (planeDetail.js): what the hangar shows, also used for the
// vehicle pictures in the Vehicles menu (thumbs.js). The caller disposes the geometries when done.
export function buildDesign(design, root, { quick = false, near = true } = {}) {
  const m = new THREE.Matrix4(), objs = [];
  design.parts.forEach((p, i) => {
    const d = PARTS[p.id]; if (!d) return;
    const o = d.build(p.color, { detail: 2 }); partMatrix(p, m); m.decompose(o.position, o.quaternion, o.scale); objs[i] = o;
    o.userData.partIndex = i;
    o.traverse((c) => { if (c.isMesh) { c.castShadow = !c.material.transparent; c.receiveShadow = true; } if (c.userData.isDisc) c.visible = false; });
    root.add(o);
  });
  return assemble(design, objs, root, { quick, near });
}

// A vertical launcher (a rocket with no main wing: analyze().vertical) is shown standing on its tail, the way it
// launches, on a launch stand sized from the vehicle itself: a deck ring it rests on by its lowest points outside the
// ring's hole (fins, a skirt), with nozzles and anything narrower hanging down into the hole over a flame deflector;
// splayed, braced legs; and a lattice service tower with a swing arm beside it. root: the built vehicle (its own
// group). Returns null for anything else, else { stand, y, info }: the stand (world space: add it to the scene) and the
// height to set root.position.y to. The flight's launch pad (launchpad.js) stands the same stand on its pad: opts.floor
// drops the flame deflector's foot into its flame trench, stand.userData.arm is the swing arm (a group pivoting at the
// tower, so it can swing away at ignition) and info gives the shapes it collides with (deck ring, tower).
export function uprightStage(design, root, stats = analyze(design), { floor = 0 } = {}) {
  root.rotation.set(0, 0, 0); root.position.set(0, 0, 0);
  if (!stats.vertical || !design.parts.length) { root.updateMatrixWorld(true); return stats.bike ? bikeStand(design, root) : null; } // a motorbike stands on a stand
  root.rotation.x = Math.PI / 2; root.updateMatrixWorld(true); // nose up
  const pts = [], v = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh || !o.visible || o.userData.isDisc || o.material?.blending === THREE.AdditiveBlending) return;
    const a = o.geometry.attributes.position, step = Math.max(1, Math.floor(a.count / 1500));
    for (let i = 0; i < a.count; i += step) pts.push(v.fromBufferAttribute(a, i).applyMatrix4(o.matrixWorld).clone());
  });
  if (!pts.length) return null;
  const box = new THREE.Box3().setFromPoints(pts), c = box.getCenter(new THREE.Vector3()), Hv = box.max.y - box.min.y;
  const rad = (p) => Math.hypot(p.x - c.x, p.z - c.z);
  let Rf = 0.3; for (const p of pts) if (p.y < box.min.y + Hv * 0.3) Rf = Math.max(Rf, rad(p)); // footprint of the lower third
  const rIn = Rf * 0.55; let yRest = Infinity;
  for (const p of pts) if (rad(p) > rIn) yRest = Math.min(yRest, p.y);
  const hang = yRest - box.min.y, t = 0.1 + 0.03 * Rf, H = Math.max(0.7, hang + 0.35) + t, rOut = Rf * 1.12 + 0.15;
  const stand = new THREE.Group(), b = new Bag(), deck = M.paint(0x5d6168, 'metal'), red = M.paint(0xb8321f, 'gloss'), soot = M.paint(0x2a2622, 'matte'), steel = M.steel();
  const V3 = (x, y, z) => new THREE.Vector3(c.x + x, y, c.z + z), rl = (rIn + rOut) / 2, lw = 0.08 + Rf * 0.05;
  const ring = new THREE.LatheGeometry([new THREE.Vector2(rIn, -t), new THREE.Vector2(rOut, -t), new THREE.Vector2(rOut, 0), new THREE.Vector2(rIn, 0), new THREE.Vector2(rIn, -t)], 40);
  ring.translate(c.x, H, c.z); b.add(ring, deck);
  const rim = new THREE.TorusGeometry(rIn, 0.03 + Rf * 0.01, 6, 40); rim.rotateX(Math.PI / 2); rim.translate(c.x, H, c.z); b.add(rim, M.paint(0xf2b705, 'gloss'));
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4, ca = Math.cos(a), sa = Math.sin(a), a2 = a + Math.PI / 2;
    const top = V3(ca * rl, H - t, sa * rl), foot = V3(ca * (rl + H * 0.25), 0, sa * (rl + H * 0.25));
    b.add(bar(top, foot, lw, lw), red);
    const pad = new THREE.BoxGeometry(lw * 2.2, 0.04, lw * 2.2); pad.translate(foot.x, 0.02, foot.z); b.add(pad, steel);
    const nt = V3(Math.cos(a2) * rl, H - t, Math.sin(a2) * rl), nf = V3(Math.cos(a2) * (rl + H * 0.25), 0, Math.sin(a2) * (rl + H * 0.25));
    b.add(bar(top.clone().lerp(foot, 0.15), nf.clone().lerp(nt, 0.85), lw * 0.5, lw * 0.5, true, 6), red); // X braces between neighbouring legs
    b.add(bar(foot.clone().lerp(top, 0.15), nt.clone().lerp(nf, 0.85), lw * 0.5, lw * 0.5, true, 6), red);
    const cl = new THREE.BoxGeometry(0.12 + Rf * 0.04, 0.1 + Rf * 0.04, 0.12 + Rf * 0.04); cl.translate(c.x + ca * (rIn + 0.1), H + 0.05, c.z + sa * (rIn + 0.1)); b.add(cl, steel); // hold-down clamps
  }
  const dh = Math.min(H - t, rIn) * 0.8, defl = new THREE.ConeGeometry(rIn * 0.95, dh - floor, 24); defl.translate(c.x, (dh + floor) / 2, c.z); b.add(defl, soot); // flame deflector
  // service tower (to one side of both the hangar view and the picture view): four posts, a cross-braced lattice every
  // ~1.5 m, a swing arm out to the vehicle two thirds of the way up
  const tw = 0.6 + Rf * 0.25, off = (rOut + tw * 0.5 + 0.6) * Math.SQRT1_2, tx = off, tz = -off, pr = 0.035 + Rf * 0.01, top = H + (box.max.y - yRest) * 0.8;
  const P = (i, y) => V3(tx + (i & 1 ? tw : -tw) / 2, y, tz + (i & 2 ? tw : -tw) / 2), order = [0, 1, 3, 2];
  for (let i = 0; i < 4; i++) b.add(bar(P(i, 0), P(i, top), pr * 2, pr * 2), red);
  const lv = Math.max(2, Math.round(top / 1.5));
  for (let k = 0; k <= lv; k++) for (let s = 0; s < 4; s++) {
    const y0 = (k / lv) * top, y1 = ((k + 1) / lv) * top, i = order[s], j = order[(s + 1) % 4];
    b.add(bar(P(i, y0), P(j, y0), pr * 1.4, pr * 1.4, true, 5), red);
    if (k < lv) b.add(bar(P(i, y0), P(j, y1), pr, pr, true, 5), red);
  }
  // swing arm: from the tower towards the vehicle's axis, stopping at its skin
  const ya = H + (box.max.y - yRest) * 0.62, yv = ya - H + yRest, from = V3(tx, ya, tz), dirA = new THREE.Vector3(-tx, 0, -tz).normalize();
  let reach = Math.hypot(tx, tz);
  for (const p of pts) if (Math.abs(p.y - yv) < 0.3) { const q = new THREE.Vector3(p.x - c.x - tx, 0, p.z - c.z - tz), along = q.dot(dirA); if (along > 0 && q.addScaledVector(dirA, -along).length() < tw * 0.5) reach = Math.min(reach, along - 0.04); }
  const end = from.clone().addScaledVector(dirA, Math.max(0.2, reach)), pivot = V3(tx, 0, tz), arm = new THREE.Group(), ab = new Bag();
  ab.add(bar(from, end, tw * 0.35, tw * 0.25).translate(-pivot.x, 0, -pivot.z), red); ab.add(bar(from.clone().setY(ya + tw * 0.25), end.clone().setY(ya + tw * 0.25), pr, pr, true, 5).translate(-pivot.x, 0, -pivot.z), steel);
  arm.position.copy(pivot); ab.to(arm); stand.add(arm); stand.userData.arm = arm;
  b.to(stand); stand.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  const info = { c: new THREE.Vector2(c.x, c.z), H, rIn, rOut, legR: rl + H * 0.25, tower: { x: c.x + tx, z: c.z + tz, w: tw, top } };
  return { stand, y: H - yRest, info };
}

// thumbnails of each part, rendered once
export function makeThumbnails(size = 96) {
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  r.setSize(size, size); r.setPixelRatio(1); r.toneMapping = THREE.ACESFilmicToneMapping; r.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const pm = new THREE.PMREMGenerator(r); scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.2)); const dl = new THREE.DirectionalLight(0xffffff, 2); dl.position.set(3, 5, 4); scene.add(dl);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 500);
  const out = {};
  for (const id in PARTS) {
    const o = PARTS[id].build(PARTS[id].color, { detail: 2 }); scene.add(o);
    const box = new THREE.Box3().setFromObject(o); const c = box.getCenter(new THREE.Vector3()); const s = box.getSize(new THREE.Vector3()).length();
    cam.position.copy(c).add(new THREE.Vector3(0.9, 0.55, 0.8).normalize().multiplyScalar(s * 1.75)); cam.lookAt(c);
    r.render(scene, cam); out[id] = r.domElement.toDataURL();
    scene.remove(o); o.traverse((m) => m.geometry?.dispose());
  }
  r.dispose(); r.forceContextLoss?.();
  return out;
}
