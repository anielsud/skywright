// Start-up bakes and caches check (browser module, driven by startbakes.py): what the deploy bakes (tools/bake/boot.py)
// and what the game keeps for the visit or on the device must be exactly what it would work out itself.
//   views(presets): every stock vehicle's cockpit views (stations.js: which cabin linings cover the windows), worked
//     out with no cache, then from the visit's cache, then from a bake round-tripped through JSON (as views.json and
//     localStorage are): the same linings and the same settled eyes for every seat, and the cache really used.
//   stunts(): at the flight's place (call it during a flight): the stunt park site the World planned (from the bake or
//     the visit's cache) == a fresh findSite on the World == the bake's (bakeStuntSites, round-tripped through JSON).
import { Aircraft } from '../../src/aircraft.js';
import { cloneDesign } from '../../src/design.js';
import { viewStats, solvedViews, takeViews, forgetViews } from '../../src/stations.js';
import { findSite } from '../../src/stuntSite.js';
import { layoutOf, bakeStuntSites, siteStats } from '../../src/stuntPark.js';

// the stations of a fresh flight Aircraft: per seat, its name, eye and the linings swapped (as places in the mesh tree)
function stationsOf(d) {
  const ac = new Aircraft(cloneDesign(d)), t0 = performance.now(), list = ac.stations, ms = performance.now() - t0;
  const idx = new Map(); let n = 0; ac.root.traverse((o) => idx.set(o, n++));
  const out = list.map((s) => ({ name: s.name, eye: s.eye.toArray().map((v) => +v.toFixed(6)), linings: s.linings.map((l) => idx.get(l.mesh)).sort((a, b) => a - b) }));
  ac.root.traverse((o) => { o.geometry?.dispose(); o.skeleton?.dispose(); });
  return { out, ms };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function views(presets) {
  const rows = [];
  for (const d of presets) {
    const r = { name: d.name };
    try {
      globalThis.__viewsNoCache = true; forgetViews();
      const ref = stationsOf(d);
      globalThis.__viewsNoCache = false;
      const k0 = viewStats.kept, w0 = viewStats.worked;
      const first = stationsOf(d); // works it out, keeps it
      const k1 = viewStats.kept, w1 = viewStats.worked;
      const again = stationsOf(d); // the visit's cache
      const k2 = viewStats.kept;
      const baked = JSON.parse(JSON.stringify({ stamp: 'test', ...solvedViews() }));
      forgetViews(); takeViews(baked, 'test');
      const fromBake = stationsOf(d); // as from views.json / localStorage
      const k3 = viewStats.kept;
      Object.assign(r, {
        seats: ref.out.length, linings: ref.out.reduce((a, s) => a + s.linings.length, 0), lined: w1 - w0, // (seats whose soup has linings at all: the ones cached)
        firstSame: same(ref.out, first.out), againSame: same(ref.out, again.out), bakeSame: same(ref.out, fromBake.out),
        workedFirst: k1 === k0, keptAgain: k2 - k1, keptBake: k3 - k2,
        ms: { none: Math.round(ref.ms), first: Math.round(first.ms), again: Math.round(again.ms), bake: Math.round(fromBake.ms) },
      });
    } catch (e) { r.error = String(e?.stack || e); }
    rows.push(r);
  }
  globalThis.__viewsNoCache = false;
  return rows;
}

const noMs = (s) => s && JSON.parse(JSON.stringify({ ...s, ms: 0 }));
export async function stunts() {
  const F = window.__sky.F, w = F.world, cfg = w.loc.stunts;
  if (!cfg || cfg.atJump || cfg.x != null) return { id: w.loc.id, searched: false };
  const planned = noMs(w.stuntPlan?.site), fresh = noMs(findSite(w, cfg, layoutOf(cfg)));
  const baked = noMs(JSON.parse(JSON.stringify(await bakeStuntSites({ [w.loc.id]: w.loc })))[w.loc.id]);
  return { id: w.loc.id, searched: true, planned, freshSame: same(planned, fresh), bakeSame: same(planned, baked), stats: { ...siteStats } };
}
