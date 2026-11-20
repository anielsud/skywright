// Landing gear geometry check, evaluated in the game page by gearcheck.py (the body of an async function of ARG).
// Builds every preset (as is, resized, mirrored) and seeded random player builds (gear, floats and skids dropped on
// bodies, wings, wingtips, pods and flaps the way the hangar places them; resized, rotated, mirrored), then checks the
// routed struts (gearRoute.js) against the real built meshes with double-sided rays:
//   - no leg, knee, brace or float strut passes through any part (control surfaces included) on its way up,
//   - every leg and brace ends on a solid surface (not in the air, not on a control surface),
//   - every wheel stands upright and rolls straight ahead (axle level and square to the flight direction),
//   - mirrored pairs mirror (to 1 cm: skin triangles are not mirror images), a centreline gear is symmetric,
//   - no gear part has broken (NaN) geometry, and building raised no warnings.
// Builds from before gearRoute.js are measured too (legacyRoute), for a before/after count: gearcheck.py --url.
const S = window.__sky, THREE = S.THREE, PARTS = S.PARTS, V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const { buildDesign } = await import('/src/hangar.js');
const { newPart, mirroredOf } = await import('/src/design.js');
const seed = ARG?.seed ?? 1, nRandom = ARG?.random ?? 20;

// ---------- double-sided rays against a mesh list ----------
const _a = V(), _b = V(), _c = V(), _p = V(), _ray = new THREE.Ray(), _inv = new THREE.Matrix4(), _box = new THREE.Box3();
function hits(meshes, from, dir, far) {
  const out = [];
  for (const m of meshes) {
    const g = m.geometry; if (!g.userData.gcBox) { g.computeBoundingBox(); g.userData.gcBox = true; } // (fresh: a stale box would hide a mesh)
    _inv.copy(m.matrixWorld).invert(); _ray.set(from, dir).applyMatrix4(_inv);
    if (!_ray.intersectsBox(g.boundingBox)) continue;
    const pos = g.attributes.position, idx = g.index, n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i += 3) {
      _a.fromBufferAttribute(pos, idx ? idx.getX(i) : i); _b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1); _c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2);
      if (!_ray.intersectTriangle(_a, _b, _c, false, _p)) continue;
      const d = _p.applyMatrix4(m.matrixWorld).distanceTo(from);
      if (d <= far) out.push({ d, m });
    }
  }
  return out.sort((x, y) => x.d - y.d);
}

// Builds from before gearRoute.js (to measure the old code with the same checks): the leg ran straight from the
// wheel up to the part origin, float and skid posts straight up from the float / skid to the origin's height.
function legacyRoute(o, gi) {
  const W = o.matrixWorld, P = (x, y, z) => V(x, y, z).applyMatrix4(W);
  if (gi.float) { const L = gi.flen, y = gi.skid ? -1 : -0.68, zs = gi.skid ? [-L * 0.25, L * 0.25] : [-L * 0.18, L * 0.18]; return { legs: zs.map((z) => ({ a: P(0, y, z), top: P(0, 0, z) })), braces: [] }; }
  return { legs: [{ a: P(0, -gi.len + gi.r * 1.05, 0), top: P(0, 0, 0) }], braces: [] };
}

// ---------- one design ----------
function check(d, label) {
  const warns = [], ow = console.warn; console.warn = (...a) => { warns.push(a.map(String).join(' ')); ow(...a); };
  const root = new THREE.Group(); let det;
  try { det = buildDesign(d, root); } finally { console.warn = ow; }
  root.updateMatrixWorld(true);
  const objs = det.parts, bad = [], movable = new Set(), gearSet = new Set(), meshes = [], owner = new Map();
  const shown = (m) => { for (let o = m; o && o !== root; o = o.parent) if (!o.visible) return false; return true; };
  objs.forEach((o, i) => {
    if (!o) return; const def = PARTS[d.parts[i].id];
    for (const u of [o.userData, o.children[0]?.userData || {}]) for (const c of [...(u.controls || []), ...(u.slats || []), ...(u.spoilers || [])]) c.obj.traverse((m) => movable.add(m));
    if (def.gear || def.cat === 'rotor') { o.traverse((m) => gearSet.add(m)); return; }
    const skip = new Set(); for (const k of ['prop', 'fan', 'flame', 'flameCore']) o.userData[k]?.traverse((m) => skip.add(m));
    o.traverse((m) => { if (m.isMesh && !skip.has(m) && shown(m) && !m.material.transparent && !m.userData.isDisc && !m.userData.near && m.material.blending !== THREE.AdditiveBlending) { meshes.push(m); owner.set(m, i); } });
  });
  const name = (m) => `${d.parts[owner.get(m)]?.id}${movable.has(m) ? ' (control surface)' : ''}`;
  for (const w of warns) bad.push(`build warning: ${w}`);
  // a segment that must not touch anything, and one that must end on a solid skin
  const free = (a, b, what) => {
    const dir = b.clone().sub(a), L = dir.length(); if (L < 1e-4) return; dir.normalize();
    const h = hits(meshes, a, dir, L - 0.005).filter((x) => x.d > 0.005);
    if (h.length) bad.push(`${what} crosses ${name(h[0].m)} at ${h[0].d.toFixed(2)} of ${L.toFixed(2)} m`);
  };
  const ends = (a, b, what) => {
    const dir = b.clone().sub(a), L = dir.length(); dir.normalize();
    const h = hits(meshes, a, dir, L + 0.25).filter((x) => x.d > 1e-4);
    if (!h.length || h[0].d > L + 0.02) { bad.push(`${what} ends in the air (${h.length ? (h[0].d - L).toFixed(2) + ' m short of ' + name(h[0].m) : 'nothing above'})`); return; }
    if (h[0].d < L - 0.1) bad.push(`${what} passes through ${name(h[0].m)} ${(L - h[0].d).toFixed(2)} m before its end`);
    else if (movable.has(h[0].m)) bad.push(`${what} ends on ${name(h[0].m)}`);
  };
  const routed = [];
  objs.forEach((o, i) => {
    if (!o) return; const p = d.parts[i], def = PARTS[p.id]; if (!def.gear || def.cat === 'car' || def.cat === 'bike') return; // (car and bike wheels: meshcheck's floating-parts check)
    const tag = `#${i} ${p.id}`, R = o.userData.gearRoute || legacyRoute(o, def.gear);
    if (!R) { bad.push(`${tag}: not routed`); return; }
    routed.push({ i, p, R });
    R.legs.forEach((l, k) => { if (l.knee) free(l.a, l.knee, `${tag} leg ${k} (below knee)`); ends(l.knee || l.a, l.top, `${tag} leg ${k}`); });
    R.braces.forEach((b, k) => ends(b.a, b.b, `${tag} brace ${k}`));
    (R.free || []).forEach((s, k) => free(s.a, s.b, `${tag} strut ${k}`));
    // wheels: axle level and square to the flight direction
    const ws = o.userData.wheels; if (ws) for (const c of ws.children) if (c.isGroup) {
      const ax = V(1, 0, 0).transformDirection(c.matrixWorld);
      if (Math.abs(ax.y) > 2e-3 || Math.abs(ax.z) > 2e-3) bad.push(`${tag}: wheel not upright (axle ${ax.toArray().map((v) => v.toFixed(3))})`);
    }
  });
  // symmetry
  const flat = (R) => [...R.legs.flatMap((l) => [l.a, l.knee, l.top]), ...R.braces.flatMap((b) => [b.a, b.b]), ...(R.free || []).flatMap((s) => [s.a, s.b])].filter(Boolean);
  for (const A of routed) {
    const x = A.p.pos[0];
    if (Math.abs(x) < 0.05) { // centreline, not turned sideways: the set of points is symmetric about the part's own plane
      if (Math.abs(A.p.quat[1]) > 1e-6 || Math.abs(A.p.quat[2]) > 1e-6) continue;
      const P = flat(A.R), worst = Math.max(0, ...P.map((q) => Math.min(...P.map((r) => r.distanceTo(V(2 * x - q.x, q.y, q.z))))));
      if (worst > 0.01) bad.push(`#${A.i} ${A.p.id}: centreline gear not symmetric (${(worst * 1000).toFixed(1)} mm)`);
      continue;
    }
    if (x < 0) continue;
    const B = routed.find((r) => r.p.id === A.p.id && Math.abs(r.p.pos[0] + x) < 0.02 && Math.abs(r.p.pos[1] - A.p.pos[1]) < 0.02 && Math.abs(r.p.pos[2] - A.p.pos[2]) < 0.02);
    if (!B) continue;
    const PA = flat(A.R), PB = flat(B.R);
    if (PA.length !== PB.length) { bad.push(`#${A.i}/#${B.i} ${A.p.id}: mirrored pair routed differently (${PA.length} vs ${PB.length} points)`); continue; }
    const worst = Math.max(...PA.map((q, k) => PB[k].distanceTo(V(-q.x, q.y, q.z))));
    if (worst > 0.01) bad.push(`#${A.i}/#${B.i} ${A.p.id}: mirrored pair differs by ${(worst * 1000).toFixed(1)} mm`);
  }
  // no broken geometry on any gear part (NaN positions render as black blocks)
  objs.forEach((o, i) => { if (o && PARTS[d.parts[i].id].gear) o.traverse((m) => { if (m.isMesh && m.geometry.attributes.position.array.some((v) => !Number.isFinite(v))) bad.push(`#${i} ${d.parts[i].id}: NaN in its geometry`); }); });
  root.traverse((o) => o.geometry?.dispose());
  return { label, gear: routed.length, bad, ...(bad.length ? { design: d } : {}) };
}

// ---------- variants ----------
const clone = (d) => JSON.parse(JSON.stringify(d));
const mirrored = (d) => ({ ...clone(d), parts: d.parts.map((p) => mirroredOf(clone(p))) });
function resized(d) {
  const e = clone(d);
  for (const p of e.parts) { const def = PARTS[p.id]; const s = p.scale || [1, 1, 1]; const k = def.gear ? [1.35, 1.35, 1.35] : def.wing ? [1.15, 1.2, 1.2] : def.cat === 'fuselage' ? [1.15, 1.15, 1.1] : [1, 1, 1]; p.scale = s.map((v, j) => v * k[j]); }
  return e;
}

// ---------- random player builds ----------
function rng(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const BODIES = ['fus_light', 'fus_sport', 'fus_fighter', 'fus_airliner', 'fus_cargo', 'fus_glider', 'fus_pod', 'fus_heli'];
const WINGS = ['w_trainer', 'w_taper', 'w_ellipse', 'w_swept', 'w_delta', 'w_glider', 'w_airliner', 'w_stub'];
const GEAR = ['g_nose', 'g_main', 'g_tail', 'g_bush', 'g_retract', 'g_retract_nose', 'g_bogie', 'g_float', 'g_skid'];
function randomBuild(rand, k) {
  const pick = (a) => a[Math.floor(rand() * a.length)];
  // (like the hangar with Mirror on: the copy hangs off the mirror image of the parent, when there is one)
  const parts = [], add = (p) => (parts.push(p), parts.length - 1), partner = (j) => { const q = parts[j]; const k = q ? parts.findIndex((o) => o !== q && o.id === q.id && o.mirror !== q.mirror && Math.abs(o.pos[0] + q.pos[0]) < 1e-6 && Math.abs(o.pos[2] - q.pos[2]) < 1e-6) : -1; return k >= 0 ? k : j; };
  const pair = (p) => { const i = add(p); if (Math.abs(p.pos[0]) > 0.12 || p.id.startsWith('w_')) add({ ...mirroredOf(p), parent: p.id.startsWith('w_') ? p.parent : partner(p.parent) }); return i; };
  const fus = pick(BODIES), f = add(newPart(fus, [0, 0, 0]));
  const tmp = new THREE.Group(); buildDesign({ parts }, tmp); const fb = new THREE.Box3().setFromObject(tmp);
  const wid = pick(WINGS), wy = fb.min.y + (fb.max.y - fb.min.y) * (0.2 + rand() * 0.6), wz = fb.min.z + (fb.max.z - fb.min.z) * (0.35 + rand() * 0.25);
  const w = pair(newPart(wid, [0, +wy.toFixed(2), +wz.toFixed(2)], { parent: f }));
  if (rand() < 0.6) { // pods under the wing
    const tb = new THREE.Group(); buildDesign({ parts }, tb); const bb = new THREE.Box3().setFromObject(tb);
    pair(newPart(pick(['x_tank', 'e_jet_small', 'e_piston']), [+(bb.max.x * (0.35 + rand() * 0.3)).toFixed(2), +(wy - 0.45).toFixed(2), +wz.toFixed(2)], { parent: w }));
  }
  // drop gear the way the hangar does: a ray from below at a target, 5 cm into the surface it hits, snapped to 5 cm
  const root = new THREE.Group(); const det = buildDesign({ parts }, root); root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root), all = [], targets = { body: [], wing: [], tip: [], pod: [], flap: [] };
  det.parts.forEach((o, i) => o?.traverse((m) => { if (!m.isMesh || m.material.transparent || m.userData.isDisc) return; all.push(m); m.userData._pi = i; }));
  det.parts.forEach((o, i) => {
    const id = parts[i].id, b = new THREE.Box3().setFromObject(o);
    if (PARTS[id].cat === 'fuselage') targets.body.push(b);
    if (PARTS[id].wing && id.startsWith('w_')) { targets.wing.push(b); const tip = b.clone(); if (parts[i].pos[0] >= 0 && !parts[i].mirror) tip.min.x = tip.max.x - 0.4; else tip.max.x = tip.min.x + 0.4; targets.tip.push(tip); for (const c of o.userData.controls || []) targets.flap.push(new THREE.Box3().setFromObject(c.obj)); }
    if (/^(x_tank|e_)/.test(id)) targets.pod.push(b);
  });
  const rc = new THREE.Raycaster(), placed = [];
  for (let n = 0, tries = 0; n < 2 + Math.floor(rand() * 3) && tries < 40; tries++) {
    const kind = pick(['body', 'body', 'wing', 'tip', 'pod', 'flap']), list = targets[kind]; if (!list.length) continue;
    const tb = pick(list), x = tb.min.x + (tb.max.x - tb.min.x) * rand(), z = tb.min.z + (tb.max.z - tb.min.z) * rand();
    rc.set(V(x, box.min.y - 2, z), V((rand() - 0.5) * 0.2, 1, (rand() - 0.5) * 0.2).normalize());
    const h = rc.intersectObjects(all, false)[0]; if (!h) continue;
    const nrm = h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize(), pos = h.point.clone().addScaledVector(nrm, -0.05);
    const snap = (v) => Math.round(v * 20) / 20; pos.set(Math.abs(pos.x) < 0.15 ? 0 : snap(pos.x), snap(pos.y), snap(pos.z));
    const id = pick(GEAR), o = rand() < 0.3 ? { rot: [(rand() - 0.5) * 30, (rand() - 0.5) * 20, (rand() - 0.5) * 50] } : {};
    const p = newPart(id, pos.toArray(), { parent: h.object.userData._pi, ...o });
    if (rand() < 0.35) { const s = +(0.6 + rand() * 1.2).toFixed(2); p.scale = [s, s, s]; }
    pair(p); placed.push(`${id}@${kind}`); n++;
  }
  root.traverse((o) => o.geometry?.dispose()); tmp.traverse((o) => o.geometry?.dispose());
  return { name: `random ${k} (${fus}, ${wid}: ${placed.join(', ')})`, parts };
}

const results = [], only = ARG?.only;
for (const d of S.presets.filter((d) => !only || only.includes(d.name))) {
  results.push(check(d, d.name), check(resized(d), d.name + ' resized'), check(mirrored(d), d.name + ' mirrored'));
}
if (!only) {
  const rand = rng(seed);
  for (let k = 0; k < nRandom; k++) {
    const d = randomBuild(rand, k);
    results.push(check(d, d.name), check(mirrored(d), d.name + ' mirrored'));
  }
}
return results;
