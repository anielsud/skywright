#!/usr/bin/env python3
"""Skywright tests, one entry point: the Node tier (logic, physics, geometry: tools/test/node/run.mjs, worker pool, no
browser) and the browser tier (what needs a real page: boot, UI, audio, shaders, the real game loop).

  python3 tools/test/run.py                 # everything
  python3 tools/test/run.py --changed       # only the suites covering files changed vs origin/main (and uncommitted)
  python3 tools/test/run.py bikeride smoke  # these suites
  python3 tools/test/run.py --list          # the suites, their tier and what they cover

A Node suite declares the files it covers in its module (export const nodeSuite = { files }); a browser suite in
BROWSER below. A change to the test harness itself, or to a file no suite claims, runs everything (--changed).
Exits non-zero if any suite fails.
"""
import argparse, fnmatch, json, os, subprocess, sys, time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
# browser-tier suites: their command and the files they cover (globs, repo-relative)
BROWSER = {
    'smoke': (['smoke.py', '--quality', 'medium', '--no-node'], ['src/*', 'index.html', 'style.css', 'sw.js', 'assets/*', 'vendor/*', 'tools/test/smoke.js', 'tools/test/sr71flight.js']),  # (also the shader check; medium: shadows on)
    'restart': (['restart.py'], ['src/main.js', 'src/startChoice.js', 'tools/test/restart.js', 'src/world.js', 'src/destruction.js', 'src/stuntPark.js', 'src/waterPark.js', 'src/launchpad.js', 'src/helipad.js', 'src/flora.js']),
    # (stunts, waterpark, walls: Node suites; their browser part, at New York and the Grand Canyon, is placecheck)
    'placecheck': (['placecheck.py'], ['src/main.js', 'src/stunt*.js', 'src/evelJump.js', 'src/waterPark.js', 'src/landStart.js', 'src/world.js', 'src/realworld.js', 'src/realCity.js', 'src/destruction.js', 'src/aircraft.js', 'tools/test/placecheck.py', 'tools/test/stunts.js', 'tools/test/waterpark.js', 'tools/test/walls.js']),
    'padcheck': (['padcheck.py'], ['src/launchpad.js', 'src/main.js', 'src/startChoice.js', 'tools/test/padcheck.js', 'src/aircraft.js', 'src/world.js']),
    'helipadcheck': (['helipadcheck.py'], ['src/helipad.js', 'src/main.js', 'src/startChoice.js', 'tools/test/padcheck.js', 'tools/test/helipadcheck.js', 'src/aircraft.js', 'src/world.js', 'src/nyc*.js']),
    'startbakes-stunts': (['startbakes.py', '--only', 'stunts'], ['src/stuntPark.js', 'src/stuntSite.js', 'src/realworld.js', 'src/world.js', 'tools/bake/*', 'tools/test/startbakes.*']),  # (its views: the Node suite startbakes)
    'tunnelcheck-ui': (['tunnelcheck.py', '--ui'], ['src/windTunnel.js', 'src/tunnel*.js', 'src/main.js', 'tools/test/tunnelcheck.*']),  # (its lift curves and forces: the Node suite tunnelcheck)
}
# extra arguments on a CI runner (--ci; software WebGL: seconds a frame, so smaller windows, fewer repeats, no frame-time limits)
CI_ARGS = {
    'restart': ['--size', '480x300', '--restarts', '3'],
    'tunnelcheck-ui': ['--size', '480x300', '--max-ms', '1e9', '--max-cpu', '1e9'],
}
HARNESS = ['tools/test/run.py', 'tools/test/node/*', 'tools/test/smoke.py']  # changing these runs everything


def node_suites():
    out = subprocess.run(['node', os.path.join(ROOT, 'tools/test/node/run.mjs'), '--files'], capture_output=True, text=True, cwd=ROOT)
    return json.loads(out.stdout.strip().splitlines()[-1]) if out.returncode == 0 else {}


def changed_files():
    sh = lambda c: subprocess.run(c, shell=True, capture_output=True, text=True, cwd=ROOT).stdout.split()
    base = (sh('git merge-base origin/main HEAD') or ['HEAD'])[0]
    return sorted(set(sh(f'git diff --name-only {base}') + sh('git ls-files --others --exclude-standard')))


def covers(globs, f):
    return any(fnmatch.fnmatch(f, g) for g in globs)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('suites', nargs='*'); ap.add_argument('--changed', action='store_true'); ap.add_argument('--ci', action='store_true', help='CI runner settings (CI_ARGS)'); ap.add_argument('--list', action='store_true')
    ap.add_argument('--jobs', type=int, help='Node workers (default: cores - 2)')
    a = ap.parse_args()
    node = node_suites()
    allsuites = {**{k: ('node', v) for k, v in node.items()}, **{k: ('browser', v[1]) for k, v in BROWSER.items() if k not in node}}
    if a.list:
        for k, (tier, files) in allsuites.items(): print(f'{k:14} {tier:8} {", ".join(files)}')
        return 0
    pick = a.suites or list(allsuites)
    if a.changed:
        ch = changed_files()
        if any(covers(HARNESS, f) for f in ch) or any(not any(covers(v[1], f) for v in allsuites.values()) for f in ch if f.startswith('src/')):
            print(f'{len(ch)} changed files: the harness or an unclaimed source changed, running everything')
        else:
            pick = [k for k, (_, files) in allsuites.items() if any(covers(files, f) for f in ch)]
            print(f'{len(ch)} changed files -> {", ".join(pick) or "no suites"}')
    t0, failed = time.time(), []
    nodes = [k for k in pick if allsuites.get(k, ('',))[0] == 'node']
    if nodes:
        cmd = ['node', os.path.join(ROOT, 'tools/test/node/run.mjs'), *nodes] + (['--jobs', str(a.jobs)] if a.jobs else [])
        if subprocess.run(cmd, cwd=ROOT).returncode: failed.append('node: ' + ', '.join(nodes))
    for k in pick:
        if allsuites.get(k, ('',))[0] != 'browser': continue
        print(f'\n=== {k}', flush=True)
        if subprocess.run([sys.executable, os.path.join(ROOT, 'tools/test', BROWSER[k][0][0]), *BROWSER[k][0][1:], *(CI_ARGS.get(k, []) if a.ci else [])], cwd=ROOT).returncode: failed.append(k)
    print(f"\n{'FAIL' if failed else 'PASS'}  {len(pick)} suites in {time.time() - t0:.0f} s" + (f": failed {', '.join(failed)}" if failed else ''))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
