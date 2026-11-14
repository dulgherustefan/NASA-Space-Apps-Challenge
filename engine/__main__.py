"""uv run python -m engine            serve on 127.0.0.1:8765 and send OSC to 127.0.0.1:9000
uv run python -m engine --no-osc   serve without OSC
uv run python -m engine --demo     serve and start the demo immediately
uv run python -m engine --check    play the whole scenario without sockets, print a summary, exit 1 on inconsistency
"""
import argparse
import json
import logging
import math
import os
import sys
import time

from . import PRODUCT, RUNTIME, VERSION


def build(osc_enabled, executor=None, n_walkers=None):
    from .director import Director
    from .hazards import Hazards
    from .osc import Osc
    from .params import write_params_json
    from .scenario import Scenario
    from .site import get_site

    os.makedirs(RUNTIME, exist_ok=True)
    site = get_site()
    hz = Hazards(site)
    write_params_json(os.path.join(RUNTIME, "params.json"))
    sc = Scenario(site)
    osc = Osc(enabled=osc_enabled)
    d = Director(site, hz, sc, osc, executor=executor, n_walkers=n_walkers)
    return d


def warm(site):
    """Compile or load the numba kernels once (cache=True makes this fast after the first run)."""
    from .walk import make_params, monte_carlo, walk
    poly = [(2800.0, 1500.0), (2810.0, 1510.0)]
    legs = [(__import__("numpy").full(site.n * site.n, -1, dtype="int32"), 2)]
    prm = make_params(0.65)
    walk(site, poly, legs, prm)
    monte_carlo(site, poly, legs, prm, 2)


def serve(args):
    t0 = time.time()
    from concurrent.futures import ThreadPoolExecutor
    import uvicorn
    from .server import create_app

    logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    ex = ThreadPoolExecutor(max_workers=1, thread_name_prefix="engine-work")
    d = build(not args.no_osc, executor=ex)
    ex.submit(d.hz.write_static)          # static overlays, off the tick loop
    ex.submit(warm, d.site)
    if args.demo:
        d.command({"cmd": "demo"})
    app = create_app(d, startup_t0=t0)
    print("%s engine %s on http://127.0.0.1:%d  (ws /ws, files /files/..., health /health)%s" % (
        PRODUCT, VERSION, args.port, "" if args.no_osc else "; OSC to 127.0.0.1:9000"), flush=True)
    print("startup to server ready: %.2f s" % (time.time() - t0), flush=True)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning", ws_ping_interval=20)


# ---------------------------------------------------------------------------------------------- --check
def check(args):
    from . import schema
    from .routes import geometry  # noqa: F401  (import check)
    from .server import safe_path

    t_start = time.time()
    d = build(False, n_walkers=args.walkers)
    d.hz.write_static()
    warm(d.site)
    problems = []
    msgs = []
    snaps = []
    d.command({"cmd": "demo"})
    dt = 0.05
    wall = 0.0
    k = 0
    while (d.program is not None) and wall < 900:
        d.tick(dt)
        wall += dt
        k += 1
        msgs.extend(d.drain())
        if k % 2 == 0:
            snaps.append(d.snapshot())
    msgs.extend(d.drain())
    if d.program is not None:
        problems.append("demo did not finish within 900 s of simulated wall time")
    if d.error:
        problems.append("director error: %s" % d.error)
    # contract fields
    hello = d.hello()
    for m in [hello] + msgs + snaps[::25]:
        for e in schema.validate(json.loads(json.dumps(m, default=float))):
            problems.append(e)
    # per-incident order and content
    phases_seen = {}
    for s in snaps:
        if s["incident_id"]:
            ph = phases_seen.setdefault(s["incident_id"], [])
            if not ph or ph[-1] != s["phase"]:
                ph.append(s["phase"])
    print("%s engine %s check: %d messages, %d snapshots, %.0f s simulated wall time (demo pacing), %.1f s real" % (
        PRODUCT, VERSION, len(msgs), len(snaps), wall, time.time() - t_start))
    for iid in d.sc.order:
        mine = [(i, m) for i, m in enumerate(msgs) if m.get("incident_id") == iid or (m["type"] == "incident" and m["id"] == iid)]
        first = {}
        for i, m in mine:
            first.setdefault(m["type"], i)
        need = ["incident", "assessment", "routes", "stress", "decision"]
        missing = [t for t in need if t not in first]
        if missing:
            problems.append("%s: missing %s" % (iid, ", ".join(missing)))
            continue
        if [first[t] for t in need] != sorted(first[t] for t in need):
            problems.append("%s: messages out of order %s" % (iid, first))
        ph = [p for p in phases_seen.get(iid, []) if p != "idle"]
        if ph[:4] != ["detect", "assess", "simulate", "respond"]:
            problems.append("%s: phases %s" % (iid, ph))
        h = d.history.get(iid)
        if not h:
            problems.append("%s: no decision recorded" % iid)
            continue
        routes, results, dec = h["routes"], h["results"], h["decision"]
        n_stress = sum(1 for _, m in mine if m["type"] == "stress")
        if n_stress != len(routes):
            problems.append("%s: %d stress messages for %d routes" % (iid, n_stress, len(routes)))
        inc = d.sc.incidents[iid]
        print()
        print("%s  %s  (t=%s s)" % (iid, inc["title"], [m for _, m in mine if m["type"] == "incident"][0]["t"]))
        dl = routes[0]["ctx"]["deadline_walk"] if routes else math.inf
        print("  start %s, pace %.2f m/s, time under the rule %s" % (
            inc.get("start"), routes[0]["ctx"]["pace"] if routes else 0, "%.1f min" % (dl / 60) if math.isfinite(dl) else "n/a"))
        print("  %-3s %-42s %7s %7s %6s %6s %6s %8s %-17s %-6s %s" % (
            "id", "route", "len m", "min", "O2", "heat", "mSv", "fail %", "95% CI", "band", "status / rules"))
        for r in routes:
            res = results.get(r["id"], {})
            ci = res.get("mc_ci") or [float("nan")] * 2
            print("  %-3d %-42s %7.0f %7.1f %6.2f %6.2f %6.3f %8.2f %-17s %-6.0f %s%s" % (
                r["id"], r["label"][:42], r["length_m"], r["time_s"] / 60, r["o2_margin"], r["heat_margin"], r["dose"],
                100 * (r["mc_fail_rate"] or 0), "%.2f-%.2f" % (100 * ci[0], 100 * ci[1]), r.get("band_m", 0), r["status"],
                (" (" + "; ".join(r["rule_reasons"]) + ")") if r["rule_reasons"] else ""))
            if res.get("classes"):
                cl = ", ".join("%s %.2f%%" % (c, 100 * v) for c, v in res["classes"].items() if v)
                print("      %s n=%s: %s" % (res.get("source"), res.get("n"), cl or "no failures"))
            for f in res.get("failures", [])[:3]:
                print("      top failure: %s at t=%.0f s, log p %.1f: %s" % (f["class"], f["t"], f["log_p"], f["summary"]))
            # geometric consistency
            pts = r["points"]
            for (e, s, _z) in pts[::7]:
                x, y = d.site.local_to_core(e, s)
                if d.site.is_blocked(x, y):
                    problems.append("%s route %d passes a blocked cell at (%.0f, %.0f)" % (iid, r["id"], e, s))
                    break
            if inc["kind"] == "science":
                goal = d.sc.place(inc["home"])
            else:
                goal = d.sc.place(r["shelter"])
            gap = math.hypot(pts[-1][0] - goal["e"], pts[-1][1] - goal["s"])
            if gap > 15:
                problems.append("%s route %d ends %.0f m from %s" % (iid, r["id"], gap, goal["id"]))
        print("  decision: route %d -> %s (%s), %.1f min, margins O2 %.2f heat %.2f dose %.2f" % (
            dec["route_id"], dec["shelter"], "auto" if dec["auto"] else "operator", dec["time_to_shelter_s"] / 60,
            dec["margins"]["o2"], dec["margins"]["heat"], dec["margins"]["dose"]))
        for t in dec["reasons"]:
            print("    + " + t)
        for a in dec["avoided"]:
            print("    - %s: %s" % (a["label"], a["detail"]))
        chosen = [r for r in routes if r["id"] == dec["route_id"]][0]
        if chosen["status"] != "chosen":
            problems.append("%s: chosen route status %s" % (iid, chosen["status"]))
        ok = [r for r in routes if r["rule_ok"] and r["status"] != "infeasible"]
        if ok and not chosen["rule_ok"]:
            problems.append("%s: chose a route that breaks a rule while %d meet them" % (iid, len(ok)))
    # files
    print()
    for name in ["routes.json", "trajectories.json", "params.json"] + ["overlay_%s.png" % l for l in
                                                                       ("hazard", "slope", "rockfall", "sand", "sky", "dose", "failures")]:
        p = os.path.join(RUNTIME, name)
        if not os.path.exists(p):
            problems.append("missing runtime/%s" % name)
            continue
        if name.endswith(".json"):
            try:
                with open(p) as f:
                    json.load(f)
            except ValueError as e:
                problems.append("runtime/%s: %s" % (name, e))
        else:
            from PIL import Image
            with Image.open(p) as im:
                if im.size != (800, 800) or im.mode != "RGBA":
                    problems.append("runtime/%s is %s %s" % (name, im.size, im.mode))
    for bad in ("../pyproject.toml", "runtime/../pyproject.toml", "/etc/passwd", "rl/planner.py", "data/scenario/sep-1.json"):
        if safe_path(bad) is not None:
            problems.append("file server would serve %s" % bad)
    last = snaps[-1] if snaps else {}
    print("final: t=%s s (sol %s, LMST %s), crew %s" % (
        last.get("clock", {}).get("t"), last.get("clock", {}).get("sol"), last.get("clock", {}).get("lmst"),
        ", ".join("%s status %d dose %.3f mSv O2 %.2f" % (c["name"], c["status"], c["dose"], c["o2"]) for c in last.get("crew", []))))
    if problems:
        print("\nINCONSISTENT (%d):" % len(problems))
        for p in problems[:40]:
            print("  " + p)
        return 1
    print("check passed")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m engine", description="%s incident engine" % PRODUCT)
    ap.add_argument("--no-osc", action="store_true", help="do not send OSC")
    ap.add_argument("--demo", action="store_true", help="start the three-incident demo immediately")
    ap.add_argument("--check", action="store_true", help="run the whole scenario without sockets and print a summary")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--walkers", type=int, default=None, help="Monte Carlo walkers per route (default from params)")
    args = ap.parse_args(argv)
    if args.check:
        return check(args)
    serve(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
