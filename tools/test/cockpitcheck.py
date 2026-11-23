#!/usr/bin/env python3
"""Skywright cockpit check: every cockpit view (one per seat, src/stations.js) of every stock vehicle (as is, resized,
mirrored), multi-station builds (bomber gunners, twin cockpits, resized and turned canopies, a capsule, a build with no
cockpit) and seeded random player builds, built as flight Aircraft (in Node: tools/test/cockpitcheck.js on the Node
tier's worker pool, one vehicle per case). Fails when an eye point is
  - outside its cockpit (the box of its seat's part and figure),
  - inside solid geometry (within 3 cm of a surface, or looking out through the backs of one-sided surfaces), or
  - without a clear line of sight forward out of the glass (3 of 5 rays ahead must meet glass, or nothing solid
    within 1.2 m).
It also lists the stations of each vehicle.

Run from anywhere:  python3 tools/test/cockpitcheck.py [--random 20] [--seed 7] [--only Kestrel] [--json out.json] [--verbose]
Needs Node (no browser). See tools/test/README.md.
"""
import argparse, json, os, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))


def main(a):
    out = a.json or os.path.join(tempfile.mkdtemp(prefix='skyck-'), 'report.json')
    env = {**os.environ, 'SKY_COCKPIT_RANDOM': str(a.random), 'SKY_COCKPIT_SEED': str(a.seed)}
    cmd = ['node', os.path.join(ROOT, 'tools/test/node/run.mjs'), 'cockpitcheck', '--json', out] + (['--only', a.only] if a.only else []) + (['--jobs', str(a.jobs)] if a.jobs else [])
    rc = subprocess.run(cmd, cwd=ROOT, env=env, stdout=subprocess.DEVNULL if not a.verbose else None).returncode
    try:
        checks = json.load(open(out))['checks']
    except (OSError, ValueError):
        print('FAIL  no report from the Node run'); return 1
    by = {}
    for c in checks:
        by.setdefault(c.get('vehicle', c['name']), []).append(c)
    bad = views = notes = 0
    for name, cs in by.items():
        err = [c for c in cs if not c.get('station') and not c['ok']]
        if err:
            bad += 1; print(f'FAIL  {name:<52} error: {err[0].get("why", "")[:300]}'); continue
        sts = [c['station'] for c in cs if c.get('station')]; views += len(sts)
        n = sum(1 for s in sts if s['issues']); bad += n
        print(f'{"FAIL" if n else "PASS"}  {name:<52} {len(sts)} view(s): {", ".join(s["name"] for s in sts)}')
        for s in sts:
            notes += bool(s.get('note'))
            if s['issues'] or a.verbose or s.get('note'):
                print(f'      {s["name"]:<16} {s["part"]:<13} eye {s["at"]}  clearance {s.get("clear", "-")} m  forward {s.get("los", "-")}/5  {"; ".join(s["issues"]) or s.get("note", "")}')
    print(f'\n{len(by)} vehicles, {views} cockpit views, {bad} problems ({notes} cockpits buried in a body: eye above them, checked)')
    return 1 if bad or rc else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--random', type=int, default=20, help='number of random player builds (default 20)')
    ap.add_argument('--seed', type=int, default=7, help='seed for the random builds (default 7)')
    ap.add_argument('--only', help='only vehicles whose name contains this')
    ap.add_argument('--json', help='write the Node run report here (checks with each station in full)')
    ap.add_argument('--verbose', action='store_true', help="print every view, not only failing ones (and the Node run's own output)")
    ap.add_argument('--jobs', type=int, help='Node workers (default: cores - 2)')
    sys.exit(main(ap.parse_args()))
