// Wind tunnel smoke: streamlines around the vehicle, driven by the flight model's own forces (aircraft.js aeroLoads).
//
// Not CFD, a potential-flow sketch built from the parts, sized by what the flight model says each part is doing:
//  - every lifting strip is a horseshoe vortex: a bound vortex along its quarter chord plus two legs trailing
//    downstream. Its circulation comes from the strip's actual lift (Kutta-Joukowski, Γ = L / (ρ V b)), so the air
//    speeds up over a lifting wing, is pushed down behind it, and the legs of neighbouring strips sum into the
//    wingtip vortices. A stalled strip's lift (and so its swirl) collapses exactly as it does in flight.
//  - every body (fuselage, cockpit, engine, pod) is a Rankine body: a source at its nose and a sink at its tail, sized
//    to its thickness, so the smoke parts around it.
//  - near a strip the smoke slides along the skin instead of passing through it; over a stalled strip it lifts off the
//    suction side and tumbles (a flag the shader turns into chaotic motion).
//  - above Mach 1 nothing upstream of the nose's Mach cone is disturbed (the shock), so the lines run straight until
//    they cross it.
// Everything is computed in the body frame at unit free-stream speed (the pattern depends on the lift coefficients,
// not on the speed), traced once when the state changes (a few lines per frame, inside a time budget), and drawn as
// camera-facing ribbons whose smoke puffs the vertex shader moves along at the local speed. Steady state costs nothing
// on the CPU; nothing here recompiles a shader (colour mode, pulses and turbulence are uniforms or attributes).
import * as THREE from 'three';

const FOUR_PI = 4 * Math.PI;
const _q = new THREE.Quaternion(), _qi = new THREE.Quaternion(), _v = new THREE.Vector3(), _w = new THREE.Vector3();

// Lines per quality tier: [rake columns, rake rows, smoke probes per wingtip, points per line]
export const FLOW_TIERS = { low: [7, 4, 4, 64], medium: [9, 5, 6, 88], high: [11, 6, 8, 104], ultra: [13, 7, 10, 120] };

const VERT = /* glsl */`
uniform float uTime, uFlow, uWidth, uMode, uTurbAmp, uSpacing;
attribute vec3 aTan;
attribute float aSide, aSeed;
attribute vec4 aData; // x: time of flight (world m at unit speed), y: speed / free stream, z: turbulence 0-1, w: alpha
varying vec3 vCol;
varying float vA, vEdge, vPhase;
vec3 ramp(float t) { // blue, cyan, green (the free stream), yellow, red
  t = clamp(t, 0.0, 1.0);
  vec3 a = vec3(0.15, 0.3, 1.0), b = vec3(0.15, 0.85, 1.0), c = vec3(0.3, 1.0, 0.45), d = vec3(1.0, 0.9, 0.15), e = vec3(1.0, 0.2, 0.1);
  return t < 0.25 ? mix(a, b, t * 4.0) : t < 0.5 ? mix(b, c, t * 4.0 - 1.0) : t < 0.75 ? mix(c, d, t * 4.0 - 2.0) : mix(d, e, t * 4.0 - 3.0);
}
void main() {
  vec3 p = position;
  float tb = aData.z;
  if (tb > 0.001) { // separated flow: smoke tumbles
    float k = aData.x;
    p += tb * uTurbAmp * vec3(sin(k * 1.3 + uTime * 5.0 + aSeed * 7.0) + 0.4 * sin(k * 2.9 - uTime * 8.0),
                              sin(k * 1.1 + uTime * 6.0 + aSeed * 3.1) + 0.4 * sin(k * 2.3 + uTime * 9.0 + aSeed),
                              0.6 * sin(k * 1.7 + uTime * 4.0 + aSeed * 5.3));
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec3 t = (modelViewMatrix * vec4(aTan, 0.0)).xyz;
  vec3 side = cross(t, normalize(mv.xyz));
  float sl = length(side);
  side = sl > 1e-5 ? side / sl : vec3(0.0, 1.0, 0.0);
  float w = uWidth * (1.0 + tb * 1.5) * (aSeed > 1.5 ? 1.7 : 1.0); // (wingtip probes: thicker)
  mv.xyz += side * aSide * w;
  gl_Position = projectionMatrix * mv;
  float s = aData.y;
  vec3 col = aSeed > 1.5 ? vec3(0.62, 0.86, 1.0) : vec3(0.93, 0.95, 1.0); // (wingtip probes: a touch of blue smoke)
  if (uMode > 0.5 && uMode < 1.5) col = ramp(0.5 + (s - 1.0) * 2.6);
  else if (uMode > 1.5) col = ramp(0.5 + 0.75 * clamp(1.0 - s * s, -0.66, 0.66)); // pressure: Cp = 1 - (v/V)², high = red, suction = blue
  vCol = mix(col, vec3(0.75, 0.72, 0.7), tb * (uMode < 0.5 ? 0.6 : 0.25));
  vA = aData.w;
  vEdge = aSide;
  vPhase = aData.x / uSpacing - uFlow + aSeed * 3.7;
}`;
const FRAG = /* glsl */`
uniform float uOpacity;
varying vec3 vCol;
varying float vA, vEdge, vPhase;
void main() {
  float f = fract(vPhase);
  float puff = smoothstep(0.0, 0.18, f) * smoothstep(0.85, 0.4, f);
  float edge = 1.0 - vEdge * vEdge;
  float a = vA * edge * (0.28 + 0.72 * puff) * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol * (0.85 + 0.35 * puff), a);
}`;

const CONE_VERT = /* glsl */`
varying vec2 vUv; varying vec3 vN, vV;
void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`;
const CONE_FRAG = /* glsl */`
uniform float uTime, uStrength; uniform vec3 uColor;
varying vec2 vUv; varying vec3 vN, vV;
void main() {
  float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0); // edge-on: a bright line, like a schlieren photo
  float along = vUv.y;                       // 0 at the apex end .. 1 at the far end (see shockCone)
  float fade = smoothstep(0.0, 0.04, along) * (1.0 - smoothstep(0.6, 1.0, along));
  float ripple = 0.65 + 0.35 * sin(along * 90.0 - uTime * 14.0);
  float rays = 0.75 + 0.25 * sin(vUv.x * 6.2832 * 24.0);
  float a = uStrength * fade * (0.03 + rim) * ripple * rays;
  gl_FragColor = vec4(uColor * (0.6 + rim), a);
}`;

// open cone, apex at the origin, opening along +Z to radius 1 at z = 1; uv.y runs 0 (apex) to 1 (open end)
function shockCone() {
  const g = new THREE.CylinderGeometry(0, 1, 1, 64, 8, true);
  g.translate(0, -0.5, 0); g.rotateX(-Math.PI / 2); // apex at origin, base at z=+1
  const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  return g;
}

export class TunnelFlow {
  // tier: FLOW_TIERS key. box: the tunnel's test section in world space ({ x0, x1, y0, y1, zRake, zEnd }).
  constructor(tier, box) {
    this.tierKey = FLOW_TIERS[tier] ? tier : 'medium';
    this.box = box;
    this.group = new THREE.Group(); this.group.name = 'tunnel-flow';
    this.uniforms = { uTime: { value: 0 }, uFlow: { value: 0 }, uWidth: { value: 0.035 }, uMode: { value: 0 }, uTurbAmp: { value: 0.3 }, uSpacing: { value: 1.1 }, uOpacity: { value: 1 } };
    this.mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.coneU = { uTime: this.uniforms.uTime, uStrength: { value: 0.8 }, uColor: { value: new THREE.Color(0.75, 0.88, 1.0) } };
    this.coneMat = new THREE.ShaderMaterial({ vertexShader: CONE_VERT, fragmentShader: CONE_FRAG, uniforms: this.coneU, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    const cg = shockCone();
    this.cones = [new THREE.Mesh(cg, this.coneMat), new THREE.Mesh(cg, this.coneMat)];
    for (const c of this.cones) { c.renderOrder = 4; c.frustumCulled = false; this.group.add(c); }
    this.out = new Float64Array(4);
    this.flowT = 0; this.visible = true; this.cursor = 0; this.dirty = true; this.busyMs = 0; this.lastTrace = 0;
  }

  // The vehicle: an Aircraft (for its strips and bodies), the model's world scale s and centre C (world position of
  // the CoM).
  setModel(ac, s, C) {
    this.ac = ac; this.s = s; this.C = C.clone();
    // bodies: everything that isn't a wing or gear, as an oriented box (centre, axes, half sizes) in the body frame
    this.bodies = [];
    for (const p of ac.parts) {
      if (!p.alive || p.d.wing || p.d.cat === 'gear' || !p.size) continue;
      const half = p.size.clone().multiplyScalar(0.5);
      if (half.x * half.y * half.z < 0.002) continue;
      const ax = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].map((v) => v.applyMatrix4(p.rot));
      const h = [half.x, half.y, half.z], k = h.indexOf(Math.max(...h)), others = h.filter((_, i) => i !== k);
      const c = p.info.center.clone().applyMatrix4(p.m).sub(ac.com);
      this.bodies.push({ c, ax, h, axis: ax[k], len: h[k], rad: Math.max(0.05, (others[0] + others[1]) / 2) });
    }
    // lifting strips (body frame, relative to the CoM)
    this.strips = [];
    for (const p of ac.parts) for (const s0 of p.surfaces) {
      const b = Math.max(0.05, s0.area / Math.max(0.05, s0.chord));
      this.strips.push({ src: s0, part: p, c: s0.pos.clone().sub(ac.com), n: s0.n.clone(), f: s0.f.clone(), sp: s0.s.clone(), b, chord: s0.chord, G: 0, sep: 0, isTip: false });
    }
    // the outermost strip of each wing half: smoke probes there show the tip vortex
    let maxX = 0; for (const st of this.strips) maxX = Math.max(maxX, Math.abs(st.c.x) + st.b / 2);
    this.span = maxX * 2;
    const tips = this.strips.filter((st) => st.part.d.cat === 'wing' && Math.abs(st.n.y) > 0.5).sort((a, b) => Math.abs(b.c.x) + b.b / 2 - (Math.abs(a.c.x) + a.b / 2));
    const L = tips.find((st) => st.c.x < -0.3), R = tips.find((st) => st.c.x > 0.3);
    this.tips = [L, R].filter(Boolean); for (const t of this.tips) t.isTip = true;
    // size of the model (body frame): for the Mach cone apex and how far lines are traced
    this.hull = []; for (const p of ac.parts) for (const h of p.hull) this.hull.push(h.clone().sub(ac.com));
    let r = 1; for (const h of this.hull) r = Math.max(r, h.length()); this.R = r;
    this.meanChord = this.strips.length ? this.strips.reduce((a, st) => a + st.chord, 0) / this.strips.length : 1;
    this.buildLines();
  }

  // seeds (world space) and the ribbon buffers
  buildLines() {
    const [cols, rows, perTip, P] = FLOW_TIERS[this.tierKey], bx = this.box, s = this.s;
    const halfW = Math.min((bx.x1 - bx.x0) / 2 - 0.4, Math.max(1.2, this.span * s * 0.62)), halfH = Math.min((bx.y1 - bx.y0) / 2 - 0.4, Math.max(1.0, this.R * s * 0.45));
    const seeds = [];
    // rows bunched around the main wing's height (where the action is), columns a little wider than the span
    const wings = this.strips.filter((st) => st.part.d.cat === 'wing' && Math.abs(st.n.y) > 0.5);
    const yw = THREE.MathUtils.clamp(wings.length ? wings.reduce((a, st) => a + st.c.y, 0) / wings.length * s : 0, -halfH * 0.5, halfH * 0.5);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const u = (2 * (j + 0.5)) / rows - 1 + 0.18 / rows, y = yw + Math.sign(u) * Math.abs(u) ** 1.9 * halfH * 1.2;
      const x = -halfW + (2 * halfW) * (i + 0.5 + (j % 2 ? 0.22 : -0.22)) / cols;
      seeds.push({ w: new THREE.Vector3(this.C.x + x, this.C.y + y, bx.zRake), tip: null });
    }
    this.rakeSeeds = seeds.map((sd) => sd.w.clone());
    for (const t of this.tips) for (let k = 0; k < perTip; k++) seeds.push({ w: null, tip: t, k, n: perTip });
    this.seeds = seeds; this.P = P;
    const N = seeds.length, V = N * P * 2;
    this.N = N;
    const pos = new Float32Array(V * 3), tan = new Float32Array(V * 3), data = new Float32Array(V * 4), side = new Float32Array(V), seed = new Float32Array(V);
    const idx = new Uint32Array(N * (P - 1) * 6);
    let o = 0;
    for (let l = 0; l < N; l++) {
      const sd = Math.random() + (seeds[l].tip ? 2 : 0);
      for (let i = 0; i < P; i++) { const v = (l * P + i) * 2; side[v] = -1; side[v + 1] = 1; seed[v] = seed[v + 1] = sd; }
      for (let i = 0; i < P - 1; i++) { const a = (l * P + i) * 2; idx[o++] = a; idx[o++] = a + 1; idx[o++] = a + 2; idx[o++] = a + 1; idx[o++] = a + 3; idx[o++] = a + 2; }
    }
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aTan = new THREE.BufferAttribute(tan, 3).setUsage(THREE.DynamicDrawUsage);
    this.aData = new THREE.BufferAttribute(data, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos); g.setAttribute('aTan', this.aTan); g.setAttribute('aData', this.aData);
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1)); g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(this.C.clone(), 40);
    if (this.mesh) { this.group.remove(this.mesh); this.mesh.geometry.dispose(); }
    this.mesh = new THREE.Mesh(g, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 3;
    this.group.add(this.mesh);
    this.active = N; this.dirty = true; this.cursor = 0;
    this.uniforms.uWidth.value = 0.02 + 0.004 * (halfW / 4);
  }
  // fewer lines when the frame rate struggles (the rest just stop drawing: no buffers are rebuilt)
  setActive(frac) {
    const n = Math.max(8, Math.round(this.N * frac));
    if (n === this.active) return;
    this.active = n; this.mesh.geometry.setDrawRange(0, n * (this.P - 1) * 6);
  }

  // The aerodynamic state to draw: q (body to world), mach, and the per-strip probe from Aircraft.aeroLoads (lift per
  // strip, stalled or not). rho and V: the air, to turn lift into circulation. canStall: false in Arcade air (no lift loss).
  setState(q, mach, probe, rho, V, canStall = true) {
    this.q = q.clone(); _qi.copy(q).invert();
    this.U = new THREE.Vector3(0, 0, 1).applyQuaternion(_qi); // free stream, body frame (the tunnel blows towards +Z)
    this.mach = mach;
    const qv = Math.max(1e-6, rho * V * V);
    let key = `${q.x.toFixed(3)},${q.y.toFixed(3)},${q.z.toFixed(3)},${q.w.toFixed(3)}|${mach > 1 ? mach.toFixed(2) : mach > 0.8 ? 'T' : 'S'}|`;
    const byStrip = new Map(); for (const e of probe) byStrip.set(e.s, e);
    for (const st of this.strips) {
      const e = byStrip.get(st.src);
      if (!e || !st.part.alive) { st.G = 0; st.sep = 0; continue; }
      // lift direction: the strip normal, square to the flow
      const ld = _v.copy(st.n).addScaledVector(this.U, -st.n.dot(this.U)); const ll = ld.length();
      const k = ll > 1e-3 ? _w.copy(this.U).cross(st.sp).dot(ld.divideScalar(ll)) : 0;
      st.G = Math.abs(k) > 0.25 ? THREE.MathUtils.clamp(e.L / (qv * st.b * k), -3 * st.chord, 3 * st.chord) : 0;
      st.sep = e.stalled && canStall && Math.abs(e.a) < 1.5 ? Math.sign(e.aEff) || 1 : 0;
      key += `${st.G.toFixed(2)}${st.sep}`;
    }
    // supersonic: the nose (most upstream point) is the Mach cone's apex, the tail (most downstream) the tail shock's
    let lo = Infinity, hi = -Infinity; this.nose = new THREE.Vector3(); this.tail = new THREE.Vector3();
    for (const h of this.hull) { const d = h.dot(this.U); if (d < lo) { lo = d; this.nose.copy(h); } if (d > hi) { hi = d; this.tail.copy(h); } }
    if (key !== this.key) { this.key = key; this.dirty = true; this.dirtyAt = performance.now(); this.passAt = -1; }
    this.updateCones();
  }

  updateCones() {
    const M = this.mach, on = M > 1.0;
    for (const c of this.cones) c.visible = on && this.visible;
    if (!on) return;
    const mu = Math.asin(1 / M), t = Math.tan(mu), s = this.s;
    [this.nose, this.tail].forEach((p, i) => {
      const c = this.cones[i], w = p.clone().applyQuaternion(this.q).multiplyScalar(s).add(this.C);
      const L = Math.max(2, this.box.zEnd + 4 - w.z);
      c.position.copy(w); c.scale.set(t * L, t * L, L);
    });
    this.coneU.uStrength.value = 0.32 + 0.2 * Math.min(1, (M - 1) * 2);
  }

  // ---- the flow field (body frame, unit free stream) ----
  // u at point (x, y, z) into out[0..2]; out[3] = how separated the flow is there (0-1)
  vel(x, y, z, out) {
    const U = this.U; let ux = 0, uy = 0, uz = 0, sep = 0;
    const dx = U.x, dy = U.y, dz = U.z;
    for (const st of this.strips) {
      const G = st.G; if (G === 0) continue;
      const hb = st.b / 2, sx = st.sp.x * hb, sy = st.sp.y * hb, sz = st.sp.z * hb;
      const ax = st.c.x - sx, ay = st.c.y - sy, az = st.c.z - sz, bx = st.c.x + sx, by = st.c.y + sy, bz = st.c.z + sz;
      const rc2 = (0.12 * st.chord + 0.04) ** 2, k0 = G / FOUR_PI;
      // bound segment A -> B
      { const r1x = x - ax, r1y = y - ay, r1z = z - az, r2x = x - bx, r2y = y - by, r2z = z - bz, r0x = bx - ax, r0y = by - ay, r0z = bz - az;
        const cx = r1y * r2z - r1z * r2y, cy = r1z * r2x - r1x * r2z, cz = r1x * r2y - r1y * r2x;
        const n1 = Math.sqrt(r1x * r1x + r1y * r1y + r1z * r1z) + 1e-9, n2 = Math.sqrt(r2x * r2x + r2y * r2y + r2z * r2z) + 1e-9, r02 = r0x * r0x + r0y * r0y + r0z * r0z;
        const k = k0 * ((r0x * r1x + r0y * r1y + r0z * r1z) / n1 - (r0x * r2x + r0y * r2y + r0z * r2z) / n2) / (cx * cx + cy * cy + cz * cz + rc2 * r02);
        ux += k * cx; uy += k * cy; uz += k * cz; }
      // trailing legs: in from far downstream to A (sign -), out from B to far downstream (sign +)
      for (let leg = 0; leg < 2; leg++) {
        const px = leg ? bx : ax, py = leg ? by : ay, pz = leg ? bz : az, sg = leg ? 1 : -1;
        const rx = x - px, ry = y - py, rz = z - pz, n = Math.sqrt(rx * rx + ry * ry + rz * rz) + 1e-9;
        const cx = dy * rz - dz * ry, cy = dz * rx - dx * rz, cz = dx * ry - dy * rx;
        const k = sg * k0 * (1 + (dx * rx + dy * ry + dz * rz) / n) / (cx * cx + cy * cy + cz * cz + rc2);
        ux += k * cx; uy += k * cy; uz += k * cz;
      }
    }
    // bodies: source at the upstream end, sink at the downstream end
    for (const b of this.bodies) {
      const al = b.axis.x * dx + b.axis.y * dy + b.axis.z * dz, sg = al >= 0 ? 1 : -1, off = Math.max(0, b.len - b.rad * 0.7);
      const Q = b.rad * b.rad * Math.PI * (0.35 + 0.65 * Math.abs(al)) / FOUR_PI, e2 = (b.rad * 0.5) ** 2;
      for (let end = 0; end < 2; end++) {
        const m = end ? -sg : sg; // source upstream (-sg along the axis), sink downstream
        const px = b.c.x - b.axis.x * off * m, py = b.c.y - b.axis.y * off * m, pz = b.c.z - b.axis.z * off * m;
        const rx = x - px, ry = y - py, rz = z - pz, d2 = rx * rx + ry * ry + rz * rz + e2, k = (end ? -Q : Q) / (d2 * Math.sqrt(d2));
        ux += k * rx; uy += k * ry; uz += k * rz;
      }
    }
    // supersonic: no disturbance outside the nose's Mach cone
    if (this.mach > 1) {
      const t = 1 / Math.sqrt(this.mach * this.mach - 1), px = x - this.nose.x, py = y - this.nose.y, pz = z - this.nose.z;
      const xa = px * dx + py * dy + pz * dz, rr = Math.sqrt(Math.max(0, px * px + py * py + pz * pz - xa * xa));
      const m = Math.min(1, Math.max(0, (xa * t - rr) / (0.08 * this.R + 0.15 * xa * t)));
      ux *= m; uy *= m; uz *= m;
    }
    ux += dx; uy += dy; uz += dz;
    // near a strip: slide along the skin, or (stalled, suction side) lift off it
    for (const st of this.strips) {
      const c = st.chord, rx = x - st.c.x, ry = y - st.c.y, rz = z - st.c.z;
      const eta = rx * st.sp.x + ry * st.sp.y + rz * st.sp.z; if (Math.abs(eta) > st.b * 0.55) continue;
      const zeta = rx * st.n.x + ry * st.n.y + rz * st.n.z, hz = 0.5 * c; if (Math.abs(zeta) > (st.sep ? 1.4 * c : hz)) continue;
      const xi = rx * st.f.x + ry * st.f.y + rz * st.f.z; // + forward; LE at +0.25c, TE at -0.75c
      if (xi > 0.45 * c || xi < -1.1 * c) continue;
      const wc = Math.min(1, (0.45 * c - xi) / (0.2 * c), (xi + 1.1 * c) / (0.35 * c));
      if (st.sep && zeta * st.sep > 0) { // separated: the smoke leaves the surface and tumbles
        const w = wc * (1 - Math.abs(zeta) / (1.4 * c)) * Math.min(1, (0.25 * c - xi) / (0.4 * c) + 0.2);
        if (w > 0) { ux += st.n.x * st.sep * 0.45 * w; uy += st.n.y * st.sep * 0.45 * w; uz += st.n.z * st.sep * 0.45 * w; sep = Math.max(sep, w); }
        continue;
      }
      if (Math.abs(zeta) > hz) continue;
      const w = wc * (1 - Math.abs(zeta) / hz) ** 2, un = ux * st.n.x + uy * st.n.y + uz * st.n.z;
      ux -= st.n.x * un * w; uy -= st.n.y * un * w; uz -= st.n.z * un * w;
    }
    out[0] = ux; out[1] = uy; out[2] = uz; out[3] = sep;
    return out;
  }
  inside(x, y, z) {
    for (const b of this.bodies) {
      const rx = x - b.c.x, ry = y - b.c.y, rz = z - b.c.z;
      if (Math.abs(rx * b.ax[0].x + ry * b.ax[0].y + rz * b.ax[0].z) < b.h[0] * 0.92 && Math.abs(rx * b.ax[1].x + ry * b.ax[1].y + rz * b.ax[1].z) < b.h[1] * 0.92
        && Math.abs(rx * b.ax[2].x + ry * b.ax[2].y + rz * b.ax[2].z) < b.h[2] * 0.92) return true;
    }
    return false;
  }

  // trace line l through the current field and write it into the buffers
  trace(l) {
    const P = this.P, s = this.s, sd = this.seeds[l], o = this.out, q = this.q, C = this.C, bx = this.box;
    const pos = this.aPos.array, tan = this.aTan.array, data = this.aData.array;
    // start point, body frame
    const p = new THREE.Vector3();
    if (sd.tip) { // a smoke probe in a ring just behind the wingtip's trailing edge
      const st = sd.tip, a = (sd.k / sd.n) * Math.PI * 2, r = 0.22 * st.chord + 0.05, side = Math.sign(st.c.x) || 1;
      p.copy(st.c).addScaledVector(st.sp, (st.b / 2) * Math.sign(st.sp.x * side || 1)).addScaledVector(st.f, -0.8 * st.chord);
      p.addScaledVector(st.n, Math.cos(a) * r).addScaledVector(_v.copy(st.n).cross(this.U).normalize(), Math.sin(a) * r);
    } else p.copy(sd.w).sub(C).divideScalar(s).applyQuaternion(_qi);
    const ds = (bx.zEnd - bx.zRake + 6) / s / (P - 1);
    let tof = 0, turb = 0, sepDist = 0, done = false;
    const w = new THREE.Vector3(), t = new THREE.Vector3(), prev = new THREE.Vector3();
    for (let i = 0; i < P; i++) {
      const v = (l * P + i) * 2;
      let spd = 1, sep = 0;
      if (!done) {
        this.vel(p.x, p.y, p.z, o); spd = Math.hypot(o[0], o[1], o[2]) || 1e-6; sep = o[3];
        t.set(o[0], o[1], o[2]).divideScalar(spd);
        if (sep > 0.05) { turb = Math.max(turb, Math.min(1, sep * 1.6)); sepDist = 0; }
        else if (turb > 0) { sepDist += ds; turb = Math.max(turb * (1 - ds / (14 * this.meanChord)), 0.25 * Math.exp(-sepDist / (10 * this.meanChord))); if (turb < 0.02) turb = 0; }
      }
      w.copy(p).applyQuaternion(q).multiplyScalar(s).add(C);
      if (w.z > bx.zEnd || w.y < bx.y0 + 0.05 || w.y > bx.y1 - 0.05 || w.x < bx.x0 + 0.05 || w.x > bx.x1 - 0.05) done = true;
      if (done && i > 0) w.copy(prev);
      const tw = _w.copy(t).applyQuaternion(q);
      const hidden = done || this.inside(p.x, p.y, p.z);
      const fade = Math.min(1, i / 4, (P - 1 - i) / 6);
      for (let k = 0; k < 2; k++) {
        pos[(v + k) * 3] = w.x; pos[(v + k) * 3 + 1] = w.y; pos[(v + k) * 3 + 2] = w.z;
        tan[(v + k) * 3] = tw.x; tan[(v + k) * 3 + 1] = tw.y; tan[(v + k) * 3 + 2] = tw.z;
        data[(v + k) * 4] = tof * s; data[(v + k) * 4 + 1] = spd; data[(v + k) * 4 + 2] = turb; data[(v + k) * 4 + 3] = hidden || (this.tipsOnly && !sd.tip) ? 0 : fade * (sd.tip ? 0.9 : 0.62);
      }
      prev.copy(w);
      if (done) continue;
      // midpoint step along the streamline (unit arc length ds), keeping time of flight
      const mx = p.x + t.x * ds * 0.5, my = p.y + t.y * ds * 0.5, mz = p.z + t.z * ds * 0.5;
      this.vel(mx, my, mz, o); const sm = Math.hypot(o[0], o[1], o[2]) || 1e-6;
      p.x += (o[0] / sm) * ds; p.y += (o[1] / sm) * ds; p.z += (o[2] / sm) * ds;
      tof += ds / sm;
    }
  }

  // Animate, and retrace lines while the state has changed (within budgetMs this frame). Returns ms spent tracing.
  update(dt, V, budgetMs = 4) {
    const u = this.uniforms;
    u.uTime.value += dt;
    // smoke puffs travel at a watchable pace: faster with the wind, but not 300 m/s
    const vis = 2.2 + 7.5 * Math.sqrt(Math.min(3.2, V / 340));
    u.uFlow.value += dt * vis / u.uSpacing.value;
    u.uTurbAmp.value = Math.min(0.6, 0.35 * this.meanChord * this.s + 0.05);
    if (!this.dirty || !this.q) { this.busyMs = 0; return 0; }
    const t0 = performance.now(); let n = 0;
    if (this.cursor >= this.active) this.cursor = 0;
    const first = this.cursor;
    while (n < this.active) {
      if (this.cursor === 0) this.passAt = performance.now();
      this.trace(this.cursor); n++;
      this.cursor = (this.cursor + 1) % this.active;
      if (this.cursor === 0 && this.dirtyAt < this.passAt) { this.dirty = false; break; } // a whole pass since the last change
      if (performance.now() - t0 > budgetMs) break;
    }
    // upload just the lines that changed (one or two contiguous ranges)
    const per = this.P * 2, last = (first + n - 1) % this.active;
    for (const a of [this.aPos, this.aTan, this.aData]) {
      const k = a.itemSize;
      if (last >= first) a.addUpdateRange(first * per * k, n * per * k);
      else { a.addUpdateRange(first * per * k, (this.active - first) * per * k); a.addUpdateRange(0, (last + 1) * per * k); }
      a.needsUpdate = true;
    }
    this.lastTrace = performance.now();
    return (this.busyMs = performance.now() - t0);
  }
  setMode(m) { this.uniforms.uMode.value = m; }
  setVisible(on) { this.visible = on; this.mesh.visible = on; this.updateCones(); }
  dispose() { this.mesh?.geometry.dispose(); this.cones[0].geometry.dispose(); }
}
