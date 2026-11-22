// In-page part of restart.py: a restart keeps the World (main.js kept / World.reset) and must look and behave exactly
// like a fresh start. Needs a flight running (window.__sky.F).
//
//   damage(S):   knocks down / holes the buildings nearest the vehicle through the destruction API (destruction.js),
//                flattens trees, and records what it touched (entries, their heights, their vertex runs)
//   damaged(S):  how much damage there is right now (damage states, debris, fires, flattened entries)
//   whole(S, r): after a restart: every entry damage() touched back to its height, its dmg bytes 0, the damage slots and
//                the debris pools empty, nothing left flattened, the stunt sites idle
//   snap(S):     GPU memory (renderer.info), shader programs, the scene's child count, the spawn pose, the World's id

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
