#!/usr/bin/env python3
"""Rooftop helipad check: boots Skywright in headless Chrome and, in New York (src/helipad.js),

  1. starts the stock Dragonfly (Pilot and Arcade) and checks it starts on the rooftop helipad: on the H, level,
     facing the view, its skids resting on the deck, the engines off; and that the building under the pad has no
     damage key (destruction.js can't knock it down);
  2. leaves it there with the throttle closed, in calm air (no wind or gusts, so every run is the same): it settles onto its skids in 2 s exactly as it does on a runway (the
     same resting attitude), then for 5 s it must not move or tilt (more than it eases on a runway), leave the deck or lift a skid, take damage, touch
     any building or report any contact event, and the rotor must stay stopped throughout;
  3. lifts off to a hover 25 m above the deck and holds it: no collision, no damage, no impact or scrape, staying
     over the pad;
  4. lands back on the pad (sinking ~2 m/s, ~0.8 m/s for the last metres): touches down gently (no hard landing), on
     the deck, and then rests there still for 4 s with both skids on the deck, in its runway resting attitude;
  5. checks that nothing else is moved to the helipad: the game's start rule (src/startChoice.js chooseStart, what
     buildFlight runs) with New York's real answers puts nothing but a helicopter on it, for every stock vehicle and
     every start choice; and a plane and a car really start (swapped into the same World) where the rule says. With
     --ref URL (a server of the main branch) their spawn poses (position, attitude, velocity) must match it exactly.
     (The Dragonfly elsewhere, on the runway: padcheck.py runs the rule with every place's real answers, and
     tools/test/startchoice.js runs it over every kind of place in Node.)

The flight's own time is stepped with __sky.advance (no frames drawn); the second realism is swapped into the same
World. Shaders compiled mid-flight at New York: smoke.py flies the Dragonfly there on the real game loop.

Run from anywhere:  python3 tools/test/helipadcheck.py [--ref http://127.0.0.1:9000] [--port N] [--shots DIR]
Same requirements as smoke.py (Chrome + the websockets package). Exits non-zero on any failure.
"""
import argparse, asyncio, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from smoke import free_port, start_server  # noqa: E402
from padcheck import session, spawns_ref, spawns, check_predicted, check_spawns  # noqa: E402

OTHERS = ['Kestrel', 'Dune Buggy']  # really started at New York: where the start rule says, not on the helipad


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--ref', help='a server of the main branch: other vehicles must spawn exactly as there')
    ap.add_argument('--url', help='check an already running server instead of serving this checkout')
    ap.add_argument('--port', type=int)
    ap.add_argument('--realism', action='append', help='pilot / arcade / sim (repeatable; default pilot and arcade)')
    ap.add_argument('--json', help='write the full report here')
    a = ap.parse_args()
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
        res = {'heli': [], 'problems': []}
        for rl in a.realism or ['pilot', 'arcade']:
            r = await cdp.js(f"import('/tools/test/helipadcheck.js').then((m) => m.heli('Dragonfly', {json.dumps(rl)}))", timeout=400)
            res['heli'].append(r)
            res['problems'] += probs.take()
        res['predicted'] = {'nyc': await cdp.js("import('/tools/test/helipadcheck.js').then((m) => m.predict())", timeout=60)}
        res['plan'] = [('nyc', OTHERS)]
        res['spawns'] = await spawns(cdp, 'nyc', OTHERS, 'helipadcheck')
        await cdp.js('window.__sky.F && window.__sky.endFlight(); 1')
        res['problems'] += probs.take()
        return res

    try:
        res = asyncio.run(session(origin, target))
        report['target'] = res
        for r in res['heli']:
            print(f"{r['name']} ({r['realism']}) at {r['location']}: start {r['start']}, pad {r['pad'] and r['pad']['name']}")
            if not check(r['start'] == 'helipad' and r['pad'], 'did not start on the helipad'):
                continue
            p, s, h, l, L, b = r['pad'], r['spawn'], r['hold'], r['lift'], r['land'], r['building']
            print(f"  pad: deck {p['deckY']:.2f} m (roof {p['roofY']:.2f}), {2 * p['D']:.1f} m square; {r['stats']}")
            print(f"  building: found {b['found']}, damage key {b['dk']}, fixed {b['fixed']}, top {b['top']}")
            print(f"  spawn: {s['off']:.2f} m off the H, level {s['level']:.5f}, skids {s['gearAboveDeck'] * 100:.1f} cm above the deck, heading {s['heading']:.3f} (pad {p['heading']:.3f}), engines {s['engines']}")
            rw = r['runway']
            print(f"  on the runway it rests at up {rw['up']:.4f} after settling {rw['sink'] * 100:.1f} cm, then creeps {rw['drift'] * 1000:.1f} mm / tilts {rw['tilt']:.2e} rad in 5 s")
            print(f"  hold: settled {h['settleSink'] * 100:.1f} cm in {h['settle']:.1f} s to up {h['up']:.4f}, then {h['seconds']:.1f} s: drift {h['drift'] * 1000:.2f} mm, tilt {h['tilt']:.2e} rad, vmax {h['vmax']:.4f}, "
                  f"off deck {h['offGround']}/{h['frames']} frames, skids down >= {h['minSkidsDown']}/{h['skids']} ({h['contact']}/{h['points']} points), lowest {h['gearAboveDeck'] * 100:.1f} cm, "
                  f"rotor spool {h['rotor']:.4f} turned {h['rotorTurned']:.4f} rad, engines {h['engines']}, events {h['events']}, hits {h['hits']}, dmg {h['dmg']:.1f}")
            print(f"  lift: off the deck after {l['liftoffAfter']} s, {l['height']:.1f} m up, hover band {l['hoverBand']:.2f} m, events {l['events']}, hits {l['hits']}, dmg {l['dmg']:.1f}, {l['alive']}/{l['parts']} parts")
            print(f"  land: touchdown {L['touch']}, {L['off']:.2f} m off the H, up {L['level']:.4f}, lowest {L['gearAboveDeck'] * 100:.1f} cm, skids down >= {L['minSkidsDown']}/{L['skids']} ({L['contact']}/{L['points']} points), v {L['v']:.4f}, "
                  f"settled drift {L['settleDrift'] * 1000:.2f} mm tilt {L['settleTilt']:.2e}, off deck {L['offGround']}, events {L['events']}, hits {L['hits']}, dmg {L['dmg']:.1f}, {L['alive']}/{L['parts']} parts")
            print(f"  max distance from the H {r['maxOff']:.2f} m, lowest up {r['minUp']:.4f}")
            check(b['found'] and b['dk'] is None and b['fixed'], 'the building under the pad is destructible (or missing)')
            check(s['off'] < 0.5, f"spawned {s['off']:.2f} m off the H")
            check(s['level'] > 0.999, 'not level at spawn')
            check(abs(s['gearAboveDeck']) < 0.01, f"skids {s['gearAboveDeck']:.3f} m from the deck at spawn (not resting on it)")
            check(abs((s['heading'] - p['heading'] + 3.14159) % 6.28318 - 3.14159) < 0.02, 'not facing the pad\'s view')
            check(not s['engines'], 'engines running at spawn')
            check(h['seconds'] >= 4.99, 'held for less than 5 s')
            check(h['rotor'] < 0.02 and h['rotorTurned'] < 0.05 and not h['engines'], 'the rotor turned while parked')
            check(abs(h['up'] - rw['up']) < 0.002 and abs(h['settleSink'] - rw['sink']) < 0.01, 'rests differently from on a runway')
            # (on its skids it still eases a few cm in those 5 s, on the runway just the same: compare with that)
            check(h['drift'] < min(0.05, rw['drift'] * 1.3 + 0.005) and h['tilt'] < min(0.01, rw['tilt'] * 1.3 + 0.002) and h['vmax'] < 0.08, 'moved while parked (more than on the runway)')
            check(h['offGround'] == 0 and h['minSkidsDown'] == h['skids'] and abs(h['gearAboveDeck']) < 0.03, 'skids not resting on the deck while parked')
            check(h['hits'] == 0 and h['dmg'] == 0 and not ({'impact', 'scrape', 'debris', 'wreck', 'touch'} & set(h['events'])), 'contact or damage while parked')
            check(l['liftoffAfter'] is not None and l['height'] > 24 and not l['dead'], 'did not lift off to a hover')
            check(l['hoverBand'] < 2.0, f"hover not steady ({l['hoverBand']:.2f} m)")
            check(l['hits'] == 0 and l['dmg'] == 0 and l['alive'] == l['parts'] and not ({'impact', 'scrape', 'debris', 'wreck'} & set(l['events'])), 'collision or damage on lift-off')
            check(L['touch'] is not None and -L['touch']['vy'] < 1.5 and not L['hardLanding'], f"touchdown not gentle: {L['touch']}")
            check(L['onDeck'] and L['off'] < 3, f"landed {L['off']:.2f} m off the H")
            check(abs(L['level'] - rw['up']) < 0.003 and L['minSkidsDown'] == L['skids'] and abs(L['gearAboveDeck']) < 0.03 and L['offGround'] == 0, 'not resting on the deck after landing')
            check(L['settleDrift'] < min(0.05, rw['drift'] * 1.3 + 0.005) and L['settleTilt'] < min(0.01, rw['tilt'] * 1.3 + 0.002) and L['v'] < 0.05, 'not stable after landing (more than on the runway)')
            check(L['hits'] == 0 and L['dmg'] == 0 and L['alive'] == L['parts'] and not ({'impact', 'scrape', 'debris', 'wreck'} & set(L['events'])), 'collision or damage on landing')
        check_predicted(check, res['predicted'], 'helipad', 'helicopter', 'heli')
        check(any(p['start'] == 'helipad' for p in res['predicted']['nyc']), 'the start rule puts no helicopter on the helipad')
        sp = res['spawns']
        check_spawns(check, sp, res['predicted'], 'helipad')
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
    for loc, ns in plan:
        out.update(await spawns_ref(cdp, loc, ns))
    await cdp.js('window.__sky.F && window.__sky.endFlight(); 1')
    return out


if __name__ == '__main__':
    sys.exit(main())
