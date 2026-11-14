"""Stress test of candidate routes.

1. If data/ast/ast_results.json exists (offline training run, see rl/TASK.md), its numbers are served with
   source "data/ast".
2. Otherwise the engine runs a small local Monte Carlo ("local preview", method "mc"): about 2000 walkers per
   route with disturbances inside the bounds of docs/research/U2_rl_design.md section 9.2. robustness_nats is
   null because no adversarial search was run.
"""
import json
import math
import os

import numpy as np

from . import AST_DIR, RUNTIME, rel, write_atomic
from .params import PARAMS, SIM
from .routes import late_deadline
from .walk import ARRIVED, HEAT, INCAP, O2, ST, STUCK, TIMEOUT, monte_carlo, walk

O2_W = SIM["O2_NOMINAL_W"] * SIM["O2_KG_PER_J"]
CLASSES = ["fall", "heat", "oxygen", "late", "stuck"]
OUTCOME = {"ok": "arrived", "fall": "incapacitated", "heat": "heat", "oxygen": "oxygen", "late": "late", "stuck": "stuck"}
SCEN_ALIAS = {"sep-1": ["sep-1", "S1", "s1"], "quake-1": ["quake-1", "S2", "s2"], "sci-1": ["sci-1", "S3", "s3"]}
FAILURE_DEFS = [
    "Incapacitating fall (simulator fall and injury probabilities; base rate 0.15 per km is a team assumption).",
    "Stored heat at or above 844 kJ (params.ts heatMaxKJ).",
    "O2 exhausted, or below the 60-minute reserve on arrival.",
    "With a solar storm active: arrival after the 30-minute shelter rule (alert-to-first-step time included); when no open "
    "shelter can meet that rule any more, arrival after the expected dose-rate peak (53 min after the alert).",
    "Stuck (no legal move for 3 min) or not arrived after 3 h.",
]


def wilson(k, n, z=1.96):
    if n <= 0:
        return [0.0, 1.0]
    p = k / n
    den = 1 + z * z / n
    mid = (p + z * z / (2 * n)) / den
    hw = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return [max(0.0, mid - hw), min(1.0, mid + hw)]


def classify(row, deadline):
    st = int(row[ST["status"]])
    if st == ARRIVED:
        if row[ST["t_end"]] > deadline:
            return "late"
        if row[ST["o2_end"]] / O2_W / 60.0 < PARAMS["o2ReserveMin"]:
            return "oxygen"
        return "ok"
    if st == INCAP:
        return "fall"
    if st == HEAT:
        return "heat"
    if st == O2:
        return "oxygen"
    if st in (STUCK, TIMEOUT):
        return "late" if math.isfinite(deadline) and st == TIMEOUT else "stuck"
    return "stuck"


def failure_point(row, cls, deadline):
    if cls == "late" and math.isfinite(row[ST["dl_x"]]):
        return row[ST["dl_x"]], row[ST["dl_y"]], deadline
    return row[ST["end_x"]], row[ST["end_y"]], row[ST["t_end"]]


def _summary(site, cls, row, events, deadline, basis=None):
    t_min = row[ST["t_end"]] / 60.0
    ev = {e["channel"]: e for e in events}
    hints = []
    if "cooling" in ev and ev["cooling"]["value"] < 0.9:
        hints.append("cooling at %.2f" % ev["cooling"]["value"])
    if "metabolic" in ev and ev["metabolic"]["value"] > 1.1:
        hints.append("metabolic cost x%.2f" % ev["metabolic"]["value"])
    if "navigation" in ev and ev["navigation"]["value"] > 60:
        hints.append("navigation off by %.0f m" % ev["navigation"]["value"])
    nfall = int(row[ST["falls"]])
    if nfall and cls != "fall":
        hints.append("%d stumble%s" % (nfall, "s" if nfall > 1 else ""))
    tail = (": " + ", ".join(hints)) if hints else ""
    x, y = row[ST["end_x"]], row[ST["end_y"]]
    if cls == "fall":
        return "Incapacitating fall after %.0f min on a %.0f degree slope%s" % (t_min, site.layer_at("slope", x, y), tail)
    if cls == "heat":
        return "Heat limit reached after %.0f min%s" % (t_min, tail)
    if cls == "oxygen":
        return "O2 below the 60-minute reserve%s" % tail
    if cls == "late":
        what = "the expected dose-rate peak" if basis == "peak" else "the shelter rule"
        if int(row[ST["status"]]) == ARRIVED:
            return "Arrived %.1f min after %s%s" % ((row[ST["t_end"]] - deadline) / 60.0, what, tail)
        return "Still walking at %s%s" % (what, tail)
    return "No way forward after %.0f min%s" % (t_min, tail)


def _samples(site, trk, every=1, max_points=200):
    step = max(every, int(math.ceil(len(trk) / max_points)))
    idx = list(range(0, len(trk), step))
    if idx[-1] != len(trk) - 1:
        idx.append(len(trk) - 1)
    out = []
    for k in idx:
        x, y = trk[k, 1], trk[k, 2]
        out.append([round(site.e0 + x, 1), round(site.s0 + y, 1), round(site.z_at_core(x, y), 1),
                    round(float(trk[k, 3]), 1), int(trk[k, 4])])
    return out, SIM["DT"] * step


def run_local(site, hazards, incident_id, route, n=None, seed0=1):
    n = int(n or PARAMS["mcWalkers"])
    prm = route["nominal"]["prm"]
    deadline = late_deadline(route["ctx"])
    basis = route["ctx"].get("late_basis")
    out, seeds = monte_carlo(site, route["poly"], route["legs"], prm, n, seed0=seed0 + 1000 * route["id"])
    cls = [classify(r, deadline) for r in out]
    fail_idx = [i for i, c in enumerate(cls) if c != "ok"]
    k = len(fail_idx)
    counts = {c: 0 for c in CLASSES}
    for i in fail_idx:
        counts[cls[i]] += 1
    logp = out[:, ST["log_p"]]
    # top-3 most likely failures, distinct by class or by more than 100 m
    order = sorted(fail_idx, key=lambda i: -logp[i])
    picked = []
    for i in order:
        x, y, _ = failure_point(out[i], cls[i], deadline)
        if all(cls[j] != cls[i] or math.hypot(x - failure_point(out[j], cls[j], deadline)[0],
                                               y - failure_point(out[j], cls[j], deadline)[1]) > 100 for j in picked):
            picked.append(i)
        if len(picked) == 3:
            break
    failures, runs = [], []
    replay = list(picked)
    for i in order:
        if len(replay) >= 5:
            break
        if i not in replay:
            replay.append(i)
    for i in range(n):
        if len(replay) >= 8:
            break
        if cls[i] == "ok":
            replay.append(i)
    for rank, i in enumerate(replay):
        st, trk, events = walk(site, route["poly"], route["legs"], prm, seed=int(seeds[i]), stochastic=True)
        c = classify(np.array([st[key] for key in ST]), deadline)
        samples, sdt = _samples(site, trk)
        runs.append(dict(route=route["id"], id=rank, outcome=OUTCOME[c], log_p=round(st["log_p"], 2), seed=int(seeds[i]),
                         t_end=round(st["t_end"], 1), dt=sdt, samples=samples, events=events))
        if i in picked:
            x, y, t = failure_point(out[i], cls[i], deadline)
            ex, es = site.core_to_local(x, y)
            failures.append(dict(**{"class": cls[i]}, e=round(ex, 1), s=round(es, 1), t=round(float(t), 1),
                                 log_p=round(float(logp[i]), 2), summary=_summary(site, cls[i], out[i], events, deadline, basis),
                                 events=events, replay_id=rank))
    # likelihood-weighted failure density
    pts = []
    if k:
        mx = max(logp[i] for i in fail_idx)
        for i in fail_idx:
            x, y, _ = failure_point(out[i], cls[i], deadline)
            pts.append((x, y, max(1e-3, math.exp(logp[i] - mx))))
    density = hazards.failure_density(pts)
    from .hazards import write_png
    heat_file = write_png("heatmap_%s_%d.png" % (incident_id, route["id"]), hazards.img_failures(density))
    arrived = out[:, ST["status"]] == ARRIVED
    t_arr = out[arrived, ST["t_end"]]
    return dict(
        incident_id=incident_id, route_id=route["id"], method="mc", source="local preview",
        robustness_nats=None, mc_fail_rate=round(k / n, 4), mc_ci=[round(v, 4) for v in wilson(k, n)], n=n,
        failures=failures, heatmap=heat_file,
        classes={c: round(counts[c] / n, 4) for c in CLASSES},
        arrival_s={"p10": _q(t_arr, 0.1), "p50": _q(t_arr, 0.5), "p90": _q(t_arr, 0.9)},
        falls_per_crew=round(float(out[:, ST["falls"]].mean()), 3),
        heat_peak_p90_kj=round(float(np.quantile(out[:, ST["heat_peak"]], 0.9)), 1),
        disturbances="U2 section 9.2 bounds (cooling, metabolic efficiency, navigation, pace drift, stumbles)",
        failure_definitions=FAILURE_DEFS,
        _runs=runs, _density=density)


def _q(a, q):
    return round(float(np.quantile(a, q)), 1) if len(a) else None


def write_trajectories(incident_id, results, path=None):
    path = path or os.path.join(RUNTIME, "trajectories.json")
    runs = []
    for r in results:
        runs.extend(r.get("_runs", []))
    doc = {"dt": SIM["DT"], "dt_note": "each run carries its own dt (sample spacing, s) when samples were thinned",
           "incident_id": incident_id, "frame": "local metres e, s, z; heading deg clockwise from north",
           "status_codes": "0 walking, 1 idle, 2 stumbled, 3 incapacitated, 4 heat, 5 oxygen, 6 arrived, 7 late",
           "source": results[0]["source"] if results else "local preview", "runs": runs}
    write_atomic(path, json.dumps(doc).encode())
    return rel(path)


def public(res):
    return {k: v for k, v in res.items() if not k.startswith("_")}


# ---------------------------------------------------------------------------------------------- data/ast
def ast_present(directory=AST_DIR):
    return os.path.exists(os.path.join(directory, "ast_results.json"))


def load_ast(directory=AST_DIR):
    path = os.path.join(directory, "ast_results.json")
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf8") as f:
            doc = json.load(f)
        return dict(doc=doc, mtime=os.path.getmtime(path), dir=directory)
    except (OSError, ValueError):
        return None


def _scenario_block(doc, incident_id):
    names = SCEN_ALIAS.get(incident_id, [incident_id])
    containers = [doc, doc.get("scenarios")] if isinstance(doc, dict) else [doc]
    for c in containers:
        if isinstance(c, dict):
            for nm in names:
                if nm in c:
                    return c[nm], nm
        if isinstance(c, list):
            for item in c:
                if isinstance(item, dict) and (item.get("scenario") in names or item.get("id") in names):
                    return item, item.get("scenario") or item.get("id")
    return None, None


def _route_block(block, route):
    rs = block.get("routes") if isinstance(block, dict) else block
    if isinstance(rs, dict):
        for key in (str(route["id"]), route["shelter"]):
            if key in rs:
                return rs[key]
        rs = list(rs.values())
    if isinstance(rs, list):
        for r in rs:
            if isinstance(r, dict) and (r.get("shelter") == route["shelter"] or r.get("goal") == route["shelter"]):
                return r
        for r in rs:
            if isinstance(r, dict) and r.get("id") == route["id"] and "shelter" not in r:
                return r
    return None


def _first(d, *keys):
    for k in keys:
        cur = d
        ok = True
        for part in k.split("."):
            if isinstance(cur, dict) and part in cur:
                cur = cur[part]
            else:
                ok = False
                break
        if ok:
            return cur
    return None


def _num(v):
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def from_ast(ast, site, incident_id, route):
    """Stress result for one route from data/ast, or None if the file has nothing usable for it."""
    if not ast:
        return None
    block, scen_name = _scenario_block(ast["doc"], incident_id)
    if block is None:
        return None
    rb = _route_block(block, route)
    if not isinstance(rb, dict):
        return None
    # the offline run must have tested this route: compare start and end points when it gives them
    pts = _first(rb, "points", "polyline", "route.points")
    if isinstance(pts, list) and len(pts) >= 2:
        try:
            a, b = pts[0], pts[-1]
            ra, rb_ = route["points"][0], route["points"][-1]
            if math.hypot(a[0] - ra[0], a[1] - ra[1]) > 60 or math.hypot(b[0] - rb_[0], b[1] - rb_[1]) > 60:
                return None
        except (TypeError, IndexError, KeyError):
            pass
    rob = _num(_first(rb, "robustness_nats", "robustness.nats", "robustness"))
    rate = _num(_first(rb, "mc_fail_rate", "mc.fail_rate", "monte_carlo.fail_rate"))
    ci = _first(rb, "mc_ci", "mc.ci", "monte_carlo.ci", "mc.wilson")
    n = _num(_first(rb, "n", "mc.n", "monte_carlo.n"))
    method = _first(rb, "method", "best_method") or ast["doc"].get("method") if isinstance(ast["doc"], dict) else None
    if method not in ("ppo-ast", "cem", "mc"):
        method = "cem" if rob is not None else "mc"
    if rob is None and rate is None:
        return None
    failures = []
    for f in (_first(rb, "failures", "top_failures", "top3") or [])[:3]:
        if not isinstance(f, dict):
            continue
        traj = f.get("trajectory") or f.get("samples") or []
        e = _num(f.get("e")); s = _num(f.get("s")); t = _num(f.get("t"))
        if (e is None or s is None) and traj:
            last = traj[-1]
            if isinstance(last, dict):
                e = _num(last.get("e", last.get("x"))); s = _num(last.get("s", last.get("y"))); t = _num(last.get("t"))
            elif isinstance(last, (list, tuple)) and len(last) >= 3:
                t, e, s = _num(last[0]), _num(last[1]), _num(last[2])
        events = []
        for ev in f.get("events", []) or []:
            if isinstance(ev, dict):
                events.append(dict(t=_num(ev.get("t")), channel=str(ev.get("channel", "")), value=_num(ev.get("value")),
                                   log_p=_num(ev.get("log_p"))))
        cls = f.get("class") or f.get("failure_class") or "stuck"
        failures.append(dict(**{"class": cls if cls in CLASSES else "stuck"}, e=e, s=s, t=t,
                             log_p=_num(f.get("log_p", f.get("log_likelihood"))),
                             summary=str(f.get("summary", "Most likely failure found offline")), events=events))
    heat = None
    for name in ("ast_heatmap_%s_%s.png" % (scen_name, route["id"]), "ast_heatmap_%s_%s.png" % (incident_id, route["id"])):
        p = os.path.join(ast["dir"], name)
        if os.path.exists(p):
            heat = rel(p)
            break
    return dict(incident_id=incident_id, route_id=route["id"], method=method, source="data/ast",
                robustness_nats=rob, mc_fail_rate=rate,
                mc_ci=[_num(v) for v in ci] if isinstance(ci, list) and len(ci) == 2 else None,
                n=int(n) if n else None, failures=failures, heatmap=heat,
                classes=_first(rb, "classes", "failure_classes"), failure_definitions=FAILURE_DEFS)


def ast_extras(directory=AST_DIR):
    """Training curves and baselines, passed through for the dashboard when present."""
    out = {}
    for key, name in (("training", "ast_training.json"), ("baselines", "ast_baselines.json"), ("routes", "routes.json")):
        p = os.path.join(directory, name)
        if os.path.exists(p):
            out[key] = rel(p)
    return out
