// What players build, for anonymous analytics: a structured summary of a design and how it was put together in
// the hangar. It is the input for deciding which parts, presets and fixes are needed. Nothing personal goes in:
// the vehicle's name (the only free text) is stripped, and the share code is just parts, placement and paint.
import { PARTS } from './parts.js';
import { encodeDesign } from './design.js';

const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); };
const r = (v, d = 1) => (Number.isFinite(v) ? +v.toFixed(d) : null);

export function designSummary(design, st, base) {
  const parts = design.parts || [];
  const byCat = {}, ids = {};
  let mirrored = 0, resized = 0, tuned = 0;
  for (const p of parts) {
    const cat = PARTS[p.id]?.cat || 'unknown';
    byCat[cat] = (byCat[cat] || 0) + 1; ids[p.id] = (ids[p.id] || 0) + 1;
    if (p.mirror) mirrored++; if (p.scale) resized++; if (p.power != null || p.burn != null) tuned++;
  }
  const code = encodeDesign({ ...design, name: '' }); // no name: the one place a child could type something personal
  return {
    base: base || 'custom', // which preset it started from ('blank', 'import', 'saved' or a preset name)
    design_hash: fnv(code), // same build flown again = same hash
    design_code: code.length <= 60000 ? code : null, // loadable in the hangar via Vehicles > Share / import
    parts: parts.length, by_cat: byCat, part_counts: ids,
    mirrored, resized, tuned,
    kind: st.heli ? 'helicopter' : st.car && st.wingArea < 0.5 ? 'car' : st.floats ? 'seaplane' : 'plane',
    mass_kg: r(st.mass, 0), thrust_weight: r(st.tw, 2), wing_area_m2: r(st.wingArea, 1), stall_kmh: Number.isFinite(st.stall) ? Math.round(st.stall * 3.6) : null,
    static_margin: r(st.margin, 2), engines: st.engines ?? null,
    warnings: (st.warnings || []).filter(([k]) => k === 'bad' || k === 'warn').map(([k, t]) => `${k}: ${String(t).slice(0, 80)}`),
  };
}

// Counts hangar activity between flights by wrapping the hangar's own methods (no edits inside hangar.js).
export function trackHangar(hangar, labelOf) {
  const s = { added: 0, removed: 0, undos: 0, redos: 0, clears: 0, base: 'custom', since: performance.now() };
  const wrap = (name, fn) => { const orig = hangar[name]?.bind(hangar); if (orig) hangar[name] = (...a) => { const r = orig(...a); fn(a, r); return r; }; };
  wrap('place', () => { s.added++; });
  wrap('deleteSel', () => { s.removed++; });
  wrap('undo', () => { s.undos++; });
  wrap('redo', () => { s.redos++; });
  wrap('clear', () => { s.clears++; });
  wrap('load', ([d]) => { s.base = !d?.parts?.length ? 'blank' : labelOf(d); s.added = s.removed = s.undos = s.redos = s.clears = 0; s.since = performance.now(); });
  return {
    get base() { return s.base; },
    setBase(b) { s.base = b; },
    // activity since the last load / flight, then start counting afresh
    take() { const o = { parts_added: s.added, parts_removed: s.removed, undos: s.undos, redos: s.redos, clears: s.clears, hangar_seconds: Math.round((performance.now() - s.since) / 1000) }; s.added = s.removed = s.undos = s.redos = s.clears = 0; s.since = performance.now(); return o; },
  };
}
