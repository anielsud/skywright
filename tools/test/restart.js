// In-page part of restart.py: a restart keeps the World (main.js kept / World.reset) and must look and behave exactly
// like a fresh start. Needs a flight running (window.__sky.F).
//
//   damage(S):   knocks down / holes the buildings nearest the vehicle through the destruction API (destruction.js),
//                flattens trees, and records what it touched (entries, their heights, their vertex runs)
//   damaged(S):  how much damage there is right now (damage states, debris, fires, flattened entries)
//   whole(S, r): after a restart: every entry damage() touched back to its height, its dmg bytes 0, the damage slots and
//                the debris pools empty, nothing left flattened, the stunt sites idle
//   snap(S):     GPU memory (renderer.info), shader programs, the scene's child count, the spawn pose, the World's id
// and, for the canyon-lauterbrunnen job (which drives the flights itself), restart.py's measuring steps (settled, upload)
// and verdicts as [[name, ok, detail]] lists (damageChecks, memoryChecks, freshChecks, startTypeCheck): see the end.

const ids = new WeakMap(); let nextId = 1;
const worldId = (w) => { if (!ids.has(w)) ids.set(w, nextId++); return ids.get(w); };

export function snap(S) {
  const F = S.F, i = S.renderer.info, x = F.spawn.x, q = F.spawn.q;
  return { world: worldId(F.world), geometries: i.memory.geometries, textures: i.memory.textures, programs: (i.programs || []).length,
    kids: F.scene.children.length, spawn: [x.x, x.y, x.z, q.x, q.y, q.z, q.w], start: F.cfgStart, alive: !!F.ac && !F.ac.dead,
    pos: [F.ac.x.x, F.ac.x.y, F.ac.x.z].map((v) => +v.toFixed(2)), finite: [F.ac.x.x, F.ac.x.y, F.ac.x.z, F.ac.v.x, F.ac.v.y, F.ac.v.z].every(Number.isFinite) };
}

// collision entries with a damage key, nearest (x, z) first
function buildingsNear(W, x, z) {
  const T = W.towns, out = [], seen = new Set();
  for (const g of [T.grid, T.city?.grid]) if (g) for (const a of g.values()) for (const e of a) if (e.dk && e[3] > 4 && !seen.has(e)) { seen.add(e); out.push(e); }
  out.sort((a, b) => Math.hypot(a[0] - x, a[2] - z) - Math.hypot(b[0] - x, b[2] - z));
  return out;
}

let touched = null;
export function damage(S) {
  const F = S.F, W = F.world, D = W.destruct, T = S.THREE, ac = F.ac;
  if (!D.fx) D.fx = F.effects; // (set by the first destruct.update anyway)
  const list = buildingsNear(W, ac.x.x, ac.x.z).slice(0, 8);
  touched = { ents: list.map((e) => ({ e, h: e[3], rng: (e.rng || []).map((r) => r.slice()) })), trees: [] };
  list.forEach((e, k) => {
    const B = D.get(e), o = B.ob, p = new T.Vector3(o.x + o.ux * o.hl, e[1] + e[3] * 0.5, o.z + o.uz * o.hl), n = new T.Vector3(o.ux, 0, o.uz);
    // half of them brought right down, the rest hit hard enough for holes and a cut
    D.damage(B, k % 2 ? B.hp * 0.25 : B.hp * 3, p, n.clone().negate(), n, 40);
  });
  // trees (and any non-solid collision entry): flattened the way main.js does when a part hits one
  const T2 = W.towns; let nt = 0;
  for (const g of [T2.grid]) if (g) for (const a of g.values()) for (const e of a) if (!e.solid && !e.dk && e[3] > 1 && nt < 20) { touched.trees.push({ e, h: e[3] }); W.flatten(e); nt++; }
  // and a forest tree (flora.js keeps the hit ones in its felled map)
  for (const c of W.flora.cells.values()) {
    if (!c.data || nt >= 25) continue;
    const d = c.data, t = W.flora.hit({ x: d[0], y: d[1] + 0.5, z: d[2] });
    if (t && t[3] > 0) { touched.trees.push({ e: t, h: t[3] }); W.flatten(t); nt++; }
  }
  return { buildings: list.length, trees: nt };
}

export function damaged(S) {
  const D = S.F.world.destruct, i = D.info();
  return { ...i, mounds: D.mounds.used, shards: D.shards.used, scorch: D.scorch.used, cav: D.cav.used, flattened: S.F.world.flat.size, lowered: D.h0.size,
    cut: touched ? touched.ents.filter((t) => t.e[3] < t.h - 0.01).length : 0, flagged: [...D.states.values()].filter((B) => B.flag).length };
}

export function whole(S) {
  const W = S.F.world, D = W.destruct, bad = [];
  if (!touched) return ['damage() was not run'];
  for (const { e, h, rng } of touched.ents) {
    if (Math.abs(e[3] - h) > 1e-6) bad.push(`${e.dk} height ${e[3].toFixed(1)} != ${h.toFixed(1)}`);
    for (const [g, s, n] of rng) {
      const a = g.geo?.attributes.dmg; if (!a || !n) continue;
      const arr = a.array; if (arr.length !== a.count) continue; // (a static mesh freed its array: its stand-in only carries the last run written)
      for (let k = s; k < s + n; k++) if (arr[k]) { bad.push(`${e.dk} dmg byte ${arr[k]}`); break; }
    }
  }
  for (const { e, h } of touched.trees) if (e[3] !== h) bad.push(`tree still flat (${e[3]} != ${h})`);
  const d = damaged(S);
  for (const k of ['buildings', 'slots', 'anims', 'proxies', 'fires', 'flattened', 'lowered', 'flagged']) if (d[k]) bad.push(`${k}: ${d[k]}`);
  for (const k of ['chunks', 'mounds', 'shards', 'scorch', 'cav']) if (d[k] > 1 && !S.F.ac.dead) bad.push(`${k} pool in use: ${d[k]}`);
  if (D.free.length !== 254) bad.push(`free damage slots ${D.free.length}`);
  if (D.later.length) bad.push(`pending dominoes ${D.later.length}`);
  const st = W.stunts; if (st?.evel && st.evel.st.phase !== 'idle') bad.push('evel jump not idle');
  if (W.space.active) bad.push('space view active');
  return bad;
}

// ---------- restart.py's driver and verdicts, in the page (the canyon-lauterbrunnen job, tools/test/jobs) ----------
// The job drives the flights (harness T.start / T.restart / T.end); these are the measuring steps between them and
// restart.py's verdicts as [[name, ok, detail]] lists for T.checks.

// What snap() measures (GPU textures) must all be uploaded: one frame drawn (it sets up the shadow maps and the
// post-processing targets), then every texture the scene's materials use uploaded directly (restart.py's UPLOAD).
export async function upload(S) {
  const r = S.renderer, seen = new Set(), up = (t) => { if (t?.isTexture && !seen.has(t) && t.image !== undefined) { seen.add(t); r.initTexture(t); } };
  await new Promise((res) => requestAnimationFrame(res));
  S.F.scene.traverse((o) => { for (const m of [].concat(o.material || [])) { for (const k in m) up(m[k]); for (const k in m.uniforms || {}) up(m.uniforms[k]?.value); } });
  return seen.size;
}
// after a start or a restart, as restart.py's running(): one game second stepped, (for a memory snapshot) the frame and
// the uploads, then the snapshot
export async function settled(S, { mem = false } = {}) {
  S.advance(1);
  if (mem) await upload(S);
  return snap(S);
}
export const sameSpawn = (a, b, tol = 1e-3) => a.spawn.every((x, i) => Math.abs(x - b.spawn[i]) <= tol);

// 1. damage, restart, whole again. d: damage(); dd: damaged() before the restart; s0/s1: snap() before / after; bad: whole()
export function damageChecks(loc, d, dd, s0, s1, bad) {
  return [
    [`${loc}: buildings damaged before the restart`, d.buildings > 0 && dd.buildings > 0 && dd.cut > 0 && dd.chunks > 1,
      `${d.buildings} hit, ${dd.cut} cut down, ${dd.chunks} debris, ${dd.fires} fires, ${d.trees} trees flattened`],
    [`${loc}: restart keeps the World`, s1.world === s0.world, `world ${s0.world} -> ${s1.world}`],
    [`${loc}: everything whole again after the restart`, !bad.length, bad.slice(0, 6).join('; ') || 'buildings, trees, debris, slots'],
    [`${loc}: same spawn as the first start`, sameSpawn(s0, s1) && s0.start === s1.start, `${s0.spawn.slice(0, 3).map((v) => v.toFixed(2))} / ${s1.spawn.slice(0, 3).map((v) => v.toFixed(2))} (${s0.start}/${s1.start})`],
  ];
}
// 2. memory over the restarts (snaps: one per restart, each taken with settled(S, { mem: true })); world: the World's id
export function memoryChecks(loc, snaps, world) {
  const tail = snaps.length > 1 ? snaps.slice(1) : snaps; // (the first restart may still compile a shader the first flight hadn't drawn)
  const out = [];
  for (const [key, tol] of [['geometries', 3], ['textures', 1], ['programs', 2], ['kids', 0]]) {
    const vals = tail.map((s) => s[key]);
    // (a leak grows restart after restart; a count may drop, e.g. a block of textures the streaming lets go: no leak)
    out.push([`${loc}: ${key} never grows over ${snaps.length} restarts`, Math.max(...vals) - vals[0] <= tol, snaps.map((s) => s[key]).join(' ')]);
  }
  out.push([`${loc}: one World through every restart`, snaps.every((s) => s.world === world), snaps.map((s) => s.world).join(' ')]);
  return out;
}
// 3. back in the hangar (kept: __sky.kept then), a fresh start (s2) of what was restarted (s0 first start, s1 a restart),
// and r: that fresh World damaged and restarted. s2 and r are measured the same way (streaming finished round the
// spawn, then settled with the uploads): a restart holds the GPU memory a fresh start holds (#291: measured against the
// first World's restarts instead, it compared a World swept and streamed for longer with one just started). r null: no
// memory comparison (CI skips it and the work behind it)
export function freshChecks(loc, kept, s0, s1, s2, r) {
  const out = [
    [`${loc}: the hangar holds no World`, !kept, kept ? 'a World is still kept' : ''],
    [`${loc}: fresh start builds a new World with the same spawn`, s2.world !== s0.world && sameSpawn(s2, s1), `world ${s0.world} -> ${s2.world}, spawn ${s2.spawn.slice(0, 3).map((v) => v.toFixed(2))}`],
    // (restart.py compared the first start's child count with the restart's in the same World; here the restart's with
    // this fresh start's: the same claim, a restart leaves the scene as a fresh start has it)
    [`${loc}: scene child count as a fresh start`, s1.kids === s2.kids, `restarted ${s1.kids}, fresh ${s2.kids}`],
  ];
  if (r) out.push([`${loc}: restarted GPU memory as a fresh start`, r.world === s2.world && Math.abs(r.geometries - s2.geometries) <= Math.max(8, s2.geometries * 0.05) && Math.abs(r.textures - s2.textures) <= 3,
      `geometries ${r.geometries} vs ${s2.geometries}, textures ${r.textures} vs ${s2.textures}, kids ${r.kids} vs ${s2.kids}${r.world === s2.world ? '' : ', NOT the same World'}`]);
  return out;
}
// 4. a start type: f as it started (swapped in), r restarted, e after 4 game seconds on (with throttle if thr); world: the
// World's id it must all happen in
export function startTypeCheck(loc, label, f, r, e, thr, world) {
  const ok = r.world === f.world && f.world === world && r.start === f.start && sameSpawn(f, r);
  const moved = Math.hypot(...e.pos.map((v, i) => v - r.pos[i])), go = e.alive && e.finite && (!thr || moved > 3);
  return [`${loc}: ${label} (${f.start}): restart as swapped in, then on`, ok && go,
    `world ${r.world === f.world && f.world === world ? 'kept' : 'NEW'}, start ${f.start}/${r.start}, spawn ${sameSpawn(f, r) ? 'same' : 'MOVED'}, moved ${moved.toFixed(0)} m${e.alive ? '' : ', DEAD'}${e.finite ? '' : ', NOT FINITE'}`];
}
