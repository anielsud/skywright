#!/usr/bin/env python3
"""Skywright tests, one entry point: the Node tier (logic, physics, geometry: tools/test/node/run.mjs, worker pool, no
browser) and the browser jobs (what needs a real page: boot, UI, audio, shaders, the real game loop; tools/test/jobs.py,
one Chrome per job, one World per map, the jobs run in parallel).

  python3 tools/test/run.py                 # everything: the Node tier, then every browser job
  python3 tools/test/run.py --changed       # only the suites covering files changed vs origin/main (and uncommitted)
  python3 tools/test/run.py bikeride nyc    # these suites / jobs
  python3 tools/test/run.py --list          # the suites, their tier and what they cover
  python3 tools/test/run.py --ci nyc        # a job with CI runner settings (jobs.py --ci --quality low)

A Node suite declares the files it covers in its module (export const nodeSuite = { files }); a browser job in JOBS
below. A change to the test harness itself, or to a file no suite claims, runs everything (--changed).
The old one-suite-one-browser scripts still around (smoke.py, placecheck.py, startbakes.py's stunts part,
tunnelcheck.py --ui) still run on their own, but are no longer listed here:
their checks are moving into the jobs (#278).
Exits non-zero if any suite fails.
"""
import argparse, fnmatch, json, os, subprocess, sys, time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
# browser jobs (tools/test/jobs/<job>.js, run by jobs.py): the files they cover (globs, repo-relative). Every job boots
# the game and checks every step for console errors and shader stalls, so any source change wants all of them.
PAGE = ['src/*', 'index.html', 'style.css', 'sw.js', 'assets/*', 'vendor/*', 'tools/test/jobs.py', 'tools/test/jobs/harness.js', 'tools/test/jobs/wiring.js']
JOBS = {
    'hangar': PAGE + ['tools/test/jobs/hangar.js', 'tools/test/tunnelcheck.js'],
    'nyc': PAGE + ['tools/test/jobs/nyc.js', 'tools/test/smoke.js', 'tools/test/padcheck.js', 'tools/test/helipadcheck.js', 'tools/test/shadercheck.js', 'tools/test/startbakes.js', 'tools/test/stunts.js', 'tools/test/waterpark.js', 'tools/test/walls.js', 'tools/bake/*'],
    'islands': PAGE + ['tools/test/jobs/islands.js', 'tools/test/smoke.js', 'tools/test/padcheck.js', 'tools/test/shadercheck.js', 'tools/test/startbakes.js', 'tools/test/sr71flight.js', 'tools/bake/*'],
    'canyon-lauterbrunnen': PAGE + ['tools/test/jobs/canyon-lauterbrunnen.js', 'tools/test/smoke.js', 'tools/test/padcheck.js', 'tools/test/shadercheck.js', 'tools/test/startbakes.js', 'tools/test/restart.js', 'tools/test/jobs/wiring.js', 'tools/bake/*'],
}
# --ci: jobs.py --ci --quality low (a CI runner's software GPU; Low: ~100 shader programs a place instead of 140)
HARNESS = ['tools/test/run.py', 'tools/test/node/*', 'tools/test/jobs.py', 'tools/test/jobs/harness.js']  # changing these runs everything


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
    ap.add_argument('suites', nargs='*'); ap.add_argument('--changed', action='store_true'); ap.add_argument('--ci', action='store_true', help='CI runner settings for the jobs: jobs.py --ci --quality low'); ap.add_argument('--tier', choices=['node', 'browser'], help='only this tier'); ap.add_argument('--exclude', action='append', default=[], help='leave this suite out (repeatable)'); ap.add_argument('--list', action='store_true'); ap.add_argument('--plan', action='store_true', help='print the picked suites as a JSON list and run nothing')
    ap.add_argument('--quality', help='graphics setting for the jobs (default: jobs.py\'s; --ci: low)')
    ap.add_argument('--jobs', type=int, help='Node workers (default: cores - 2)')
    a = ap.parse_args()
    node = node_suites()
    allsuites = {**{k: ('node', v) for k, v in node.items()}, **{k: ('browser', v) for k, v in JOBS.items() if k not in node}}
    if a.list:
        for k, (tier, files) in allsuites.items(): print(f'{k:14} {tier:8} {", ".join(files)}')
        return 0
    pick = a.suites or list(allsuites)
    say = (lambda *x: print(*x, file=sys.stderr)) if a.plan else print  # (--plan: stdout is just the JSON)
    if a.changed:
        ch = changed_files()
        if any(covers(HARNESS, f) for f in ch) or any(not any(covers(v[1], f) for v in allsuites.values()) for f in ch if f.startswith('src/')):
            say(f'{len(ch)} changed files: the harness or an unclaimed source changed, running everything')
        else:
            pick = [k for k, (_, files) in allsuites.items() if any(covers(files, f) for f in ch)]
            say(f'{len(ch)} changed files -> {", ".join(pick) or "no suites"}')
    if a.tier: pick = [k for k in pick if allsuites.get(k, ('',))[0] == a.tier]
    pick = [k for k in pick if k not in a.exclude]
    if a.plan:
        print(json.dumps(pick))
        return 0
    t0, failed = time.time(), []
    nodes = [k for k in pick if allsuites.get(k, ('',))[0] == 'node']
    if nodes:
        cmd = ['node', os.path.join(ROOT, 'tools/test/node/run.mjs'), *nodes] + (['--jobs', str(a.jobs)] if a.jobs else [])
        if subprocess.run(cmd, cwd=ROOT).returncode: failed.append('node: ' + ', '.join(nodes))
    jobs = [k for k in pick if allsuites.get(k, ('',))[0] == 'browser']
    if jobs:  # (one jobs.py for all of them: each job in its own Chrome, all at once)
        print(f'\n=== browser jobs: {", ".join(jobs)}', flush=True)
        q = a.quality or ('low' if a.ci else None)
        extra = (['--ci'] if a.ci else []) + (['--quality', q] if q else [])
        if subprocess.run([sys.executable, os.path.join(ROOT, 'tools/test/jobs.py'), *jobs, *extra], cwd=ROOT).returncode: failed.append('jobs: ' + ', '.join(jobs))
    print(f"\n{'FAIL' if failed else 'PASS'}  {len(pick)} suites in {time.time() - t0:.0f} s" + (f": failed {', '.join(failed)}" if failed else ''))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
