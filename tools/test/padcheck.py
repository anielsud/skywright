#!/usr/bin/env python3
"""Launch pad check: boots Skywright in headless Chrome and, at every location,

  1. starts the stock Rocket and checks it stands upright on the launch pad's stand (on the pad's axis, nose straight
     up, held by the hold-down clamps), with the engines off;
  2. leaves it there for 5 s: it must not move (drift, tilt), leave the deck, take damage or report any contact event;
  3. goes to full throttle: the clamps must let go once the swing arm is clear, and it must rise past the service
     tower with no part or hull point ever inside it (and keep a gap to it), no damage, no impact or scrape, standing
     up straight below the tower top, and be well up after 10 s;
  4. checks that planes and cars are not moved to the pad: the game's start rule (src/startChoice.js chooseStart, what
     buildFlight runs) with this place's real answers puts nothing but a rocket on the pad, for every stock vehicle and
     every start choice; and at the first location a plane and a car really start (swapped into the same World) where
     the rule says, not on the pad. With --ref URL (a server of the main branch) their spawn poses (position, attitude,
     velocity) must match it exactly; --all-spawns starts every other preset at every location.

The flight's own time is stepped with __sky.advance (no frames drawn). The rule itself is tested over every vehicle,
choice and kind of place in Node (tools/test/startchoice.js).

Run from anywhere:  python3 tools/test/padcheck.py [--ref http://127.0.0.1:9000] [--only islands] [--port N]
Same requirements as smoke.py (Chrome + the websockets package). Exits non-zero on any failure.
"""
import argparse, asyncio, json, os, shutil, sys, tempfile
import websockets

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import CDP, Problems, free_port, start_server, launch_chrome  # noqa: E402

LOCS = ['islands', 'canyon', 'nyc', 'lauterbrunnen']
QUALITY = {'tier': 'medium'}  # the graphics tier every session uses (--quality; run.py --ci: low, a CI runner builds shaders in software)


async def session(origin, fn):
    profile = tempfile.mkdtemp(prefix='skypad-')
    proc, ws_url = launch_chrome(free_port(), profile, '1000,700')
    try:
        async with websockets.connect(ws_url, max_size=None, ping_interval=None) as ws:
            cdp = CDP(ws)
            probs = Problems(origin)
            cdp.handlers.append(probs.on)
            for d in ('Runtime', 'Log', 'Network'):
                await cdp.send(f'{d}.enable')
            await cdp.send('Network.setCacheDisabled', cacheDisabled=True)
            await cdp.send('Page.navigate', url=origin + '/')
            await cdp.wait_for('window.__sky && window.__sky.presets.length && !document.getElementById("splash")', 60, 'the app to boot')
            await cdp.js(f"window.__sky.settings.quality = {json.dumps(QUALITY['tier'])}; 1")  # (the same tier on both sides of a --ref comparison)
            return await fn(cdp, probs)
    finally:
        proc.kill(); proc.wait(); shutil.rmtree(profile, ignore_errors=True)


async def spawns(cdp, loc, names, module='padcheck'):
    """Each preset started at loc (swapped into the World already there), its spawn pose before the first step."""
    out = {}
    for n in names:
        out[f'{loc}/{n}'] = await cdp.js(f"import('/tools/test/{module}.js').then((m) => m.spawn({json.dumps(n)}, {json.dumps(loc)}))", timeout=180)
    return out


def default_start(pred, name):
    """The rule's start for a preset with the default choices (runway start, free flight, no land / boat choice)."""
    return next((p['start'] for p in pred if p['name'] == name and p['cfg'].get('start') == 'runway' and p['cfg'].get('mode') == 'free'
                 and p['cfg'].get('landStart') is None and p['cfg'].get('boatStart') is None), None)


def check_predicted(check, predicted, where, kind, flag):
    """Every (vehicle, start choice) the start rule put at `where` (pad / helipad) must be of its kind."""
    for loc, pred in predicted.items():
        on = [p for p in pred if p['start'] == where]
        check(all(p[flag] for p in on), f"{loc}: the start rule puts {sorted({p['name'] for p in on if not p[flag]})} on the {where}")
        print(f"{loc}: the start rule over {len({p['name'] for p in pred})} vehicles x their start choices ({len(pred)} in all): "
              f"on the {where} only {sorted({p['name'] for p in on}) or 'nothing'}")


def check_spawns(check, spawns, predicted, where):
    for k, v in spawns.items():
        loc, n = k.split('/', 1)
        check(v['start'] != where, f'{k} started on the {where}')
        want = default_start(predicted[loc], n)
        check(v['start'] == want, f"{k} started at {v['start']}, the start rule said {want}")
    print(f"{len(spawns)} other spawns ({', '.join(k + ': ' + v['start'] for k, v in spawns.items())}): none on the {where}, each where the rule said")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--only', action='append', help='just this location (repeatable)')
    ap.add_argument('--ref', help='a server of the main branch: other vehicles must spawn exactly as there')
    ap.add_argument('--all-spawns', action='store_true', help='start every other preset at every location (default: a plane and a car at the first location; the start rule covers every preset everywhere)')
    ap.add_argument('--url', help='check an already running server instead of serving this checkout')
    ap.add_argument('--port', type=int)
    ap.add_argument('--json', help='write the full report here')
    ap.add_argument('--quality', choices=['low', 'medium', 'high'], default='medium', help='graphics tier (default medium; CI: low)')
    a = ap.parse_args()
    QUALITY['tier'] = a.quality
    locs = a.only or LOCS
    port = a.port or free_port()
    srv = None if a.url else start_server(port)
    origin = (a.url or f'http://127.0.0.1:{port}').rstrip('/')
    bad, report = 0, {}

    def check(ok, what):
        nonlocal bad
        if not ok:
            bad += 1
            print(f'      FAIL: {what}')
        return ok

    async def target(cdp, probs):
        res = {'rockets': [], 'problems': [], 'spawns': {}, 'predicted': {}, 'plan': []}
        names = await cdp.js("window.__sky.presets.filter((d) => !window.__sky.analyze(d).vertical).map((d) => d.name)")
        plane = next(n for n in names if not any(w in n.lower() for w in ('buggy', 'truck', 'car', 'monster')))
        car = next((n for n in names if any(w in n.lower() for w in ('buggy', 'truck', 'car', 'monster'))), names[-1])
        for i, loc in enumerate(locs):
            r = await cdp.js(f"import('/tools/test/padcheck.js').then((m) => m.rocket({json.dumps(loc)}))", timeout=300)
            res['rockets'].append(r)
            res['predicted'][loc] = await cdp.js("import('/tools/test/padcheck.js').then((m) => m.predict())", timeout=60)
            if i == 0 or a.all_spawns:
                ns = names if a.all_spawns else [plane, car]
                res['plan'].append((loc, ns))
                res['spawns'].update(await spawns(cdp, loc, ns))
            res['problems'] += probs.take()
        await cdp.js('window.__sky.F && window.__sky.endFlight(); 1')
        res['problems'] += probs.take()
        return res

    try:
        res = asyncio.run(session(origin, target))
        report['target'] = res
        for r in res['rockets']:
            s, h, b = r['spawn'], r['hold'], r['burn']
            print(f"{r['location']:<14} start {r['start']}  axis {s['axis']:.3f} m  nose {s['nose']:.5f}  | hold {h['seconds']:.1f} s: drift {h['drift'] * 1000:.2f} mm, tilt {h['tilt']:.2e} rad, "
                  f"off deck {h['offGround']}/{h['frames']} frames | burn: released {b['releasedAt'] if b['releasedAt'] is None else round(b['releasedAt'], 2)} s (arm {b['armAtRelease']}), "
                  f"tower gap {b['towerClearance']:.2f} m, hits {b['towerHits']}, tilt {b['tiltBelowTower']:.3f} rad, dmg {b['dmg']:.1f}, {b['alive']}/{b['parts']} parts, "
                  f"{b['height']:.0f} m up after {b['seconds']:.1f} s")
            check(r['start'] == 'pad', 'did not start on the pad')
            check(s['axis'] < 0.05, f"not on the pad's axis ({s['axis']:.3f} m)")
            check(s['nose'] > 0.9999, 'not upright')
            check(s['clamp'], 'not held by the clamps')
            check(h['seconds'] >= 4.99, 'held for less than 5 s')
            check(h['drift'] < 0.002 and h['tilt'] < 1e-3 and h['vmax'] < 0.05, 'moved on the stand')
            check(h['offGround'] == 0, 'left the deck while parked')
            check(h['dmg'] == 0 and not ({'impact', 'scrape', 'debris', 'wreck', 'touch'} & set(h['events'])), f"contact/damage on the stand: {h['events']}, dmg {h['dmg']}")
            check(not h['engines'], 'engines running while parked')
            check(b['releasedAt'] is not None and b['armAtRelease'] >= 0.8, 'the clamps never let go (or let go before the swing arm was clear)')
            check(b['towerHits'] == 0, f"{b['towerHits']} hits on the tower")
            check(b['towerClearance'] > 0.3, f"passed {b['towerClearance']:.2f} m from the tower")
            check(b['tiltBelowTower'] < 0.05, f"leaned {b['tiltBelowTower']:.3f} rad before clearing the tower")
            check(b['dmg'] == 0 and b['alive'] == b['parts'] and not b['dead'], 'damaged on launch')
            check(not ({'impact', 'scrape', 'debris', 'wreck'} & set(b['events'])), f"contact on launch: {b['events']}")
            check(b['height'] > b['towerHeight'] + 100, 'did not climb clear')
            check(b['arm'] == 1, 'swing arm did not retract')
        print(f"shader programs compiled in flight (all flights): {res['rockets'][-1]['inflightCompiles'] if res['rockets'] else 0}")
        check_predicted(check, res['predicted'], 'pad', 'rocket', 'vertical')
        check(all(any(p['start'] == 'pad' for p in pred) for pred in res['predicted'].values()), 'the start rule puts no rocket on the pad somewhere')
        sp = res['spawns']
        check_spawns(check, sp, res['predicted'], 'pad')
        if a.ref:
            ref = asyncio.run(session(a.ref.rstrip('/'), lambda cdp, probs: _ref(cdp, res['plan'])))
            report['ref'] = ref
            same = 0
            for k, v in sp.items():
                w = ref.get(k)
                if check(w is not None and all(v[f] == w[f] for f in ('start', 'x', 'q', 'v')), f'{k} spawns differently from --ref: {v} vs {w}'):
                    same += 1
            print(f'{same}/{len(sp)} spawn poses identical to {a.ref}')
        for p in res['problems'][:10]:
            check(False, f'page: {p}')
    finally:
        if srv:
            srv.shutdown()
    if a.json:
        json.dump(report, open(a.json, 'w'), indent=1)
    print('PASS' if not bad else f'{bad} FAILURES')
    return 1 if bad else 0


async def _ref(cdp, plan):
    out = {}
    for l, ns in plan:
        out.update(await spawns_ref(cdp, l, ns))
    await cdp.js('window.__sky.F && window.__sky.endFlight(); 1')
    return out


async def spawns_ref(cdp, loc, names):
    # the main branch has no padcheck.js: the same spawn read, inline
    js = """(async (name, location) => { const S = window.__sky, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      if (S.F) S.endFlight(); for (let i = 0; i < 100 && S.F; i++) await sleep(50);
      S.hangar.load(S.presets.find((p) => p.name === name)); S.controls.setThrottle(0);
      S.startFlight({ location, online: false, start: 'runway', mode: 'free', weather: 'clear', time: 10 });
      for (let i = 0; i < 3000 && !S.F; i++) await sleep(10);
      const F = S.F, r = { name, location, start: F.cfgStart, x: F.ac.x.toArray(), q: F.ac.q.toArray(), v: F.ac.v.toArray() };
      for (let i = 0; i < 6000 && (!(F.t > 0) || F.warm); i++) await sleep(20); return r; })"""
    out = {}
    for n in names:
        out[f'{loc}/{n}'] = await cdp.js(f'{js}({json.dumps(n)}, {json.dumps(loc)})', timeout=180)
    return out


if __name__ == '__main__':
    sys.exit(main())
