"""Export of the stress-test results to data/ast/ (formats: rl/TASK.md, docs/research/U2_rl_design.md section 8).

  python rl/export_ast.py --cases      capture the incident contexts and candidate routes from the engine
                                       (rl/runs/ast/engine_cases.json); the adversary tests exactly these routes
  python rl/export_ast.py              assemble data/ast/ from the runs in rl/runs/ast/

Positions in the exported files are local metres e, s, z (docs/CONTRACT.md section 1).
"""
import argparse
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RUNS = os.path.join(HERE, "runs", "ast")
OUT = os.path.join(ROOT, "data", "ast")


# ---------------------------------------------------------------------------------------------- engine capture
def dump_engine_cases(path=None, walkers=None):
    """Play the scripted scenario in the engine (no sockets) and write what it planned for every incident."""
    sys.path.insert(0, ROOT)
    from engine.__main__ import build, warm
    d = build(False, n_walkers=walkers)
    d.hz.write_static()
    warm(d.site)
    d.command({"cmd": "demo"})
    wall = 0.0
    while d.program is not None and wall < 900:
        d.tick(0.05)
        wall += 0.05
        d.drain()
    if d.program is not None or d.error:
        raise RuntimeError("engine scenario did not finish: %s" % d.error)
    doc = {"note": "Incident contexts and candidate routes as planned by the engine (rl/planner.py fields). Core metres "
                   "(x east, y south inside the 4 km box) for start and goals; points are local metres e, s, z.",
           "core": {"e0": d.site.e0, "s0": d.site.s0, "cell": d.site.cell, "n": d.site.n}}
    from engine.params import PARAMS
    for iid in d.sc.order:
        h = d.history[iid]
        inc = d.sc.incidents[iid]
        routes = []
        ctx = None
        for k, r in enumerate(h["routes"]):
            c = r["ctx"]
            ctx = dict(start_xy=[float(c["start_xy"][0]), float(c["start_xy"][1])], band_active=bool(c["band_active"]),
                       alpha=float(c["alpha"]), pace=float(c["pace"]), sep_elapsed0=float(c["sep_elapsed0"]),
                       deadline_walk=c["deadline_walk"] if math.isfinite(c["deadline_walk"]) else None,
                       deadline_peak=c["deadline_peak"] if math.isfinite(c.get("deadline_peak", math.inf)) else None,
                       late_basis=c.get("late_basis"),
                       heat0=float(PARAMS["heat0KJ"] if c["heat0"] is None else c["heat0"]),
                       o2_frac=float(PARAMS["o2Start"] if c["o2_frac"] is None else c["o2_frac"]), kind=c["kind"])
            if inc["kind"] == "science":
                home, target = d.sc.place(inc["home"]), d.sc.place(inc["target"])
                band_w = [v["band_weights"] == "active" for v in inc["variants"] if v["label"] == r["label"]][0]
                legs = [dict(goal=[target["x"], target["y"]], band_weights=band_w), dict(goal=[home["x"], home["y"]], band_weights=band_w)]
            else:
                sh = d.sc.place(r["shelter"])
                legs = [dict(goal=[sh["x"], sh["y"]], band_weights=bool(c["band_active"]))]
            routes.append(dict(id=r["id"], shelter=r["shelter"], label=r["label"], start=[float(r["poly"][0][0]), float(r["poly"][0][1])],
                               legs=legs, points=r["points"], length_m=r["length_m"], time_s=r["time_s"], ascent_m=r["ascent_m"],
                               max_slope=r["max_slope"], band_m=r["band_m"], rule_ok=r["rule_ok"], rule_reasons=r["rule_reasons"],
                               engine_nominal=dict(time_s=r["time_s"], o2_margin=r["o2_margin"], heat_margin=r["heat_margin"],
                                                   dose_msv=r["dose"], arrived=bool(r["nominal"]["arrived"]))))
        doc[iid] = dict(title=inc["title"], kind=inc["kind"], ctx=ctx, routes=routes,
                        chosen_by_engine=h["decision"]["route_id"], incident_t=h.get("t"))
    path = path or os.path.join(RUNS, "engine_cases.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf8") as f:
        json.dump(doc, f)
    for iid in d.sc.order:
        b = doc[iid]
        print(iid, "start (%.1f, %.1f) pace %.2f sep0 %.0f deadline %s/%s basis %s heat0 %.1f o2 %.3f" % (
            b["ctx"]["start_xy"][0], b["ctx"]["start_xy"][1], b["ctx"]["pace"], b["ctx"]["sep_elapsed0"], b["ctx"]["deadline_walk"],
            b["ctx"]["deadline_peak"], b["ctx"]["late_basis"], b["ctx"]["heat0"], b["ctx"]["o2_frac"]),
            "| routes", [(r["id"], r["shelter"], r["time_s"]) for r in b["routes"]], "| engine chose", b["chosen_by_engine"])
    return doc


# ---------------------------------------------------------------------------------------------- assembly
CONFIGS = ["falls_terminal", "falls_penalty"]
CONFIG_LABEL = {"falls_terminal": "falls can be incapacitating (all failure classes)",
                "falls_penalty": "falls cost time and energy only (resource failures)"}
INFERNO = [(0.0, (40, 11, 84)), (0.25, (101, 21, 110)), (0.5, (188, 55, 84)), (0.75, (249, 142, 9)), (1.0, (252, 255, 164))]
BUDGETS = [1e6, 2e6, 5e6, 1e7, 2e7, 5e7]


def _load(name):
    p = os.path.join(RUNS, name)
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf8") as f:
        return json.load(f)


def _npz(name):
    p = os.path.join(RUNS, name)
    return np.load(p) if os.path.exists(p) else None


def _blur(d, sigma=3.0):
    r = int(3 * sigma)
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2); k /= k.sum()
    d = np.apply_along_axis(lambda v: np.convolve(v, k, mode="same"), 0, d)
    return np.apply_along_axis(lambda v: np.convolve(v, k, mode="same"), 1, d)


def heatmap_png(points, path, n=800, cell=5.0):
    """points: rows (x, y, log p) in core metres. Likelihood-weighted failure density, log scaled, RGBA 800 x 800."""
    from PIL import Image
    d = np.zeros((n, n))
    if len(points):
        w = np.exp(points[:, 2] - points[:, 2].max())
        j = np.clip((points[:, 0] / cell).astype(int), 0, n - 1); i = np.clip((points[:, 1] / cell).astype(int), 0, n - 1)
        np.add.at(d, (i, j), np.maximum(w, 1e-6))
    img = np.zeros((n, n, 4), np.uint8)
    mx = 0.0
    if d.max() > 0:
        d = _blur(d)
        mx = float(d.max())
        v = np.log1p(d / mx * 1000) / math.log1p(1000)
        a = np.where(v > 0.08, 0.2 + 0.75 * v, 0.0)
        pos = np.array([q for q, _ in INFERNO])
        val = np.clip(0.35 + 0.65 * v, 0, 1)
        for c in range(3):
            img[..., c] = np.round(np.interp(val, pos, [col[c] for _, col in INFERNO])).astype(np.uint8)
        img[..., 3] = np.round(np.clip(a, 0, 1) * 255).astype(np.uint8)
        img[img[..., 3] == 0, :3] = 0
    Image.fromarray(img, "RGBA").save(path, format="PNG", compress_level=6)
    return mx


def _best_at(curve, budget, col=1):
    best = None
    for row in curve:
        if row[0] <= budget and row[col] is not None:
            best = row[col] if best is None else max(best, row[col])
    return best


def _clean(o):
    """Plain JSON only: NaN and infinities become null, numpy scalars become Python numbers."""
    if isinstance(o, dict):
        return {str(k): _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (np.floating, float)):
        o = float(o)
        return o if math.isfinite(o) else None
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.ndarray):
        return _clean(o.tolist())
    return o


def _nf(v, searched=True):
    if v is None and not searched:
        return "not searched"
    return "no failure found above the search floor (log-likelihood -100 nats)" if v is None else ("%.1f" % v)


def _radius(f):
    s = sum(-2 * e["log_p"] for e in f.get("events", []) if e["channel"] in ("cooling", "metabolic", "navigation", "pace"))
    return round(math.sqrt(max(s, 0.0)), 2)


def _thin_rollout(q):
    return dict(**{"class": q["class"]}, log_p=q["log_p"], t=q["t"], e=q["e"], s=q["s"], events=q["events"],
                trajectory=[[row[0], row[1], row[2], row[3], row[8]] for row in q["trajectory"][::2]])


def assemble(scenarios=("S1", "S2", "S3")):
    import datetime
    import torch
    sys.path.insert(0, HERE)
    import ast_env as A
    os.makedirs(OUT, exist_ok=True)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    cases_doc = _load("engine_cases.json")
    world = None
    results = {}
    routes_doc = {}
    training = {}
    baselines = {}
    summary = {}          # for the report
    have = []
    for scn in scenarios:
        mc = {c: _load("mc_%s_%s.json" % (scn, c)) for c in CONFIGS}
        cem = {c: _load("cem_%s_%s.json" % (scn, c)) for c in CONFIGS}
        ppo = {c: _load("ppo_%s_%s.json" % (scn, c)) for c in CONFIGS}
        if not any(mc.values()) and not any(cem.values()):
            continue
        have.append(scn)
        case = A.Case(scn, device, world=world)
        world = (case.g, case.blocked, case.T)
        nominal = A.nominal_runs(case)
        blk = cases_doc[case.incident]
        R = case.R
        # robustness per route and configuration, best over the adversarial methods
        rob = {c: [None] * R for c in CONFIGS}
        meth = {c: [None] * R for c in CONFIGS}
        for c in CONFIGS:
            for r in range(R):
                cands = []
                if cem[c] and not cem[c]["routes"][r].get("infeasible") and cem[c]["routes"][r]["best_log_p"] is not None:
                    cands.append((cem[c]["routes"][r]["best_log_p"], "cem"))
                if ppo[c] and ppo[c]["routes"][r] and ppo[c]["routes"][r].get("failures"):
                    # the recorded fresh-seed failure of the shipped seed (replayable), not the best one seen while training
                    cands.append((max(f["log_p"] for f in ppo[c]["routes"][r]["failures"]), "ppo-ast"))
                if cands:
                    lp, m = max(cands)
                    rob[c][r] = -lp; meth[c][r] = m
        summary[scn] = dict(case=case, nominal=nominal, rob=rob, meth=meth, mc=mc, cem=cem, ppo=ppo)
    # headline configuration: the one that separates the feasible S1 routes more (rl/TASK.md step 4)
    spread = {}
    ref = summary.get("S1") or (summary[have[0]] if have else None)
    for c in CONFIGS:
        v = [x for x in ref["rob"][c] if x is not None] if ref else []
        spread[c] = (max(v) - min(v)) if len(v) >= 2 else 0.0
    headline = max(CONFIGS, key=lambda c: (spread[c], c == "falls_terminal"))
    other = [c for c in CONFIGS if c != headline][0]

    for scn in have:
        S = summary[scn]
        case, nominal, mc, cem, ppo = S["case"], S["nominal"], S["mc"], S["cem"], S["ppo"]
        blk = cases_doc[case.incident]
        core = case.core
        rdoc, rroutes = {}, []
        training[scn] = {}
        baselines[scn] = {}
        for r in range(case.R):
            er = blk["routes"][r]
            nom = nominal[r]
            feas = A.feasible(nom)
            key = str(er["id"])
            nomd = dict(arrived=nom["arrived"], failure=nom["failure"], time_s=round(nom["time_s"], 1), distance_m=round(nom["dist_m"], 1),
                        heat_peak_kj=round(nom["heat_peak_kj"], 1), heat_margin=round(nom["heat_margin"], 3),
                        o2_frac=round(nom["o2_frac"], 4), o2_reserve_min=round(nom["o2_reserve_min"], 1),
                        dose_ugy=round(nom["dose_ugy"], 1), slack_s=None if nom["slack_s"] is None else round(nom["slack_s"], 1),
                        log_p_no_stumble=round(nom["log_p"], 3), engine_time_s=er["time_s"])
            rroutes.append(dict(id=er["id"], shelter=er["shelter"], label=er["label"], points=er["points"], length_m=er["length_m"],
                                time_s=nomd["time_s"], engine_time_s=er["time_s"], ascent_m=er["ascent_m"], max_slope=er["max_slope"],
                                feasible=feas))
            entry = dict(id=er["id"], shelter=er["shelter"], label=er["label"], points=[er["points"][0], er["points"][-1]],
                         length_m=er["length_m"], nominal=nomd, infeasible=not feas)
            cfgs = {}
            for c in CONFIGS:
                d = dict(label=CONFIG_LABEL[c])
                if mc[c]:
                    m = mc[c]["routes"][r]
                    d["monte_carlo"] = dict(n=m["n"], fail_rate=round(m["fail_rate"], 6), ci=[round(v, 6) for v in m["ci"]],
                                            classes={k: round(v / m["n"], 6) for k, v in m["classes"].items()}, sim_steps=m["sim_steps"],
                                            best_log_p=m["best_log_p"], best_log_p_without_pace_noise=m["best_log_p_events"])
                d["searched"] = bool(cem[c]) or bool(ppo[c] and ppo[c]["routes"][r])
                # one decimal: the spread between seeds of the same search is larger than 0.05 nat
                d["robustness_nats"] = None if S["rob"][c][r] is None else round(S["rob"][c][r], 1)
                d["robustness_nats_unrounded"] = None if S["rob"][c][r] is None else round(S["rob"][c][r], 3)
                d["method"] = S["meth"][c][r]
                if cem[c] and not cem[c]["routes"][r].get("infeasible"):
                    q = cem[c]["routes"][r]
                    d["cem_best_log_p"] = [x["best_log_p"] for x in q["cem"]]
                    d["random_search_best_log_p"] = [x["best_log_p"] for x in q["random_search"]]
                    d["cem_restart_best_log_p"] = [x["best_log_p"] for x in q.get("cem_restart", [])]
                    d["most_likely_failure_per_class_nats"] = {k: (None if v["robustness_nats"] is None else round(v["robustness_nats"], 2))
                                                               for k, v in q.get("class_table", {}).items()}
                if ppo[c] and ppo[c]["routes"][r]:
                    q = ppo[c]["routes"][r]
                    d["ppo_best_log_p"] = [x["best_log_p"] for x in q["seeds"]]
                    d["ppo_eval"] = q.get("eval")
                cfgs[c] = d
            entry["configurations"] = cfgs
            h = cfgs[headline]
            entry["headline_configuration"] = headline
            entry["robustness_nats"] = h["robustness_nats"] if feas else None
            entry["robustness_nats_other_configuration"] = cfgs[other]["robustness_nats"] if feas else None
            entry["other_configuration_searched"] = cfgs[other]["searched"]
            entry["method"] = (h["method"] or "mc") if feas else "mc"
            if "monte_carlo" in h:
                entry["mc_fail_rate"] = h["monte_carlo"]["fail_rate"]; entry["mc_ci"] = h["monte_carlo"]["ci"]
                entry["n"] = h["monte_carlo"]["n"]; entry["classes"] = h["monte_carlo"]["classes"]
            failures, rollouts, pts = [], [], []
            if feas:
                src = None
                if h["method"] == "ppo-ast":
                    src = ppo[headline]["routes"][r]
                elif cem[headline]:
                    src = cem[headline]["routes"][r]
                if src:
                    for f in src.get("failures", [])[:3]:
                        f = dict(f)
                        f.pop("x", None); f.pop("y", None)
                        f["radius_sigma"] = _radius(f)
                        failures.append(f)
                    rollouts = [_thin_rollout(q) for q in src.get("rollouts", [])[:32]]
                for tag, srcs in (("cem", cem[headline]), ("ppo", ppo[headline])):
                    z = _npz("%s_%s_%s.npz" % (tag, scn, headline))
                    if z is not None and "r%d" % r in z.files and len(z["r%d" % r]):
                        a = z["r%d" % r]
                        pts.append(np.stack([a[:, 1], a[:, 2], a[:, 4]], 1))
                if failures:
                    entry["robustness"] = dict(nats=entry["robustness_nats"], radius_sigma=failures[0]["radius_sigma"],
                                               note="minus the log-likelihood of the most likely failure found; a likelihood ratio "
                                                    "under the assumed disturbance distributions, not a probability")
            else:
                tr = nom["track"]
                k = len(tr) - 1
                failures.append(dict(**{"class": nom["failure"] or "late"}, e=round(core["e0"] + float(tr[k, 1]), 1),
                                     s=round(core["s0"] + float(tr[k, 2]), 1), t=round(float(tr[k, 0]), 1), log_p=round(nom["log_p"], 3),
                                     summary="Infeasible without any disturbance: the undisturbed walker is not under cover in time "
                                             "(planned walk %.0f min)" % (er["time_s"] / 60), events=[]))
                entry["note"] = "infeasible without any disturbance; not scored"
                z = _npz("mc_%s_%s.npz" % (scn, headline))
                if z is not None and "r%d" % r in z.files and len(z["r%d" % r]):
                    a = z["r%d" % r]
                    pts.append(np.stack([a[:, 1], a[:, 2], a[:, 5]], 1))
            entry["failures"] = failures
            entry["rollouts"] = rollouts
            hm = "ast_heatmap_%s_%s.png" % (scn, key)
            heatmap_png(np.concatenate(pts, 0) if pts else np.zeros((0, 3)), os.path.join(OUT, hm))
            entry["heatmap"] = hm
            rdoc[key] = entry
            # curves and the equal-budget table
            if feas:
                training[scn][key] = {}
                baselines[scn][key] = {}
                for c in CONFIGS:
                    cur = {}
                    if mc[c]:
                        m = mc[c]["routes"][r]
                        cur["mc"] = [dict(seed=m["seed"], curve=[[row[0], row[1]] for row in m["curve"]],
                                          curve_without_pace_noise=[[row[0], row[2]] for row in m["curve"]])]
                    if cem[c] and not cem[c]["routes"][r].get("infeasible"):
                        q = cem[c]["routes"][r]
                        cur["random_search"] = [dict(seed=x["seed"], curve=[[row[0], row[1]] for row in x["curve"]]) for x in q["random_search"]]
                        cur["cem"] = [dict(seed=x["seed"], curve=[[row[0], row[1]] for row in x["curve"]]) for x in q["cem"]]
                        if q.get("cem_restart"):
                            cur["cem_restart"] = [dict(seed=x["seed"], curve=x["curve"]) for x in q["cem_restart"]]
                    if ppo[c] and ppo[c]["routes"][r]:
                        cur["ppo-ast"] = [dict(seed=x["seed"], curve=[[row[0], row[1]] for row in x["curve"]],
                                               diagnostics=dict(columns=x.get("log_columns"), rows=x.get("log"))) for x in ppo[c]["routes"][r]["seeds"]]
                    training[scn][key][c] = cur
                    tab = {}
                    for mname, runs in cur.items():
                        tab[mname] = {("%g" % b): [_best_at(x["curve"], b) for x in runs] for b in BUDGETS}
                        tab[mname]["final"] = [_best_at(x["curve"], 1e30) for x in runs]
                        tab[mname]["sim_steps"] = [x["curve"][-1][0] if x["curve"] else 0 for x in runs]
                    baselines[scn][key][c] = tab
        results[scn] = dict(incident=case.incident, title=blk["title"], context=blk["ctx"],
                            deadline_s=None if not math.isfinite(case.deadline) else case.deadline, late_basis=case.late_basis,
                            routes=rdoc)
        routes_doc[scn] = dict(incident=case.incident, title=blk["title"], start=[core["e0"] + blk["ctx"]["start_xy"][0],
                                                                                  core["s0"] + blk["ctx"]["start_xy"][1]], routes=rroutes)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    common = dict(failure_definitions=A.FAILURE_DEFS, assumptions=A.ASSUMPTIONS, wording=A.WORDING, generated_utc=stamp,
                  frame="local metres e (east), s (south), z (elevation, MOLA datum); docs/CONTRACT.md section 1")
    bounds = {"cooling": "multiplier 1 - 0.117 z, floor 0.65", "metabolic": "multiplier exp(0.12 z)",
              "navigation": "offset 53 m x (z_x, z_y), fades out in the last 200 m", "pace": "multiplier exp(0.08 z) per 10 s step",
              "stumble": "Bernoulli(pFall) per step, simulator probability", "injury": "Bernoulli(pInj) per stumble, simulator probability",
              "z": "standard normal, clipped to +/-3"}
    doc = dict(common, product="Solway stress test", method="cem",
               system_under_test="Scripted walker following the planner field at the planned pace, with the heat governor of the walk "
                                 "model and a re-localise rule when it leaves the planned field (rl/ast_env.py).",
               headline_configuration=headline, configurations=CONFIG_LABEL,
               headline_rule="The configuration that separates the feasible S1 routes by more nats (spread %s)." % {k: round(v, 2) for k, v in spread.items()},
               disturbance_bounds=bounds, R_E=A.R_E, scenarios=results)
    methods = sorted({e["method"] for s_ in results.values() for e in s_["routes"].values() if not e["infeasible"]})
    doc["method"] = "ppo-ast" if methods == ["ppo-ast"] else ("cem" if "cem" in methods else (methods[0] if methods else "mc"))
    with open(os.path.join(OUT, "ast_results.json"), "w", encoding="utf8") as f:
        json.dump(_clean(doc), f, separators=(",", ":"), allow_nan=False)
    with open(os.path.join(OUT, "routes.json"), "w", encoding="utf8") as f:
        json.dump(_clean(dict(common, note="Candidate routes per scenario as planned by rl/planner.py through the engine; the stress test walks "
                                    "exactly these. time_s is the undisturbed walker of the stress-test simulator, engine_time_s the "
                                    "engine's polyline walker.", scenarios=routes_doc)), f, separators=(",", ":"), allow_nan=False)
    with open(os.path.join(OUT, "ast_training.json"), "w", encoding="utf8") as f:
        json.dump(_clean(dict(common, axes=dict(x="simulator steps (10 s decisions) used by the search", y="log-likelihood of the most likely "
                                         "failure found so far (nats, higher = more likely failure)"),
                       note="Plain Monte Carlo pays about 0.5 nat per step for its own pace noise, so its curve is also given without "
                            "that term (curve_without_pace_noise). Random search samples the same disturbance script as CEM from a "
                            "fixed distribution.", scenarios=training)), f, separators=(",", ":"), allow_nan=False)
    with open(os.path.join(OUT, "ast_baselines.json"), "w", encoding="utf8") as f:
        json.dump(_clean(dict(common, note="Best failure log-likelihood (nats) found within each simulator-step budget, one value per seed; "
                                    "null = no failure found within that budget or the run was shorter.",
                       budgets=BUDGETS, scenarios=baselines)), f, separators=(",", ":"), allow_nan=False)
    plots(training, baselines, results, headline)
    report(doc, training, baselines, summary, headline, spread)
    for scn in have:
        print(scn, "headline", headline)
        for key, e in results[scn]["routes"].items():
            print("  route %s %-38s nominal %5.1f min  MC %8.4f%%  robustness %s nats (%s; other config %s)  top: %s" % (
                key, e["label"][:38], e["nominal"]["time_s"] / 60, 100 * e.get("mc_fail_rate", float("nan")),
                e["robustness_nats"], e["method"], e["robustness_nats_other_configuration"],
                e["failures"][0]["class"] if e["failures"] else "-"))
    return doc


def plots(training, baselines, results, headline):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    col = {"mc": "#888888", "random_search": "#0072B2", "cem": "#D55E00", "cem_restart": "#CC79A7", "ppo-ast": "#009E73"}
    lab = {"mc": "Monte Carlo (nominal noise)", "random_search": "random search", "cem": "CEM", "cem_restart": "CEM restarts",
           "ppo-ast": "PPO adversary"}
    panels = [(scn, key, c) for scn in training for key in training[scn] for c in CONFIGS if training[scn][key].get(c)]
    if not panels:
        return
    ncol = min(4, len(panels)); nrow = int(math.ceil(len(panels) / ncol))
    fig, axes = plt.subplots(nrow, ncol, figsize=(4.6 * ncol, 3.6 * nrow), squeeze=False)
    for ax in axes.ravel():
        ax.axis("off")
    for ax, (scn, key, c) in zip(axes.ravel(), panels):
        ax.axis("on")
        for m, runs in training[scn][key][c].items():
            for i, x in enumerate(runs):
                pts = [(s, v) for s, v in x["curve"] if v is not None]
                if pts:
                    ax.plot([p[0] for p in pts], [p[1] for p in pts], color=col[m], lw=1.3, alpha=0.85, label=lab[m] if i == 0 else None,
                            drawstyle="steps-post")
                if m == "mc" and x.get("curve_without_pace_noise"):
                    pts = [(s, v) for s, v in x["curve_without_pace_noise"] if v is not None]
                    if pts:
                        ax.plot([p[0] for p in pts], [p[1] for p in pts], color=col[m], lw=1.0, ls=":", label="Monte Carlo, pace noise not counted")
        ax.set_title("%s route %s (%s)\n%s" % (scn, key, results[scn]["routes"][key]["shelter"], c.replace("_", " ")), fontsize=9)
        ax.set_xlabel("simulator steps"); ax.set_ylabel("best failure log-likelihood (nats)")
        ax.grid(alpha=0.25)
        if ax.lines:
            ax.set_xscale("log")
            ax.legend(fontsize=6.5, loc="lower right")
        else:
            ax.text(0.5, 0.5, "no failure found by any search\n(above the floor of -100 nats)", ha="center", va="center",
                    transform=ax.transAxes, fontsize=9)
            ax.set_xticks([]); ax.set_yticks([])
    fig.suptitle("Most likely failure found vs search budget, every seed shown. Model-based, team-assumed disturbance distributions.", fontsize=9)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "learning_curve_ast.png"), dpi=130)
    plt.close(fig)
    # equal-budget bars
    fig, axes = plt.subplots(nrow, ncol, figsize=(4.6 * ncol, 3.4 * nrow), squeeze=False)
    for ax in axes.ravel():
        ax.axis("off")
    for ax, (scn, key, c) in zip(axes.ravel(), panels):
        ax.axis("on")
        tab = baselines[scn][key][c]
        ms = [m for m in ("mc", "random_search", "cem", "cem_restart", "ppo-ast") if m in tab]
        for i, m in enumerate(ms):
            runs = training[scn][key][c][m]
            vals = [_best_at(x["curve"], 1e30) for x in runs]
            vals = [v for v in vals if v is not None]
            if vals:
                ax.bar(i, -np.mean(vals), color=col[m], alpha=0.85)
                ax.scatter([i] * len(vals), [-v for v in vals], color="k", s=10, zorder=3)
                ax.annotate("%.0fM" % (np.mean(tab[m]["sim_steps"]) / 1e6), (i, -np.mean(vals)), ha="center", va="bottom", fontsize=7,
                            xytext=(0, 3), textcoords="offset points")
        ax.set_xticks(range(len(ms))); ax.set_xticklabels([lab[m].replace(" (nominal noise)", "") for m in ms], fontsize=7, rotation=12)
        if not ax.patches:
            ax.text(0.5, 0.5, "no failure found by any search", ha="center", va="center", transform=ax.transAxes, fontsize=9)
        ax.set_ylabel("nats to the most likely failure found")
        ax.set_title("%s route %s (%s), %s\n(lower = stronger search)" % (
            scn, key, results[scn]["routes"][key]["shelter"], c.replace("_", " ")), fontsize=8)
        ax.grid(alpha=0.25, axis="y")
    fig.suptitle("Most likely failure found by each search at the end of its run; dots are seeds, the number on a bar is the simulator steps used "
                 "per seed (millions).\nBudget-by-budget values are in ast_baselines.json. Monte Carlo counts its own pace noise. "
                 "Model-based, team-assumed disturbance distributions.", fontsize=8)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "baselines_ast.png"), dpi=130)
    plt.close(fig)


def report(doc, training, baselines, summary, headline, spread):
    L = []
    w = L.append
    w("# Stress test of the candidate routes: what was run")
    w("")
    w(doc["wording"])
    w("")
    w("Generated %s on an RTX 5070 Ti laptop GPU (PyTorch, CUDA). Everything below is model-based: one walk model, one site, "
      "disturbance distributions that are team assumptions. Robustness in nats is minus the log-likelihood of the most likely "
      "failure found, a likelihood ratio and not a probability." % doc["generated_utc"])
    w("")
    w("## Setup")
    w("")
    w("- Simulator: `rl/env.py` walk model (batched on the GPU) wrapped by `rl/ast_env.py`; the hooked step reproduces the original "
      "step exactly when no disturbance is applied (see `rl/runs/ast/smoke_S1.json`).")
    w("- System under test: " + doc["system_under_test"])
    w("- Routes: planned by `rl/planner.py` through the engine (`rl/runs/ast/engine_cases.json`, exported as `routes.json`).")
    w("- Disturbance channels: " + "; ".join("%s (%s)" % (k, v) for k, v in doc["disturbance_bounds"].items()) + ".")
    w("- Two configurations: " + "; ".join("`%s`: %s" % (k, v) for k, v in doc["configurations"].items()) + ".")
    w("- Headline configuration: `%s`. Rule: %s" % (headline, doc["headline_rule"]))
    w("")
    w("Budgets and seeds:")
    w("")
    for scn, S in summary.items():
        bits = []
        m = next((x for x in S["mc"].values() if x), None)
        if m:
            bits.append("Monte Carlo %d rollouts per route and configuration (seed %d)" % (m["routes"][0]["n"], m["seed"]))
        c_ = next((x for x in S["cem"].values() if x), None)
        if c_:
            bits.append("random search and CEM %d iterations x %d scripts, seeds %s; CEM restarts refine the 3 most likely distinct "
                        "failures of each random-search seed for %d iterations; one class-restricted CEM per failure class" % (
                            c_["iters"], c_["pop"], ", ".join(str(q) for q in c_["seeds"]), c_.get("refine_iters", 15)))
        p_ = next((x for x in S["ppo"].values() if x), None)
        if p_:
            bits.append("PPO adversary %d walkers x %d steps x %d updates = %.0fM simulator steps per route and seed, seeds %s, R_E %.0f, "
                        "gamma %.3g, %s; the shipped seed is the one with the most likely failure on fresh-seed rollouts" % (
                            p_["envs"], p_["rollout"], p_["updates"], p_["envs"] * p_["rollout"] * p_["updates"] / 1e6,
                            ", ".join(str(q) for q in p_["seeds"]), p_["R_E"], p_["gamma"], p_["network"]))
        else:
            bits.append("no PPO adversary run")
        w("- %s: %s." % (scn, "; ".join(bits)))
    w("")
    w("Failure definitions (team assumptions):")
    w("")
    for d in doc["failure_definitions"]:
        w("- " + d)
    w("")
    w("Assumptions:")
    w("")
    for d in doc["assumptions"]:
        w("- " + d)
    w("")
    w("## Results")
    for scn, S in summary.items():
        case = S["case"]
        res = doc["scenarios"][scn]
        w("")
        w("### %s: %s" % (scn, res["title"]))
        w("")
        dl = res["deadline_s"]
        w("Start (%.0f, %.0f) core metres, pace %.2f m/s, %s." % (
            res["context"]["start_xy"][0], res["context"]["start_xy"][1], res["context"]["pace"],
            "no deadline" if dl is None else "%.1f min of walking allowed (%s)" % (dl / 60, "expected dose-rate peak" if res["late_basis"] == "peak" else "30-minute shelter rule")))
        w("")
        w("| Route | Undisturbed walk | Monte Carlo failure rate (95 %% Wilson) | Robustness, nats (`%s`) | Robustness, nats (other) | Most likely failure | Method |" % headline)
        w("|---|---|---|---|---|---|---|")
        for key, e in res["routes"].items():
            nom = e["nominal"]
            mcs = "n/a"
            if "mc_fail_rate" in e:
                mcs = "%.3f %% (%.3f to %.3f), n = %d" % (100 * e["mc_fail_rate"], 100 * e["mc_ci"][0], 100 * e["mc_ci"][1], e["n"])
            if e["infeasible"]:
                w("| %s %s | infeasible without any disturbance (%s) | %s | not scored | not scored | %s | n/a |" % (
                    key, e["label"], nom["failure"], mcs, e["failures"][0]["summary"]))
            else:
                w("| %s %s | %.1f min%s | %s | %s | %s | %s | %s |" % (
                    key, e["label"], nom["time_s"] / 60, "" if nom["slack_s"] is None else ", %.1f min spare" % (nom["slack_s"] / 60), mcs,
                    _nf(e["robustness_nats"]), _nf(e["robustness_nats_other_configuration"], e.get("other_configuration_searched", True)),
                    e["failures"][0]["summary"] if e["failures"] else "none found", e["method"]))
        w("")
        for key, e in res["routes"].items():
            if e["infeasible"]:
                continue
            for c in CONFIGS:
                d = e["configurations"][c]
                bits = []
                if "monte_carlo" in d:
                    bits.append("Monte Carlo classes " + ", ".join("%s %.3f %%" % (k, 100 * v) for k, v in d["monte_carlo"]["classes"].items() if v) if any(d["monte_carlo"]["classes"].values()) else "Monte Carlo: no failures")
                if d.get("most_likely_failure_per_class_nats"):
                    bits.append("most likely failure per class (nats): " + ", ".join("%s %s" % (k, "not found" if v is None else v) for k, v in d["most_likely_failure_per_class_nats"].items()))
                for nm, k_ in (("CEM", "cem_best_log_p"), ("random search", "random_search_best_log_p"),
                               ("CEM restarts", "cem_restart_best_log_p"), ("PPO", "ppo_best_log_p")):
                    if d.get(k_):
                        bits.append("%s best log-likelihood per seed: %s" % (nm, ", ".join("none" if v is None else "%.2f" % v for v in d[k_])))
                w("- Route %s, `%s`: %s." % (key, c, "; ".join(bits)))
        w("")
    w("## What held and what did not")
    w("")
    for line in findings(doc, baselines, summary, headline, spread):
        w("- " + line)
    w("")
    w("## Limits")
    w("")
    for line in [
        "One site, three scripted incidents, fixed candidate routes: there is no generalisation claim.",
        "The walk model is not crew-validated. Fall rate, injury chance and all disturbance distributions are team assumptions; "
        "robustness values move with them (see the sensitivity rows if present).",
        "The adversary tests routes. It does not choose or change them; the planner generates the candidates.",
        "The stress-test simulator follows the planner's field, the engine's replay walker follows the drawn polyline: the same model "
        "in two implementations. Undisturbed walk times of both are listed in `routes.json`.",
        "Non-adversarial randomness (terrain-noise seed, recovery time after a stumble) is sampled in Monte Carlo and fixed at its "
        "nominal value in the adversarial searches, so that every reported failure replays exactly.",
        "The 1 m DTM has no footstep-scale terrain; the loose-sand layer is an image proxy.",
        "The \"most likely failure\" is the highest-density failure, not the most frequent one: a failure that needs one precise "
        "navigation error can score few nats and still be rare in Monte Carlo. Read robustness next to the Monte Carlo rate.",
        "The crew protocol in the stress-test simulator (re-localise after a blocked move or 90 s without progress, then follow the "
        "plan cell by cell) is a team assumption; without it the adversary finds freezes of the path follower instead of crew failures.",
        "The reported failures were replayed in the same simulator only. They were not replayed in the TypeScript reference model "
        "(`reference/ts_engine/sim.ts`); the cross-check against the engine's walker is a comparison of Monte Carlo rates.",
        "A search floor applies: a failure less likely than 100 nats (R_E) counts as not found.",
        "Robustness is an upper bound from a finite search: a more likely failure that no search found may exist. The per-seed "
        "values above show how often each search reached the reported one.",
    ]:
        w("- " + line)
    w("")
    w("Files: `ast_results.json`, `routes.json`, `ast_training.json`, `ast_baselines.json`, `ast_heatmap_<scenario>_<route>.png`, "
      "`learning_curve_ast.png`, `baselines_ast.png`. Code: `rl/ast_env.py`, `rl/ast_mc.py`, `rl/ast_cem.py`, `rl/train_ast.py`, "
      "`rl/eval_ast.py`, `rl/export_ast.py`.")
    extra = os.path.join(RUNS, "report_extra.md")
    if os.path.exists(extra):
        w("")
        L.extend(open(extra, encoding="utf8").read().rstrip().split("\n"))
    with open(os.path.join(OUT, "REPORT.md"), "w", encoding="utf8") as f:
        f.write("\n".join(L) + "\n")


def findings(doc, baselines, summary, headline, spread):
    out = []
    sm = _load("smoke_S1.json")
    if sm:
        ok = [k for k, v in sm["passed"].items() if v]; bad = [k for k, v in sm["passed"].items() if not v]
        thr = sm["checks"]["throughput"]["steps_per_s"]
        out.append("Smoke test (U2 section 9.8) on S1: %d of 5 checks passed (%s)%s. Throughput %.0fk simulator steps per second with the "
                   "hooks on; the hooked step reproduces the original step exactly (max difference %g); see `rl/runs/ast/smoke_S1.json`." % (
                       len(ok), ", ".join(ok), "" if not bad else "; failed: " + ", ".join(bad), thr / 1e3,
                       sm["checks"]["parity"]["max_abs_state_diff"]))
    for scn, res in doc["scenarios"].items():
        feas = [(k, e) for k, e in res["routes"].items() if not e["infeasible"]]
        inf = [e["label"] for e in res["routes"].values() if e["infeasible"]]
        if inf:
            out.append("%s: %s infeasible without any disturbance (the undisturbed walker is not under cover in time) and not scored." % (
                scn, ", ".join(inf) + (" is" if len(inf) == 1 else " are")))
        if len(feas) >= 2:
            big = lambda v: 1e9 if v is None else v          # no failure found ranks above any finite value
            order_h = sorted(feas, key=lambda q: -big(q[1]["robustness_nats"]))
            order_o = sorted(feas, key=lambda q: -big(q[1]["robustness_nats_other_configuration"]))
            vh = [big(e["robustness_nats"]) for _, e in feas]; vo = [big(e["robustness_nats_other_configuration"]) for _, e in feas]

            def line(order, vals, key, srch):
                if min(vals) >= 1e9:
                    return "no failure found for any scored route above the search floor (log-likelihood -100 nats)"
                if max(vals) - min(vals) < 0.3:
                    return "the routes are not separated (%s; differences under 0.3 nat are within the spread between seeds)" % ", ".join(
                        "%s %s" % (e["label"], _nf(e[key], e.get("other_configuration_searched", True) if srch else True)) for _, e in order)
                return " > ".join("%s (%s)" % (e["label"], _nf(e[key], e.get("other_configuration_searched", True) if srch else True)) for _, e in order)
            sep_h = max(vh) - min(vh) >= 0.3; sep_o = max(vo) - min(vo) >= 0.3
            tail = ""
            if sep_h and sep_o:
                tail = " The ranking is the same in both configurations." if [k for k, _ in order_h] == [k for k, _ in order_o] \
                    else " The ranking differs between the configurations."
            out.append("%s by robustness (`%s`): %s. Other configuration: %s.%s" % (
                scn, headline, line(order_h, vh, "robustness_nats", False),
                line(order_o, vo, "robustness_nats_other_configuration", True), tail))
            cls = {e["failures"][0]["class"] for _, e in feas if e["failures"]}
            if len(cls) == 1:
                out.append("%s: every scored route has the same most likely failure class (%s)." % (scn, list(cls)[0]))
        elif len(feas) == 1:
            k, e = feas[0]
            out.append("%s: one route can be scored (%s): %s nats (`%s`), %s (other configuration)." % (
                scn, e["label"], _nf(e["robustness_nats"]), headline, _nf(e["robustness_nats_other_configuration"], e.get("other_configuration_searched", True))))
    # method comparison (final best failure log-likelihood per seed)
    names = {"mc": "Monte Carlo", "random_search": "random search", "cem": "CEM", "cem_restart": "CEM restarts", "ppo-ast": "PPO adversary"}
    tally = {}
    ppo_cmp = [0, 0, 0]
    n_cfg = 0
    for scn, routes in baselines.items():
        for key, cfgs in routes.items():
            for c, tab in cfgs.items():
                fin = {m: [v for v in tab[m]["final"] if v is not None] for m in tab}
                best = {m: max(v) for m, v in fin.items() if v}
                if not best:
                    continue
                n_cfg += 1
                top = max(best.values())
                for m, v in best.items():
                    if v >= top - 0.05:
                        tally[m] = tally.get(m, 0) + 1
                if "ppo-ast" in tab:
                    others = [best[m] for m in ("cem", "cem_restart", "random_search") if m in best]
                    ref = max(others) if others else None
                    for v in tab["ppo-ast"]["final"]:
                        ppo_cmp[1] += 1
                        if v is not None and ref is not None and v > ref + 0.05:
                            ppo_cmp[0] += 1
                        elif v is not None and ref is not None and abs(v - ref) <= 0.05:
                            ppo_cmp[2] += 1
    if tally:
        out.append("Which search found the most likely failure (within 0.05 nat of the best, per route and configuration, %d cases): %s." % (
            n_cfg, ", ".join("%s %d" % (names[m], tally[m]) for m in ("mc", "random_search", "cem", "cem_restart", "ppo-ast") if m in tally)))
        out.append("A single-Gaussian CEM can settle in the first failure basin it meets (often the incapacitating fall) and miss a more "
                   "likely failure elsewhere; CEM restarts (random search, then local refinement) are the reference search here.")
    if ppo_cmp[1]:
        out.append("PPO adversary against the best non-learning search on the same route and configuration, seed by seed: better by more "
                   "than 0.05 nat in %d of %d, equal within 0.05 nat in %d. %s" % (
                       ppo_cmp[0], ppo_cmp[1], ppo_cmp[2],
                       "PPO meets the 2-of-3 gate of rl/TASK.md." if ppo_cmp[0] * 3 >= ppo_cmp[1] * 2 else
                       "PPO did not beat the search baselines in 2 of 3 seeds, so the cross-entropy search is the headline method and PPO is "
                       "reported as it is."))
    else:
        out.append("No PPO adversary results are included in this export; the cross-entropy search is the headline method.")
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", action="store_true", help="capture incident contexts and routes from the engine")
    ap.add_argument("--scenarios", nargs="+", default=["S1", "S2", "S3"])
    args = ap.parse_args()
    if args.cases:
        dump_engine_cases()
    else:
        assemble(args.scenarios)
