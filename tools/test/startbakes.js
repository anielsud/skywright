// Start-up bakes and caches check: what the deploy bakes (tools/bake/boot.py) and what the game keeps for the visit or
// on the device must be exactly what it would work out itself.
//   views(presets) (Node tier, this module's nodeSuite): a stock vehicle's cockpit views (stations.js: which cabin
//     linings cover the windows), worked out with no cache, then from the visit's cache, then from a bake round-tripped
//     through JSON (as views.json and localStorage are): the same linings and the same settled eyes for every seat, and
//     the cache really used. A sample of the stock vehicles (every one with linings, plus a few without): the deploy's
//     bake checks every one of its own (verifyBake below, run by boot.py), so this proves the mechanism.
//   stuntsAt(locId) (browser, startbakes.py --only stunts): builds the place's World (as a flight does, at Low) and
//     checks the stunt park site it planned (from the bake or the visit's cache) == a fresh findSite on that World ==
//     the bake's (bakeStuntSites, round-tripped through JSON); then plans again on it: the visit's cache, same site.
//   verifyBake(bake, presets) (browser, boot.py): the deploy's own output, as written (parsed back from its JSON),
//     against what the game works out with no cache: every stock vehicle's views from the bake alone, and every stunt
//     site unchanged by the round trip.
import { Aircraft } from '../../src/aircraft.js';
import { cloneDesign } from '../../src/design.js';
import { viewStats, solvedViews, takeViews, forgetViews } from '../../src/stations.js';
import { findSite } from '../../src/stuntSite.js';
import { layoutOf, bakeStuntSites, siteStats, planStunts } from '../../src/stuntPark.js';

// the stations of a fresh flight Aircraft: per seat, its name, eye and the linings swapped (as places in the mesh tree)
function stationsOf(d) {
  const ac = new Aircraft(cloneDesign(d)), t0 = performance.now(), list = ac.stations, ms = performance.now() - t0;
  const idx = new Map(); let n = 0; ac.root.traverse((o) => idx.set(o, n++));
  const out = list.map((s) => ({ name: s.name, eye: s.eye.toArray().map((v) => +v.toFixed(6)), linings: s.linings.map((l) => idx.get(l.mesh)).sort((a, b) => a - b) }));
  ac.root.traverse((o) => { o.geometry?.dispose(); o.skeleton?.dispose(); });
  return { out, ms };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// exactly equal, as the game would use it: same keys, same values (-0, NaN and undefined included, which JSON loses)
function identical(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && identical(a[k], b[k]));
}

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
export const viewsOk = (r) => !r.error && r.firstSame && r.againSame && r.bakeSame && r.keptAgain === r.lined && r.keptBake === r.lined && r.workedFirst;
export const viewsLine = (r) => (r.error ? r.error.slice(0, 300) : `${r.seats} seats, ${r.lined} with linings (${r.linings} swapped); same: first ${r.firstSame}, cached ${r.againSame}, baked ${r.bakeSame}; cache hits ${r.keptAgain}/${r.keptBake}; stations ms ${JSON.stringify(r.ms)}`);

const noMs = (s) => s && JSON.parse(JSON.stringify({ ...s, ms: 0 }));
// the place's World, built as a flight builds it (at Low; no vehicle, crew or HUD): its stunt site three ways, then
// planned again from the visit's cache (what a second flight there does: World's constructor calls planStunts)
export async function stuntsAt(locId) {
  const S = window.__sky, THREE = S.THREE, { World, LOCATIONS } = await import('../../src/world.js'), { loadReal } = await import('../../src/realworld.js');
  const loc = LOCATIONS[locId], cfg = loc?.stunts;
  if (!cfg || cfg.atJump || cfg.x != null) return { id: locId, searched: false };
  const t0 = performance.now();
  await (loc.real ? loadReal(loc, 'low') : World.prepare(locId));
  const t1 = performance.now(), s0 = { ...siteStats }, w = new World(S.renderer, new THREE.Scene(), { location: locId, quality: 'low', time: 11, weather: 'clear' }), t2 = performance.now();
  try {
    const planned = noMs(w.stuntPlan?.site), fresh = noMs(findSite(w, cfg, layoutOf(cfg)));
    const baked = noMs(JSON.parse(JSON.stringify(await bakeStuntSites({ [locId]: loc })))[locId]);
    const s1 = { ...siteStats }, again = noMs(planStunts(w, cfg)?.site), s2 = { ...siteStats };
    const ms = { load: Math.round(t1 - t0), world: Math.round(t2 - t1), checks: Math.round(performance.now() - t2) };
    return { id: locId, searched: true, planned, freshSame: same(planned, fresh), bakeSame: same(planned, baked), againSame: same(planned, again), stats: [s0, s1, s2], ms };
  } finally { w.dispose(); }
}

// boot.py: the bake as written (parsed back from its JSON) against what the game works out itself. Returns a list of
// problems (empty: good).
export async function verifyBake(bake, presets) {
  const bad = [];
  // cockpit views: for every stock vehicle, with only the bake to go on, every seat with linings takes them from it,
  // and every seat ends up with the same linings and eye as worked out with no cache at all
  for (const d of presets) {
    try {
      globalThis.__viewsNoCache = true; const ref = stationsOf(d).out;
      globalThis.__viewsNoCache = false; forgetViews(); takeViews(bake.views); // (the module's own stamp: as the game takes views.json)
      const w0 = viewStats.worked, got = stationsOf(d).out;
      if (!same(ref, got)) bad.push(`views: ${d.name}: from the bake ${JSON.stringify(got)} != worked out ${JSON.stringify(ref)}`);
      if (viewStats.worked !== w0) bad.push(`views: ${d.name}: ${viewStats.worked - w0} seat(s) not in the bake (stamp ${bake.views?.stamp})`);
    } catch (e) { bad.push(`views: ${d.name}: ${e?.stack || e}`); } finally { globalThis.__viewsNoCache = false; }
  }
  // stunt sites: the World takes the baked site as it is (stuntPark.js siteFor): the round trip must not change it
  const fresh = await bakeStuntSites((await import('../../src/world.js')).LOCATIONS);
  for (const [id, site] of Object.entries(fresh)) {
    const b = bake.stunts?.sites?.[id];
    if (!identical(noMs(site), noMs(b))) bad.push(`stunts: ${id}: baked ${JSON.stringify(b)} != found ${JSON.stringify(site)}`);
  }
  for (const id of Object.keys(bake.stunts?.sites || {})) if (!(id in fresh)) bad.push(`stunts: ${id}: baked but no place searches there`);
  return bad;
}

// ---------- Node tier: the views, one case per stock vehicle in the sample ----------
// SKY_BAKES_VIEWS=all: every stock vehicle; =Jumbo,Kestrel: those. Default: the sample (every one with linings, as of
// writing, plus three without; a name no longer in the presets just drops out, and if fewer than three are left it
// takes the first six).
export const nodeSuite = { files: ['src/stations.js', 'src/aircraft.js', 'tools/test/startbakes.js'], headless: false };
const SAMPLE = ['Kestrel', 'Twin Pod', 'SR-71 Blackbird', 'Jumbo', 'Centipede', 'Dragonfly', 'Chomper', 'Rocket'];
export function cases({ presets }) {
  const want = process.env.SKY_BAKES_VIEWS;
  if (want) return presets.filter((d) => want === 'all' || want.split(',').includes(d.name)).map((d) => ({ id: `views: ${d.name}`, name: d.name }));
  let pick = presets.filter((d) => SAMPLE.includes(d.name));
  if (pick.length < 3) pick = presets.slice(0, 6);
  return pick.map((d) => ({ id: `views: ${d.name}`, name: d.name }));
}
export function runCase(c, { presets }) {
  const [r] = views([presets.find((d) => d.name === c.name)]);
  return [{ name: c.id, ok: viewsOk(r), why: viewsOk(r) ? undefined : viewsLine(r), detail: viewsLine(r) }];
}
