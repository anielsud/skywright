#!/usr/bin/env python3
"""What are kids building? A report from Skywright's anonymous PostHog analytics.

Needs a PostHog *personal* API key with query access (PostHog > Settings > Personal API keys, scope "query:read"),
which is different from the public write-only key in src/analytics.js:

    export POSTHOG_API_KEY=phx_...          # never commit this
    export POSTHOG_PROJECT_ID=12345         # PostHog > Settings > Project ID
    python3 tools/analytics/report.py [--days 30] [--json out.json]

Prints a Markdown report: what kinds of vehicles get built and flown, which presets they start from, the most used parts,
the most-flown custom builds (with share codes you can paste into Vehicles > Share / import to look at them), builds
that never get airborne (and the Flight check warnings they showed), and how people work in the hangar.
"""
import argparse, json, os, sys, urllib.request

HOST = os.environ.get('POSTHOG_HOST', 'https://eu.posthog.com')


def hogql(q):
    key, proj = os.environ.get('POSTHOG_API_KEY'), os.environ.get('POSTHOG_PROJECT_ID')
    if not key or not proj:
        sys.exit('Set POSTHOG_API_KEY (personal key, query:read) and POSTHOG_PROJECT_ID first.')
    req = urllib.request.Request(f'{HOST}/api/projects/{proj}/query/', method='POST',
                                 data=json.dumps({'query': {'kind': 'HogQLQuery', 'query': q}}).encode(),
                                 headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        res = json.load(r)
    return res.get('columns', []), res.get('results', [])


def table(cols, rows, limit=25):
    if not rows:
        return '_none yet_\n'
    out = '| ' + ' | '.join(cols) + ' |\n|' + '---|' * len(cols) + '\n'
    for r in rows[:limit]:
        out += '| ' + ' | '.join('' if v is None else str(v) for v in r) + ' |\n'
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=30)
    ap.add_argument('--json', help='also write raw results here')
    a = ap.parse_args()
    since = f"timestamp > now() - INTERVAL {a.days} DAY"
    Q = {
        'Flights by vehicle kind and starting point': f"""
            SELECT properties.design.kind AS kind, properties.design.base AS started_from, count() AS flights,
                   count(DISTINCT properties.design.design_hash) AS designs, count(DISTINCT distinct_id) AS devices
            FROM events WHERE event = 'flight_start' AND {since} GROUP BY kind, started_from ORDER BY flights DESC""",
        'How flights end, by kind': f"""
            SELECT properties.kind AS kind, properties.outcome AS outcome, count() AS n, round(avg(toFloat(properties.air_seconds))) AS avg_air_s
            FROM events WHERE event = 'flight_end' AND {since} GROUP BY kind, outcome ORDER BY n DESC""",
        'Most-flown custom builds': f"""
            SELECT properties.design.design_hash AS design, any(properties.design.base) AS started_from, any(properties.design.kind) AS kind,
                   any(properties.design.parts) AS parts, count() AS flights, count(DISTINCT distinct_id) AS devices,
                   any(properties.design.thrust_weight) AS tw, any(properties.design.stall_kmh) AS stall_kmh
            FROM events WHERE event = 'flight_start' AND properties.plane = 'custom' AND {since}
            GROUP BY design ORDER BY flights DESC LIMIT 25""",
        'Custom builds that never got airborne (kind = plane/helicopter)': f"""
            SELECT e.properties.design_hash AS design, count() AS flights, max(toFloat(e.properties.air_seconds)) AS best_air_s
            FROM events e WHERE e.event = 'flight_end' AND e.properties.plane = 'custom' AND e.properties.kind IN ('plane', 'helicopter', 'seaplane') AND e.{since}
            GROUP BY design HAVING best_air_s < 3 ORDER BY flights DESC LIMIT 25""",
        'Flight check warnings shown at takeoff': f"""
            SELECT arrayJoin(JSONExtractArrayRaw(properties.design.warnings)) AS warning, count() AS flights
            FROM events WHERE event = 'flight_start' AND {since} GROUP BY warning ORDER BY flights DESC LIMIT 20""",
        'Hangar habits per flown build': f"""
            SELECT round(avg(toFloat(properties.build.parts_added)), 1) AS parts_added, round(avg(toFloat(properties.build.parts_removed)), 1) AS removed,
                   round(avg(toFloat(properties.build.undos)), 1) AS undos, round(avg(toFloat(properties.build.hangar_seconds))) AS hangar_s,
                   round(avg(toFloat(properties.design.parts)), 1) AS parts, round(avg(toFloat(properties.design.mirrored)), 1) AS mirrored,
                   round(avg(toFloat(properties.design.resized)), 1) AS resized
            FROM events WHERE event = 'flight_start' AND {since}""",
    }
    report, raw = [f'# What kids are building (last {a.days} days)\n'], {}
    for title, q in Q.items():
        cols, rows = hogql(q)
        raw[title] = {'columns': cols, 'rows': rows}
        report.append(f'## {title}\n\n{table(cols, rows)}')
    # most used parts across distinct custom designs (one count per design, so a 30-engine build doesn't drown everything)
    cols, rows = hogql(f"""SELECT properties.design.design_hash AS h, any(properties.design.part_counts) AS pc FROM events
                          WHERE event = 'flight_start' AND properties.plane = 'custom' AND {since} GROUP BY h""")
    usage = {}
    for _, pc in rows:
        for pid, n in (json.loads(pc) if isinstance(pc, str) else (pc or {})).items():
            u = usage.setdefault(pid, [0, 0]); u[0] += 1; u[1] += n
    top = sorted(usage.items(), key=lambda kv: -kv[1][0])
    report.append('## Parts used in custom builds\n\n' + table(['part', 'designs using it', 'total placed'], [[k, v[0], v[1]] for k, v in top], 40))
    # share codes of the most-flown custom builds, to load in the hangar
    cols, rows = hogql(f"""SELECT properties.design.design_hash AS h, count() AS n, any(properties.design.design_code) AS code FROM events
                          WHERE event = 'flight_start' AND properties.plane = 'custom' AND {since} GROUP BY h ORDER BY n DESC LIMIT 10""")
    report.append('## Share codes of the top custom builds\n\nPaste into Vehicles > Share / import to see them.\n')
    for h, n, code in rows:
        report.append(f'- `{h}` ({n} flights): `{code}`')
    raw['top_codes'] = rows
    print('\n'.join(report))
    if a.json:
        json.dump(raw, open(a.json, 'w'), indent=1, default=str)


if __name__ == '__main__':
    main()
