"""Build data/site/weather_analogue.json from the Curiosity REMS daily weather reports.

The demo site has no weather station. As a measured reference for the same season, this takes the
daily reports of the Rover Environmental Monitoring Station (REMS) on Curiosity at Gale crater
(4.6 S, 137.4 E) for the sols whose solar longitude matches the scenario (Ls 20 to 24, early
northern spring) and summarises them. Gale is at a similar latitude but it is another place and a
lower elevation: the output is an analogue, and the dashboard says so.

Input: the feed saved once (the engine never fetches it):

    curl "https://mars.nasa.gov/rss/api/?feed=weather&category=msl&feedtype=json" -o data_raw/weather/msl_rems_weather.json

Usage:
    python tools/make_weather_analogue.py data_raw/weather/msl_rems_weather.json

Credit: NASA/JPL-Caltech/CAB (CSIC-INTA).
"""
import json
import os
import statistics
import sys
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "site", "weather_analogue.json")
LS_RANGE = (20, 24)


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def summary(values):
    v = [x for x in values if x is not None]
    if not v:
        return None
    q = statistics.quantiles(v, n=10) if len(v) >= 10 else [min(v)] * 9
    # median with the 10th and 90th percentiles; single-sol sensor glitches stay out of the range
    return dict(median=round(statistics.median(v), 1), p10=round(q[0], 1), p90=round(q[-1], 1), n=len(v))


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    with open(sys.argv[1], encoding="utf8") as f:
        feed = json.load(f)
    sols = [s for s in feed["soles"] if num(s.get("ls")) is not None and LS_RANGE[0] <= num(s["ls"]) <= LS_RANGE[1]]
    if not sols:
        sys.exit("no sols in the Ls range")
    sols.sort(key=lambda s: int(s["sol"]))
    uv = Counter(s["local_uv_irradiance_index"] for s in sols if s.get("local_uv_irradiance_index") not in (None, "--"))
    years = sorted({s["terrestrial_date"][:4] for s in sols})
    out = dict(
        kind="measured",
        analogue=True,
        note="Measured by Curiosity at Gale crater (4.6 S, 137.4 E) on sols with the same season as the scenario. "
             "Another site at a similar latitude: an analogue, not a measurement at Melas Chasma.",
        source="Curiosity REMS daily weather reports, Ls %d to %d, Earth years %s to %s" % (LS_RANGE[0], LS_RANGE[1], years[0], years[-1]),
        credit="NASA/JPL-Caltech/CAB (CSIC-INTA)",
        url="https://mars.nasa.gov/rss/api/?feed=weather&category=msl&feedtype=json",
        ls_range=list(LS_RANGE),
        sols=len(sols), first_sol=int(sols[0]["sol"]), last_sol=int(sols[-1]["sol"]),
        ground_min_c=summary(num(s.get("min_gts_temp")) for s in sols),
        ground_max_c=summary(num(s.get("max_gts_temp")) for s in sols),
        air_min_c=summary(num(s.get("min_temp")) for s in sols),
        air_max_c=summary(num(s.get("max_temp")) for s in sols),
        pressure_pa=summary(num(s.get("pressure")) for s in sols),
        uv_index=dict(uv.most_common()),
        uv_index_usual=uv.most_common(1)[0][0] if uv else None,
    )
    with open(OUT, "w", encoding="utf8", newline="\n") as f:
        json.dump(out, f, indent=1)
        f.write("\n")
    print("wrote", os.path.relpath(OUT, ROOT), "from", len(sols), "sols")


if __name__ == "__main__":
    main()
