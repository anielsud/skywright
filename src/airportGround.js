// The airfield's ground (#227 phase 2): mown grass over the levelled infield, paved shoulders and blast pads, the
// perimeter fence, and the landside road from the terminal out to the gate where roads.js joins the road network.
//
// The infield (World.rawHeight levels it: x -250..450, |z| < 1150, exactly runway height) gets one flat textured
// plane: mowing stripes along the runways, tinted from the ground just outside it (the real imagery or the map's own
// colours, water left out), its edges faded into the terrain. That also hides what the imagery shows under the
// levelled ground (the real Grand Canyon Airport's runway beside ours, the water under New York's pad).
import * as THREE from 'three';
import { C } from './buildings.js';
import { mergeGeometries } from '../vendor/addons/BufferGeometryUtils.js';
import { airportGate } from './airportKit.js';

export const INFIELD = { x0: -250, x1: 450, z: 1150 }; // World.rawHeight's level box (x 100 ± 350, |z| < RWY.len / 2 + 250)
export const FENCE = { x0: -330, x1: 555, z: 1235, gate: 12 }; // gate: half width of the landside road's opening
export const ROAD = { x0: 331, w: 9 }; // the landside road: from the terminal's kerb east to the gate

const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; };
const tex = (c, srgb = true) => { const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; };

// the infield's tint: the average ground colour in a ring just outside the levelled box, water and blue-ish texels
// (imagery of the sea) left out. Falls back to the map's grass.
const TEX_MEAN = 0.67;
function infieldTint(W) {
  const c = new THREE.Color(), sum = new THREE.Color(0, 0, 0), n = new THREE.Vector3(0, 1, 0); let k = 0;
  for (let i = 0; i < 160; i++) {
    const a = (i / 160) * Math.PI * 2, x = 100 + Math.cos(a) * 520, z = Math.sin(a) * 1320, h = W.heightAt(x, z);
    if (h < W.waterLevel + 1) continue;
    W.baseColor(x, z, h, 0, c, n);
    if (c.b > c.r * 1.02 || c.g < c.b * 1.1 || c.r + c.g + c.b < 0.06 || c.r + c.g + c.b > 1.9) continue; // only plants and dry ground: no sea, lagoon (bluer than red), concrete (grey), shadow, sand or surf
    sum.r += c.r; sum.g += c.g; sum.b += c.b; k++;
  }
  if (k < 12) return new THREE.Color(W.loc.colors?.grass?.[1] ?? 0x5f7f35);
  // (the grass texture averages ~0.67 in linear terms: divide it back out, so the infield's albedo is the ground's)
  sum.multiplyScalar(1 / k).convertSRGBToLinear().multiplyScalar(1 / TEX_MEAN); // (baseColor gives sRGB values: the ground bake is an sRGB texture)
  return new THREE.Color(Math.min(1, sum.r), Math.min(1, sum.g), Math.min(1, sum.b));
}

// grass tile: two mowing stripes (one a little lighter, one darker) across 24 m, fine speckle; grey (sRGB 214,
// ~0.67 linear), tinted by the material colour
function grassTexture() {
  const [c, g] = canvas(256, 256);
  if (g?.createImageData) {
    const img = g.createImageData(256, 256), d = img.data;
    for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
      const k = (j * 256 + i) * 4, stripe = i < 128 ? 1.035 : 0.965, v = 214 * stripe + (Math.random() - 0.5) * 26;
      d[k] = d[k + 1] = d[k + 2] = Math.max(0, Math.min(255, v)); d[k + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }
  const t = tex(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}
// edge fade over the infield (alpha: 1 inside, 0 at the box edge), its own transform (not repeated)
function fadeTexture(fx, fz) {
  const [c, g] = canvas(128, 256);
  if (g?.createImageData) {
    const img = g.createImageData(128, 256), d = img.data, s = (e) => Math.max(0, Math.min(1, e)) ** 1.5;
    for (let j = 0; j < 256; j++) for (let i = 0; i < 128; i++) {
      const u = Math.min(i + 0.5, 127.5 - i) / 128, v = Math.min(j + 0.5, 255.5 - j) / 256, a = s(u / fx) * s(v / fz);
      const k = (j * 128 + i) * 4; d[k] = d[k + 1] = d[k + 2] = a * 255; d[k + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }
  return tex(c, false);
}
// blast pad: yellow chevrons pointing at the runway (towards -v), on dark asphalt
function blastTexture() {
  const [c, g] = canvas(256, 256);
  if (g?.fillRect) {
    g.fillStyle = '#3e3f42'; g.fillRect(0, 0, 256, 256);
    g.strokeStyle = '#e2b52a'; g.lineWidth = 9;
    for (let y = -64; y < 300; y += 64) { g.beginPath(); g.moveTo(0, y + 60); g.lineTo(128, y); g.lineTo(256, y + 60); g.stroke(); }
  }
  return tex(c);
}
// chain-link: diamond mesh with see-through holes (alpha-tested), posts drawn separately
function chainTexture() {
  const [c, g] = canvas(64, 64);
  if (g?.clearRect) {
    g.clearRect(0, 0, 64, 64); g.strokeStyle = 'rgba(170,174,176,1)'; g.lineWidth = 2.2;
    for (let k = -64; k < 128; k += 16) { g.beginPath(); g.moveTo(k, 0); g.lineTo(k + 64, 64); g.stroke(); g.beginPath(); g.moveTo(k + 64, 0); g.lineTo(k, 64); g.stroke(); }
    g.fillStyle = 'rgba(150,154,156,1)'; g.fillRect(0, 0, 64, 3); // top wire
  }
  const t = tex(c); t.wrapS = THREE.RepeatWrapping; return t;
}
// landside road: asphalt, white edge lines, dashed centre
function roadTexture() {
  const [c, g] = canvas(64, 256);
  if (g?.fillRect) {
    g.fillStyle = '#4a4b4e'; g.fillRect(0, 0, 64, 256);
    for (let k = 0; k < 900; k++) { g.fillStyle = `rgba(${Math.random() < 0.5 ? '30,30,32' : '110,110,112'},0.25)`; g.fillRect(Math.random() * 64, Math.random() * 256, 1, 1); }
    g.fillStyle = '#e4e4de'; g.fillRect(3, 0, 2, 256); g.fillRect(59, 0, 2, 256); for (let y = 0; y < 256; y += 64) g.fillRect(31, y, 2, 32);
  }
  const t = tex(c); t.wrapT = THREE.RepeatWrapping; return t;
}

// A: the airport's Builder (fence posts and the gate go into its merged geometry), y: runway height.
// Returns { meshes: [Mesh...], fenceSegs, roadPts: [[x, z]...] (the landside road's centreline) }.
export function buildAirportGround(W, A, y, RWY) {
  const meshes = [], half = RWY.len / 2, flat = (geo, x, z) => { geo.rotateX(-Math.PI / 2); geo.translate(x, y, z); return geo; };
  const ground = (x, z) => W.heightAt(x, z);

  // ---- mown infield ----
  {
    const w = INFIELD.x1 - INFIELD.x0, l = INFIELD.z * 2, geo = flat(new THREE.PlaneGeometry(w, l), (INFIELD.x0 + INFIELD.x1) / 2, 0);
    geo.translate(0, 0.015, 0);
    const map = grassTexture(); map.repeat.set(w / 24, l / 160); // (stripes 12 m wide along the runways; speckle stretched along them)
    const mat = new THREE.MeshStandardMaterial({ map, alphaMap: fadeTexture(110 / w, 110 / l), color: infieldTint(W), roughness: 0.95, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
    const m = new THREE.Mesh(geo, mat); m.receiveShadow = true; m.renderOrder = -1; m.name = 'airport infield'; meshes.push(m);
  }

  // ---- shoulders (7.5 m each side) and blast pads (the 30 m overruns) ----
  {
    const sh = [], bp = [];
    for (const r of W.runways) {
      for (const s of [-1, 1]) sh.push(flat(new THREE.PlaneGeometry(7.5, RWY.len + 60), r.x + s * (r.width / 2 + 3.75), 0));
      for (const s of [-1, 1]) { const g = new THREE.PlaneGeometry(r.width, 30); if (s < 0) g.rotateZ(Math.PI); bp.push(flat(g, r.x, s * (half + 15))); }
    }
    const shTex = W.detailTexture(); shTex.repeat.set(2, 120);
    const shMat = new THREE.MeshStandardMaterial({ color: 0x77777a, map: shTex, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 });
    const s = new THREE.Mesh(mergeGeometries(sh), shMat); s.position.y = 0.025; s.receiveShadow = true; s.name = 'runway shoulders'; meshes.push(s);
    const b = new THREE.Mesh(mergeGeometries(bp), new THREE.MeshStandardMaterial({ map: blastTexture(), roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }));
    b.position.y = 0.03; b.receiveShadow = true; b.name = 'blast pads'; meshes.push(b);
  }

  // ---- perimeter fence: chain-link on posts every 4 m, following the ground; none over water or cliffs ----
  const gate = airportGate(W.loc), segs = [];
  {
    const F = FENCE, corners = [[F.x0, F.z], [F.x1, F.z], [F.x1, -F.z], [F.x0, -F.z], [F.x0, F.z]], pos = [], uv = [], H = 2.2, STEP = 4;
    let u = 0;
    for (let e = 0; e < 4; e++) {
      const [ax, az] = corners[e], [bx, bz] = corners[e + 1], L = Math.hypot(bx - ax, bz - az), n = Math.round(L / STEP);
      for (let k = 0; k < n; k++) {
        const x0 = ax + (bx - ax) * k / n, z0 = az + (bz - az) * k / n, x1 = ax + (bx - ax) * (k + 1) / n, z1 = az + (bz - az) * (k + 1) / n;
        const g0 = ground(x0, z0), g1 = ground(x1, z1), wl = W.waterLevel + 0.3, du = L / n / 2;
        const open = gate && e === 1 && Math.abs((z0 + z1) / 2 - gate.z) < F.gate; // (the east side, at the road)
        if (open || g0 < wl || g1 < wl || Math.abs(g1 - g0) > 3) { u += du; continue; }
        A.setFrame(0, y, 0, 0); A.box(x0, g0 - y - 0.3, z0, 0.09, H + 0.4, 0.09, C.PLAIN, 0x8a8e90);
        if (k === n - 1) A.box(x1, g1 - y - 0.3, z1, 0.09, H + 0.4, 0.09, C.PLAIN, 0x8a8e90);
        pos.push(x0, g0, z0, x1, g1, z1, x1, g1 + H, z1, x0, g0, z0, x1, g1 + H, z1, x0, g0 + H, z0);
        uv.push(u, 0, u + du, 0, u + du, 1, u, 0, u + du, 1, u, 1); u += du;
        segs.push([x0, z0, x1, z1]);
      }
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.computeVertexNormals();
    const map = chainTexture(); map.repeat.set(1, 1);
    // (map + alphaTest + double-sided: the same shader as flora's impostor cards, compiled anyway)
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.3 })); m.name = 'perimeter fence'; meshes.push(m);
    // gate posts and a sliding gate pulled open beside the road
    if (gate) {
      A.setFrame(0, y, 0, 0);
      for (const s of [-1, 1]) A.box(F.x1, ground(F.x1, gate.z + s * F.gate) - y - 0.3, gate.z + s * F.gate, 0.3, H + 0.9, 0.3, C.PLAIN, 0xc8282e);
      A.box(F.x1 + 0.4, ground(F.x1, gate.z + F.gate + 6) - y + 0.15, gate.z + F.gate + 6, 0.08, 1.6, 12, C.RAIL_IRON, 0x9a9ea4);
    }
  }

  // ---- landside road: from the terminal's kerb east through the fence to the gate ----
  const roadPts = [];
  if (gate) {
    const pos = [], uv = [], z = gate.z, hw = ROAD.w / 2, x1 = gate.x + 6;
    let v = 0;
    for (let x = ROAD.x0; x < x1; x += 8) {
      const xb = Math.min(x1, x + 8), ga = ground(x, z) + 0.06, gb = ground(xb, z) + 0.06, dv = (xb - x) / 16;
      pos.push(x, ga, z + hw, xb, gb, z + hw, xb, gb, z - hw, x, ga, z + hw, xb, gb, z - hw, x, ga, z - hw);
      uv.push(0, v, 0, v + dv, 1, v + dv, 0, v, 1, v + dv, 1, v); v += dv;
      roadPts.push([x, z]);
    }
    roadPts.push([x1, z]);
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: roadTexture(), roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }));
    m.receiveShadow = true; m.name = 'landside road'; meshes.push(m);
  }
  return { meshes, fenceSegs: segs, roadPts, gate };
}

// World.rawHeight: hold the ground at runway height along the landside road, from the infield's edge out past the gate
export function gateLevel(gate, rwyH, x, z, h) {
  if (!gate || x < INFIELD.x1 - 60 || x > gate.x + 70) return h;
  const w = Math.max(0, Math.min(1, (26 - Math.abs(z - gate.z)) / 12)) * Math.max(0, Math.min(1, (gate.x + 70 - x) / 50));
  const s = w * w * (3 - 2 * w);
  return h + (rwyH - h) * s;
}
