// Towns, farms, landmarks and animals.
import * as THREE from 'three';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import { mulberry32, smoothstep } from './noise.js';
import { glowTexture } from './materials.js';

function vc(g, hex, mult = 1) {
  const geo = g.index ? g.toNonIndexed() : g; const c = new THREE.Color(hex).multiplyScalar(mult), n = geo.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3)); if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2)); return geo;
}
// box whose UVs are in metres/3 so the window texture keeps real proportions
function wallBox(w, h, d) {
  const g = new THREE.BoxGeometry(w, h, d); const uv = g.attributes.uv, nrm = g.attributes.normal;
  for (let i = 0; i < uv.count; i++) { const ax = Math.abs(nrm.getX(i)) > 0.5; const along = ax ? d : w; uv.setXY(i, uv.getX(i) * along / 12, uv.getY(i) * h / 12); if (Math.abs(nrm.getY(i)) > 0.5) uv.setXY(i, 0, 0); }
  return g;
}
function gableRoof(w, d, h, over = 0.5) { // ridge along z
  const s = new THREE.Shape([new THREE.Vector2(-w / 2 - over, 0), new THREE.Vector2(w / 2 + over, 0), new THREE.Vector2(0, h)]);
  const g = new THREE.ExtrudeGeometry(s, { depth: d + over * 2, bevelEnabled: false }); g.translate(0, 0, -d / 2 - over); return g;
}
const KIT = {
  house: (r, st) => { // style-aware detached house
    const w = 7 + r() * 4, d = 8 + r() * 5, h = (st === 'chalet' ? 5.5 : 5) + r() * 2.5, walls = [], roofs = [];
    walls.push(wallBox(w, h, d).translate(0, h / 2, 0));
    if (st === 'adobe') { roofs.push(vc(new THREE.BoxGeometry(w + 0.4, 0.5, d + 0.4).translate(0, h + 0.25, 0), 0xffffff)); for (let k = 0; k < 4; k++) roofs.push(vc(new THREE.CylinderGeometry(0.12, 0.12, 0.6, 5).rotateZ(Math.PI / 2).translate(w / 2 + 0.2, h - 0.6, -d / 2 + 1 + k * (d - 2) / 3), 0x5a3a22)); }
    else { roofs.push(vc(gableRoof(w, d, (st === 'chalet' ? 0.38 : 0.55) * w, st === 'chalet' ? 1.1 : 0.45).translate(0, h, 0), 0xffffff)); roofs.push(vc(new THREE.BoxGeometry(0.7, 2.2, 0.7).translate(w * 0.25, h + w * 0.35, d * 0.2), 0x7a5a48)); }
    if (st === 'chalet') roofs.push(vc(new THREE.BoxGeometry(w + 0.2, 0.15, 1.6).translate(0, h * 0.55, d / 2 + 0.8), 0x6a4a30)); // balcony
    return { walls, roofs, w, d, h, chimney: st !== 'adobe' ? new THREE.Vector3(w * 0.25, h + w * 0.35 + 1.2, d * 0.2) : null };
  },
  apartment: (r) => { const w = 14 + r() * 8, d = 12 + r() * 4, h = 12 + Math.floor(r() * 4) * 3; return { walls: [wallBox(w, h, d).translate(0, h / 2, 0)], roofs: [vc(new THREE.BoxGeometry(w + 0.4, 0.6, d + 0.4).translate(0, h + 0.3, 0), 0x6a6a6a), vc(new THREE.BoxGeometry(3, 2.5, 3).translate(w * 0.2, h + 1.5, 0), 0x8a8a8a)], w, d, h }; },
  shop: (r) => { const w = 12 + r() * 6, d = 10 + r() * 4, h = 5; return { walls: [wallBox(w, h, d).translate(0, h / 2, 0)], roofs: [vc(new THREE.BoxGeometry(w + 0.3, 0.5, d + 0.3).translate(0, h + 0.25, 0), 0x707070), vc(new THREE.BoxGeometry(w, 0.15, 2.5).translate(0, 3.2, d / 2 + 1.2), 0xc8102e)], w, d, h }; },
  church: () => {
    const walls = [wallBox(10, 9, 22).translate(0, 4.5, 0), wallBox(5, 22, 5).translate(0, 11, -12)];
    const roofs = [vc(gableRoof(10, 22, 6, 0.4).translate(0, 9, 0), 0xffffff), vc(new THREE.ConeGeometry(3.8, 12, 4).rotateY(Math.PI / 4).translate(0, 28, -12), 0xffffff), vc(new THREE.CylinderGeometry(0.15, 0.15, 3).translate(0, 35.5, -12), 0xd4af37)];
    return { walls, roofs, w: 10, d: 27, h: 22 };
  },
  barn: (r) => {
    const w = 12 + r() * 4, d = 18 + r() * 6, h = 6;
    const s = new THREE.Shape([[-w / 2 - 0.3, 0], [w / 2 + 0.3, 0], [w / 2 + 0.3, 0.3], [w * 0.35, 3.2], [0, 4.6], [-w * 0.35, 3.2], [-w / 2 - 0.3, 0.3]].map(([x, y]) => new THREE.Vector2(x, y)));
    const roof = new THREE.ExtrudeGeometry(s, { depth: d + 0.6, bevelEnabled: false }).translate(0, h, -d / 2 - 0.3);
    return { walls: [wallBox(w, h, d).translate(0, h / 2, 0)], roofs: [vc(roof, 0x555b62)], w, d, h, barn: true };
  },
  silo: () => ({ walls: [], roofs: [vc(new THREE.CylinderGeometry(3, 3, 16, 16).translate(0, 8, 0), 0xc0c4c8), vc(new THREE.SphereGeometry(3, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 16, 0), 0xa0a4a8)], w: 6, d: 6, h: 19 }),
  hotel: (r) => { const w = 30 + r() * 15, d = 14, h = 15 + Math.floor(r() * 3) * 3.2; return { walls: [wallBox(w, h, d).translate(0, h / 2, 0)], roofs: [vc(new THREE.BoxGeometry(w + 0.5, 0.6, d + 0.5).translate(0, h + 0.3, 0), 0xe0dcd0)], w, d, h }; },
  hut: () => ({ walls: [wallBox(4, 3, 4).translate(0, 1.5, 0)], roofs: [vc(new THREE.ConeGeometry(4, 2.5, 4).rotateY(Math.PI / 4).translate(0, 4.2, 0), 0xc9a86a)], w: 4, d: 4, h: 5 }),
  station: () => ({ walls: [wallBox(14, 5, 10).translate(0, 2.5, 0)], roofs: [vc(new THREE.BoxGeometry(26, 0.5, 14).translate(6, 6, 0), 0xc8102e), vc(new THREE.CylinderGeometry(0.2, 0.2, 6).translate(17, 3, -5), 0xaaaaaa), vc(new THREE.CylinderGeometry(0.2, 0.2, 6).translate(17, 3, 5), 0xaaaaaa), vc(new THREE.BoxGeometry(1.2, 1.6, 0.9).translate(12, 0.8, 0), 0xdddddd)], w: 26, d: 14, h: 6.5 }),
};
const STYLE = {
  alpine: { st: 'chalet', walls: [0xf4efe6, 0xe8dcc4, 0xd9cbb0, 0xc9a77a], roofs: [0x5a4034, 0x4b4b52, 0x6a3a2a], barnWall: 0x8a2a20 },
  islands: { st: 'cottage', walls: [0xffffff, 0xf3e7c9, 0x9fd4d9, 0xf0c9a8, 0xf6d6e0, 0xcbe8c4], roofs: [0xc1543b, 0x4a7aa3, 0xd0a060, 0x2f8a8a], barnWall: 0xb8875a },
  canyon: { st: 'adobe', walls: [0xd8b48a, 0xc9a074, 0xe2c9a6, 0xbf9068], roofs: [0xb98a5e, 0xa0714a, 0xc8a070], barnWall: 0x8a3a24 },
};

export class Towns {
  constructor(world) {
    this.w = world; this.group = new THREE.Group(); world.group.add(this.group);
    const r = (this.r = mulberry32(world.loc.seed * 5 + 3)), W = world, S = STYLE[W.loc.id];
    this.items = []; // {type, x, z, yaw, wallCol, roofCol}
    this.grid = new Map(); this.chimneys = [];
    const place = (type, x, z, yaw, opts = {}) => {
      const gh = W.sampleGrid(x, z); if (gh < W.waterLevel + 0.5 && !opts.water) return false;
      if (this.items.some((it) => (it.x - x) ** 2 + (it.z - z) ** 2 < (opts.gap || 14) ** 2)) return false;
      this.items.push({ type, x, z, y: gh, yaw, wall: opts.wall ?? S.walls[Math.floor(r() * S.walls.length)], roof: opts.roof ?? S.roofs[Math.floor(r() * S.roofs.length)] });
      return true;
    };
    // towns: buildings along each street, facing it
    for (const t of W.net.towns) {
      const side = new THREE.Vector3(-t.dir.z, 0, t.dir.x), facing = Math.atan2(t.dir.x, t.dir.z);
      place('church', t.c.x + side.x * 30, t.c.z + side.z * 30, facing, { gap: 25, wall: 0xf2efe8, roof: W.loc.id === 'canyon' ? 0xc9a070 : 0x4b4b52 });
      place('station', t.c.x - side.x * 34 + t.dir.x * 60, t.c.z - side.z * 34 + t.dir.z * 60, facing + Math.PI / 2, { gap: 25, wall: 0xe8e4dc, roof: 0x707070 });
      for (const rd of W.net.roads) {
        if (rd.kind !== 'street' || rd.pts[0].distanceTo(t.c) > 700) continue;
        rd.pts.forEach((p, i) => {
          if (i % 3) return;
          const a = rd.pts[Math.max(0, i - 1)], b = rd.pts[Math.min(rd.pts.length - 1, i + 1)], d = new THREE.Vector3().subVectors(b, a).setY(0).normalize(), n = new THREE.Vector3(-d.z, 0, d.x);
          for (const s of [-1, 1]) {
            if (r() < 0.12) continue;
            const off = 14 + r() * 5, x = p.x + n.x * off * s, z = p.z + n.z * off * s;
            if (W.nearRoad(x, z, 9)) continue;
            const center = Math.hypot(x - t.c.x, z - t.c.z) < 140 * t.size;
            const type = center ? (r() < 0.5 ? (W.loc.id === 'islands' && r() < 0.4 ? 'hotel' : 'apartment') : 'shop') : 'house';
            place(type, x, z, Math.atan2(n.x * -s, n.z * -s), { gap: type === 'house' ? 13 : 22 });
          }
        });
      }
      // extra houses filling in behind
      for (let k = 0; k < 40 * t.size; k++) { const a = r() * 6.28, d = 60 + r() * 260 * t.size; const x = t.c.x + Math.cos(a) * d, z = t.c.z + Math.sin(a) * d; if (!W.nearRoad(x, z, 10)) place('house', x, z, facing + Math.round(r() * 4) * Math.PI / 2 + (r() - 0.5) * 0.2); }
    }
    // farms next to fields
    for (const f of W.net.fields) {
      if (r() < 0.55) continue;
      const a = r() * 6.28, d = Math.max(f.sx, f.sz) + 25, x = f.x + Math.cos(a) * d, z = f.z + Math.sin(a) * d;
      if (W.nearRoad(x, z, 12) || W.groundAt(x, z).n.y < 0.95) continue;
      if (place('house', x, z, a)) {
        place('barn', x + Math.cos(a + 1.2) * 28, z + Math.sin(a + 1.2) * 28, a, { wall: S.barnWall, roof: 0x555b62 });
        if (r() < 0.6) place('silo', x + Math.cos(a + 1.9) * 26, z + Math.sin(a + 1.9) * 26, 0, { gap: 8, wall: 0xc0c4c8, roof: 0xc0c4c8 });
        f.farm = new THREE.Vector3(x, 0, z);
      }
    }
    // beach huts on the islands
    if (W.loc.id === 'islands') for (let k = 0; k < 220 && this.items.length < 900; k++) {
      const a = r() * 6.28, x = 140 + Math.cos(a) * 1500 * 0.95, z = Math.sin(a) * 3200;
      for (let s = 0; s < 40; s++) { const xx = x * (1 - s * 0.01), zz = z * (1 - s * 0.01); const h = W.sampleGrid(xx, zz); if (h > W.waterLevel + 1 && h < W.waterLevel + 4) { place('hut', xx, zz, a + Math.PI, { gap: 30, wall: 0xe8dcc0, roof: 0xc9a86a }); break; } }
    }
    this.buildMeshes();
    this.buildLandmarks();
    this.buildAnimals();
  }
  buildMeshes() {
    const W = this.w, r = this.r, S = STYLE[W.loc.id];
    // 4x4 windows per tile (12 m), some lit at night and some not
    const lit = Array.from({ length: 16 }, () => r() < 0.6);
    const winTex = (() => {
      const c = document.createElement('canvas'); c.width = 256; c.height = 256; const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { const x = i * 64, y = j * 64; g.fillStyle = '#1e2731'; g.fillRect(x + 18, y + 14, 28, 32); g.fillStyle = '#fff'; g.fillRect(x + 31, y + 14, 2, 32); g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(x, y + 60, 64, 4); }
      const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
    })();
    const emis = (() => { const c = document.createElement('canvas'); c.width = 256; c.height = 256; const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (lit[i * 4 + j]) { g.fillStyle = ['#ffd890', '#ffe8c0', '#fff4e0', '#ffc070'][(i + j) % 4]; g.fillRect(i * 64 + 19, j * 64 + 15, 26, 30); }
      const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t; })();
    const wallMat = new THREE.MeshStandardMaterial({ map: winTex, roughness: 0.85, emissive: 0xffc070, emissiveMap: emis, emissiveIntensity: 0 });
    const roofMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
    this.wallMat = wallMat; W.windowMats.push(wallMat);
    // a few size variants per type keep window proportions right
    const variants = {};
    const getVar = (type) => { if (!variants[type]) variants[type] = Array.from({ length: type === 'church' || type === 'station' || type === 'silo' ? 1 : 4 }, () => ({ m: KIT[type](r, S.st), list: [] })); return variants[type][Math.floor(r() * variants[type].length)]; };
    for (const it of this.items) { const v = getVar(it.type); v.list.push(it); it.v = v.m; }
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), col = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
    for (const type in variants) for (const v of variants[type]) {
      if (!v.list.length) continue;
      const mk = (geos, mat, colorKey) => {
        if (!geos.length) return;
        const g = mergeGeometries(geos.map((x) => (x.index ? x.toNonIndexed() : x)).map((x) => { if (!x.attributes.color) vc(x, 0xffffff); return x; }));
        const im = new THREE.InstancedMesh(g, mat, v.list.length); im.castShadow = W.qName === 'high'; im.receiveShadow = true;
        v.list.forEach((it, i) => { q.setFromAxisAngle(up, it.yaw); m4.compose(new THREE.Vector3(it.x, it.y - 0.3, it.z), q, one); im.setMatrixAt(i, m4); im.setColorAt(i, col.set(it[colorKey])); });
        this.group.add(im);
      };
      mk(v.m.walls.map((g) => vc(g, 0xffffff)), wallMat, 'wall');
      mk(v.m.roofs, roofMat, 'roof');
      for (const it of v.list) {
        const key = Math.floor(it.x / 50) + ',' + Math.floor(it.z / 50); if (!this.grid.has(key)) this.grid.set(key, []);
        this.grid.get(key).push([it.x, it.y, it.z, v.m.h, Math.max(v.m.w, v.m.d) * 0.55]);
        if (v.m.chimney && W.loc.id === 'alpine' && r() < 0.5) this.chimneys.push(v.m.chimney.clone().applyAxisAngle(up, it.yaw).add(new THREE.Vector3(it.x, it.y, it.z)));
      }
    }
  }
  buildLandmarks() {
    const W = this.w, r = this.r;
    this.spinners = [];
    // wind turbines on open high ground
    if (W.loc.id !== 'islands') {
      const tower = mergeGeometries([vc(new THREE.CylinderGeometry(1.1, 2, 80, 12).translate(0, 40, 0), 0xf0f0f0), vc(new THREE.BoxGeometry(3, 3, 9).translate(0, 81, 1.5), 0xf0f0f0)]);
      const bladeG = mergeGeometries([0, 1, 2].map((k) => vc(new THREE.BoxGeometry(1.4, 38, 0.4).translate(0, 19, 0).rotateZ((k / 3) * Math.PI * 2), 0xf4f4f4)).concat([vc(new THREE.SphereGeometry(1.4, 10, 8), 0xf0f0f0)]));
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.1 });
      let placed = 0;
      for (let k = 0; k < 600 && placed < 12; k++) {
        const x = (r() - 0.5) * 14000, z = (r() - 0.5) * 14000, h = W.sampleGrid(x, z);
        if (Math.hypot(x - 140, z) < 2600 || h < W.loc.rwyH + 60 || h > (W.loc.desert ? 900 : 1100)) continue;
        if (W.groundAt(x, z).n.y < 0.93) continue;
        // a short row of turbines
        const a = r() * 6.28;
        for (let j = 0; j < 4 && placed < 12; j++) {
          const xx = x + Math.cos(a) * j * 160, zz = z + Math.sin(a) * j * 160, hh = W.sampleGrid(xx, zz);
          if (Math.abs(hh - h) > 60) continue;
          const t = new THREE.Mesh(tower, mat); t.position.set(xx, hh - 1, zz); t.rotation.y = W.windBase ? Math.atan2(W.windBase.x, W.windBase.z) : 0; t.castShadow = true; this.group.add(t);
          const rot = new THREE.Mesh(bladeG, mat); rot.position.set(0, 81, -3.6); t.add(rot); this.spinners.push({ o: rot, sp: 1 + r() * 0.4 });
          const blink = new THREE.Mesh(new THREE.SphereGeometry(0.5, 6, 4), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.2, 0.1) })); blink.position.set(0, 83, 3); t.add(blink); this.spinners.push({ blink });
          placed++;
        }
      }
    }
    // radio mast on a peak near the airport
    {
      let best = null; for (let k = 0; k < 200; k++) { const x = 140 + (r() - 0.5) * 7000, z = (r() - 0.5) * 7000, h = W.sampleGrid(x, z); if (!best || h > best.h) best = { x, z, h }; }
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 1.2, 60, 6), new THREE.MeshStandardMaterial({ color: 0xc8102e, roughness: 0.6 })); mast.position.set(best.x, best.h + 29, best.z); this.group.add(mast);
      const blink = new THREE.Mesh(new THREE.SphereGeometry(0.8, 6, 4), new THREE.MeshBasicMaterial({ color: new THREE.Color(8, 0.3, 0.2) })); blink.position.y = 31; mast.add(blink); this.spinners.push({ blink });
    }
    // lighthouse + harbour on the islands
    if (W.loc.id === 'islands') {
      let spot = null; for (let a = 0; a < 6.28 && !spot; a += 0.05) for (let d = 1300; d < 4000; d += 20) { const x = 140 + Math.cos(a) * d * 0.6, z = Math.sin(a) * d; const h = W.sampleGrid(x, z); if (h < W.waterLevel + 1) { if (d > 1600 && Math.abs(Math.sin(a)) > 0.6) spot = { x: 140 + Math.cos(a) * (d - 40) * 0.6, z: Math.sin(a) * (d - 40), a }; break; } }
      if (spot) {
        const h = Math.max(W.sampleGrid(spot.x, spot.z), W.waterLevel + 1);
        const lh = new THREE.Group(); lh.position.set(spot.x, h, spot.z);
        const tower = new THREE.Mesh(new THREE.CylinderGeometry(2, 3, 26, 16), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 })); tower.position.y = 13; lh.add(tower);
        for (let k = 0; k < 3; k++) { const band = new THREE.Mesh(new THREE.CylinderGeometry(2.6 - k * 0.25, 2.75 - k * 0.25, 3, 16), new THREE.MeshStandardMaterial({ color: 0xc8102e })); band.position.y = 5 + k * 7; lh.add(band); }
        const lamp = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 2.4, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 3.6, 2.6) })); lamp.position.y = 27.5; lh.add(lamp);
        const beam = new THREE.Mesh(new THREE.ConeGeometry(14, 300, 16, 1, true), new THREE.MeshBasicMaterial({ color: 0xfff2c0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
        beam.rotation.z = Math.PI / 2; beam.position.x = 150; const piv = new THREE.Object3D(); piv.position.y = 27.5; piv.add(beam); lh.add(piv);
        lh.traverse((o) => { if (o.isMesh && o !== beam) o.castShadow = true; });
        this.group.add(lh); this.lighthouse = { piv, beam, lamp };
        // harbour pier with moored boats
        const pier = new THREE.Group(); const plank = new THREE.MeshStandardMaterial({ color: 0x8a6a48, roughness: 0.9 });
        const dir = new THREE.Vector3(Math.cos(spot.a) * 0.6, 0, Math.sin(spot.a)).normalize();
        const base = new THREE.Vector3(spot.x, W.waterLevel, spot.z).addScaledVector(new THREE.Vector3(-dir.z, 0, dir.x), 120);
        for (let k = 0; k < 14; k++) { const p = base.clone().addScaledVector(dir, k * 8 - 10); const deck = new THREE.Mesh(new THREE.BoxGeometry(4, 0.5, 8.2), plank); deck.position.set(p.x, W.waterLevel + 1.6, p.z); deck.rotation.y = Math.atan2(dir.x, dir.z); pier.add(deck); for (const s of [-1.8, 1.8]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 5), plank); post.position.set(p.x - dir.z * s, W.waterLevel - 0.5, p.z + dir.x * s); pier.add(post); } }
        this.group.add(pier);
        this.moored = [];
        for (let k = 0; k < 6; k++) { const p = base.clone().addScaledVector(dir, 15 + k * 14).addScaledVector(new THREE.Vector3(-dir.z, 0, dir.x), (k % 2 ? 1 : -1) * 6); this.moored.push(p); }
      }
    }
  }
  buildAnimals() {
    const W = this.w, r = this.r;
    const sheep = W.loc.id === 'alpine', g = [];
    if (sheep) { g.push(vc(new THREE.IcosahedronGeometry(0.6, 1).scale(1, 0.75, 1.3).translate(0, 0.85, 0), 0xf2efe6)); g.push(vc(new THREE.BoxGeometry(0.3, 0.32, 0.4).translate(0, 1.0, -0.85), 0x2a2622)); }
    else { g.push(vc(new THREE.BoxGeometry(0.9, 0.9, 2.0).translate(0, 1.2, 0), 0xffffff)); g.push(vc(new THREE.BoxGeometry(0.5, 0.55, 0.7).translate(0, 1.5, -1.25), 0xffffff)); }
    for (const [x, z] of [[-0.3, -0.6], [0.3, -0.6], [-0.3, 0.6], [0.3, 0.6]]) g.push(vc(new THREE.CylinderGeometry(0.08, 0.08, sheep ? 0.6 : 0.8, 5).translate(x * (sheep ? 1 : 1.2), sheep ? 0.3 : 0.4, z * (sheep ? 1 : 1.3)), 0x2a2622));
    const geo = mergeGeometries(g);
    this.animals = [];
    for (const f of W.net.fields) {
      if (!f.farm || f.pivot) continue;
      const n = 6 + Math.floor(r() * 10);
      for (let k = 0; k < n; k++) this.animals.push({ x: f.x + (r() - 0.5) * f.sx, z: f.z + (r() - 0.5) * f.sz, yaw: r() * 6.28, f, t: r() * 10, walk: 0 });
    }
    if (!this.animals.length) return;
    this.herd = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }), this.animals.length);
    const col = new THREE.Color();
    this.animals.forEach((a, i) => this.herd.setColorAt(i, sheep ? col.set(0xffffff) : col.set([0x5a3a28, 0x2a2622, 0xf0ece4, 0x8a5a3a][i % 4])));
    this.herd.castShadow = true; this.herd.frustumCulled = false; this.group.add(this.herd);
  }
  hit(p) {
    const arr = this.grid.get(Math.floor(p.x / 50) + ',' + Math.floor(p.z / 50)); if (!arr) return null;
    for (const t of arr) { const dx = p.x - t[0], dz = p.z - t[2]; if (dx * dx + dz * dz < t[4] * t[4] && p.y < t[1] + t[3] && p.y > t[1] - 2) return t; }
    return null;
  }
  update(dt, t, fx, cam) {
    const W = this.w, night = W.night || W.W.dark > 0.55;
    for (const s of this.spinners) { if (s.o) s.o.rotation.z += dt * s.sp * (0.6 + W.W.wind * 0.08); if (s.blink) s.blink.visible = Math.floor(t * 1.1) % 2 === 0; }
    if (this.lighthouse) { this.lighthouse.piv.rotation.y += dt * 0.6; this.lighthouse.beam.material.opacity = night ? 0.08 : 0; this.lighthouse.lamp.visible = true; }
    if (fx && cam) for (const c of this.chimneys) if (Math.random() < dt * 1.5 && c.distanceToSquared(cam) < 2500 * 2500) fx.smoke.add(c.x, c.y, c.z, W.windBase.x * 0.3 + (Math.random() - 0.5), 1.2, W.windBase.z * 0.3 + (Math.random() - 0.5), 9, 0.8, 7, 0.75, 0.75, 0.78, 0.35, 0.2, -0.15);
    if (this.herd) {
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
      this.animals.forEach((a, i) => {
        a.t -= dt;
        if (a.t < 0) { a.walk = Math.random() < 0.3 ? 0.6 : 0; a.yaw += (Math.random() - 0.5) * 1.5; a.t = 3 + Math.random() * 8; }
        if (a.walk) { a.x -= Math.sin(a.yaw) * a.walk * dt; a.z -= Math.cos(a.yaw) * a.walk * dt; if (Math.abs(a.x - a.f.x) > a.f.sx * 0.8 || Math.abs(a.z - a.f.z) > a.f.sz * 0.8) a.yaw += Math.PI; }
        q.setFromAxisAngle(up, a.yaw); m.compose(new THREE.Vector3(a.x, W.sampleGrid(a.x, a.z) - 0.05, a.z), q, one); this.herd.setMatrixAt(i, m);
      });
      this.herd.instanceMatrix.needsUpdate = true;
    }
  }
}
