// The airport's furniture (src/airportKit.js, #227): built at every place, nothing solid on a runway, taxiway or the
// apron, lamps and signs at sensible heights over the real ground, the landside gate where roads.js expects it, and
// a budget on what the airfield adds (triangles, build time). Node tier: builds each place's World (node/world.mjs).
import { worldAt } from './node/world.mjs';
import { LOCATIONS } from '../../src/world.js';
import { airportGate, buildAirfieldKit } from '../../src/airportKit.js';
import { Builder } from '../../src/buildings.js';

export const nodeSuite = { files: ['src/airportKit.js', 'src/world.js', 'src/launchpad.js', 'tools/test/airportcheck.js'], headless: true };
const PLACES = Object.values(LOCATIONS).filter((l) => l && !l.hidden).map((l) => l.id);
export function cases() { return PLACES.map((id) => ({ id, world: id, cost: 4 })); }

export async function runCase(c) {
  const { world: W } = await worldAt(c.id), out = [], y = W.loc.rwyH;
  const check = (name, ok, why = '') => out.push({ name: `${c.id}: ${name}`, ok: !!ok, why: ok ? '' : why });
  const K = W.airfield;
  check('kit built', K && K.nSigns >= 20 && K.points.length >= 100, `signs ${K?.nSigns}, lamps ${K?.points.length}`);
  if (!K) return out;
  // nothing solid on pavement: sample each solid's footprint (a ring at its radius and its centre)
  const bad = [];
  for (const s of K.solids) for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
    const x = s.x + s.hx * i / 2, z = s.z + s.hz * j / 2;
    if (W.isPaved(x, z) || W.groundAt(x, z).type === 'runway') { bad.push(`(${Math.round(s.x)}, ${Math.round(s.z)}) ${s.hx.toFixed(1)} x ${s.hz.toFixed(1)}`); i = j = 9; }
  }
  check('nothing solid on runways, taxiways or apron', !bad.length, bad.slice(0, 6).join('; '));
  // lamps: above the ground under them, and not on stilts
  const lamps = [];
  for (const [x, ly, z, col] of K.points) { const g = Math.max(W.heightAt(x, z), W.waterLevel); if (ly < g + 0.2 || ly > Math.max(g, y) + (col === 0xff3020 ? 20 : 9)) lamps.push(`(${Math.round(x)}, ${Math.round(z)}) ${(ly - g).toFixed(1)} m`); }
  check('lamps 0.2-9 m over the ground (masts 20)', !lamps.length, lamps.slice(0, 6).join('; '));
  // landside gate: outside roads.js's airport no-go box edge, at runway height (none on Bora Bora's islet)
  const gate = airportGate(W.loc);
  check('landside gate', c.id === 'islands' ? gate === null : gate && gate.x >= 560 && gate.h === y, JSON.stringify(gate));
  // budget: the kit alone, built again into an empty Builder
  const A = new Builder(), t0 = performance.now(); const K2 = buildAirfieldKit(W, A, y); const ms = performance.now() - t0;
  const tris = A.ni / 3 + K2.signs.geometry.attributes.position.count / 3;
  check('kit budget', tris < 40000 && ms < 120, `${Math.round(tris)} triangles, ${ms.toFixed(0)} ms`);
  out.push({ name: `${c.id}: kit size (info)`, ok: true, why: `${Math.round(tris)} tris, ${ms.toFixed(0)} ms, ${K.nSigns} signs, ${K.points.length} lamps` });
  return out;
}
