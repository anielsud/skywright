#!/usr/bin/env python3
"""Skywright wall test: cars and bikes driven into buildings must stay out of them. Two tiers:

  Node (tools/test/walls.js nodeSuite, run by tools/test/node/run.mjs, headless):
  - the wall-contact code (aircraft.js wallContacts) on stand-in buildings on flat ground (square to the street,
    turned 27 degrees like an OpenStreetMap footprint, a New York tower whose box starts 1.5 m above the street): the
    Dune Buggy and the Dirt Bike at 5, 15, 30 and 45 m/s, straight on, at 35 degrees and at 60 degrees the other way,
    full gas, on the game's physics at 60 Hz. Every hull point and wheel is checked against the box every frame: none
    may get more than 0.1 m inside, and the straight-on runs must reach the wall;
  - at New York (its city boxes), Lauterbrunnen (a real village: OpenStreetMap buildings) and the Alpine Valley town
    (generated), on real Worlds built in Node: every building in the place's collision grids is among
    world.wallBoxes with its own box (asked at its middle and just outside each face); building faces with a clear,
    flat run-up near the start, and both vehicles driven into each at 30 m/s straight on and 15 m/s at 35 degrees,
    staying out and reaching the wall.
  Browser (placecheck.py --only walls): two runs through the real game loop at New York (the flight's own Dune Buggy,
  its pedal held down, building damage and all, stepped with __sky.advance) stay out too.

Run from anywhere:  python3 tools/test/walls.py [--node-only | --browser-only] [--only TEXT]
Same requirements as smoke.py (Chrome + the websockets package; Node for the Node tier). See tools/test/README.md.
"""
import argparse, asyncio, os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import placecheck  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))


def main(a):
    rc = 0
    if not a.browser_only:
        rc |= subprocess.run(['node', os.path.join(ROOT, 'tools/test/node/run.mjs'), 'walls'] + (['--only', a.only] if a.only else []), cwd=ROOT).returncode
    if not a.node_only:
        rc |= asyncio.run(placecheck.main(placecheck.parser().parse_args(['--only', 'walls', '--port', str(a.port), '--cdp-port', str(a.cdp_port)] + (['--url', a.url] if a.url else []))))
    return 1 if rc else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--node-only', action='store_true', help='only the Node tier')
    ap.add_argument('--browser-only', action='store_true', help='only the browser check (the game loop at New York)')
    ap.add_argument('--only', help='Node tier: only the cases whose descriptor contains this text (e.g. nyc, contact, "Dirt Bike")')
    ap.add_argument('--port', type=int, default=0); ap.add_argument('--cdp-port', type=int, default=0)
    ap.add_argument('--url', help='test a running server instead of serving the repo')
    sys.exit(main(ap.parse_args()))
