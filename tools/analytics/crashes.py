#!/usr/bin/env python3
"""Why do cars and bikes crash, and does the loop work? A crash report from Skywright's PostHog analytics.

Same key setup as report.py (POSTHOG_API_KEY with query:read, POSTHOG_PROJECT_ID):

    python3 tools/analytics/crashes.py [--days 7] [--device d-...] [--kind car]

Sections:
  - part_lost: what broke parts off (hit / scrape / hard_landing / overload / wall / tree...), where (stunt park
    feature or canyon-jump phase), how fast, and the vehicle's state (upside down? on a ramp? frame time?)
  - loop_attempt: each go at the loop-the-loop: made / fell_off / rolled_back / left_deck / destroyed, with speeds
  - flight_end physics health (diag): numeric resets, deep push-outs of a ramp (and on which feature), spin clamps,
    auto-flips, slow frames (under 20 fps the game itself runs in slow motion)
"""
import argparse, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from report import hogql, table  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=7)
    ap.add_argument('--device', help="one device's distinct_id (Settings shows it)")
    ap.add_argument('--kind', default='car', help="vehicle kind (car covers bikes too); '' for all")
    a = ap.parse_args()
    w = f"timestamp > now() - INTERVAL {a.days} DAY"
    if a.device: w += f" AND distinct_id = '{a.device}'"
    if a.kind: w += f" AND properties.kind = '{a.kind}'"
    Q = {
        'Parts lost: cause and place': f"""
            SELECT properties.plane AS vehicle, properties.cause AS cause, properties.feature AS feature, count() AS n,
                   round(avg(toFloat(properties.impact_kmh))) AS impact_kmh, round(avg(toFloat(properties.limit_kmh))) AS limit_kmh,
                   round(avg(toFloat(properties.speed_kmh))) AS speed_kmh, round(avg(toFloat(properties.up_y)), 2) AS up_y,
                   round(avg(toFloat(properties.frame_ms))) AS frame_ms
            FROM events WHERE event = 'part_lost' AND {w} GROUP BY vehicle, cause, feature ORDER BY n DESC LIMIT 40""",
        'Latest parts lost': f"""
            SELECT timestamp, properties.plane, properties.location, properties.cause, properties.part_names, properties.feature,
                   properties.loop_progress, properties.impact_kmh, properties.speed_kmh, properties.g, properties.up_y,
                   properties.on_ramp, properties.surf, properties.frame_ms, properties.realism
            FROM events WHERE event = 'part_lost' AND {w} ORDER BY timestamp DESC LIMIT 30""",
        'Loop attempts': f"""
            SELECT properties.plane AS vehicle, properties.outcome AS outcome, count() AS n, round(avg(toFloat(properties.progress)), 2) AS progress,
                   round(avg(toFloat(properties.entry_kmh))) AS entry_kmh, round(avg(toFloat(properties.top_kmh))) AS top_kmh,
                   round(avg(toFloat(properties.min_kmh))) AS min_kmh, round(avg(toFloat(properties.max_g)), 1) AS max_g,
                   round(avg(toFloat(properties.air_s)), 2) AS air_s, sum(toInt(properties.parts_lost)) AS parts_lost, round(avg(toFloat(properties.fps))) AS fps
            FROM events WHERE event = 'loop_attempt' AND {w} GROUP BY vehicle, outcome ORDER BY n DESC""",
        'Physics health per flight (flight_end.diag)': f"""
            SELECT properties.plane AS vehicle, properties.start AS start, count() AS flights,
                   sum(toInt(properties.diag.nanResets)) AS nan_resets, round(avg(toFloat(properties.diag.deepPens)), 1) AS deep_pens,
                   round(max(toFloat(properties.diag.maxPen)), 2) AS max_pen_m, sum(toInt(properties.diag.spinClamps)) AS spin_clamps,
                   sum(toInt(properties.diag.recovers)) AS auto_flips, sum(toInt(properties.diag.gearCollapses)) AS gear_collapses,
                   round(avg(toFloat(properties.diag.slow_frames))) AS slow_frames, max(toInt(properties.diag.worst_frame_ms)) AS worst_ms
            FROM events WHERE event = 'flight_end' AND properties.diag IS NOT NULL AND {w} GROUP BY vehicle, start ORDER BY flights DESC""",
        'Where the deep push-outs happen': f"""
            SELECT properties.deep_pen_at AS by_feature, properties.plane, properties.end_title, timestamp
            FROM events WHERE event = 'flight_end' AND properties.deep_pen_at IS NOT NULL AND {w} ORDER BY timestamp DESC LIMIT 20""",
    }
    out = [f'# Crash report (last {a.days} days{", device " + a.device if a.device else ""})\n']
    for title, q in Q.items():
        cols, rows = hogql(q)
        out.append(f'## {title}\n\n{table(cols, rows, 40)}')
    print('\n'.join(out))


if __name__ == '__main__':
    main()
