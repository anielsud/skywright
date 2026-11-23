#!/usr/bin/env python3
"""Landing gear geometry check: runs tools/test/gearcheck.js on the Node tier (no browser; one build per case).

Run from anywhere:  python3 tools/test/gearcheck.py [--only Kestrel] [--random 20] [--seed 1] [--speed 6] [-v] [--dump]
Builds every preset (as is, resized, mirrored) plus seeded random player builds (gear, floats and skids dropped on
bodies, wings, wingtips, pods and flaps the way the hangar places them, some resized or rotated, and mirrored) and
checks that no strut passes through a part (control surfaces included), every leg/brace ends on a solid skin, every
wheel stands upright, and mirrored gear mirrors exactly. Exits non-zero on any failure. Needs Node.
"""
import argparse, json, os, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--only', help='check just builds whose name contains this (e.g. a preset name)')
    ap.add_argument('--random', type=int, default=20, help='number of random player builds (default 20)')
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--speed', type=int, default=6, help='number of random builds on the speed parts (Chined Body, Spike Ramjet) (default 6)')
    ap.add_argument('-v', '--verbose', action='store_true', help='list every build, not just failures')
    ap.add_argument('--dump', action='store_true', help='print the design JSON of each failing build')
    ap.add_argument('--jobs', type=int, help='Node workers (default: cores - 2)')
    args = ap.parse_args()
    out = os.path.join(tempfile.mkdtemp(prefix='skygear-'), 'report.json')
    env = {**os.environ, 'SKY_GEAR_RANDOM': str(args.random), 'SKY_GEAR_SEED': str(args.seed), 'SKY_GEAR_SPEED': str(args.speed)}
    cmd = ['node', os.path.join(ROOT, 'tools/test/node/run.mjs'), 'gearcheck', '--json', out] + (['--only', args.only] if args.only else []) + (['--jobs', str(args.jobs)] if args.jobs else [])
    rc = subprocess.run(cmd, cwd=ROOT, env=env, stdout=subprocess.DEVNULL).returncode
    try:
        res = json.load(open(out))['checks']
    except (OSError, ValueError):
        print('FAIL  no report from the Node run'); sys.exit(1)
    failed = [r for r in res if not r['ok']]
    for r in res:
        if not r['ok'] or args.verbose:
            print(f"{'FAIL' if not r['ok'] else 'ok  '} {r.get('label', r['name'])} ({r.get('gear', '?')} gear)")
            for b in r.get('bad') or ([r['why']] if not r['ok'] else []):
                print('      ' + b)
            if args.dump and r.get('design'):
                print('      design: ' + json.dumps(r['design']))
    print(f"{len(res) - len(failed)}/{len(res)} builds pass ({sum(r.get('gear', 0) for r in res)} gear parts checked)")
    sys.exit(1 if failed or rc else 0)


if __name__ == '__main__':
    main()
