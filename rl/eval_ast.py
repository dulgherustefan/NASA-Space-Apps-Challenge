"""Evaluation of the stress-test runs: fresh-seed rollouts of the trained adversaries, sensitivity to the assumed
disturbance scales and to R_E, and a cross-check of the Monte Carlo rates against the engine's polyline walker.

  python rl/eval_ast.py --engine-check          engine walker vs the batched simulator, plain Monte Carlo
  python rl/eval_ast.py --sensitivity           CEM with all sigmas x0.7 and x1.3 (S1)
  python rl/eval_ast.py --ppo                   trained adversaries on fresh seeds, compared with Monte Carlo
  python rl/eval_ast.py --write                 collect what exists into rl/runs/ast/report_extra.md

Results: rl/runs/ast/eval_*.json. Model-based numbers under team-assumed distributions; not crew-validated.
"""
import argparse
import json
import math
import os
import sys

import numpy as np
import torch

import ast_env as A
from ast_env import Case, CLASSES, RUNS, wilson

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CONFIGS = ["falls_terminal", "falls_penalty"]


def _load(name):
    p = os.path.join(RUNS, name)
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf8") as f:
        return json.load(f)


def engine_check(n=20000):
    """Plain Monte Carlo with the engine's own walker (engine/walk.py, follows the drawn polyline) on the same routes."""
    sys.path.insert(0, ROOT)
    from engine.__main__ import build, warm
    from engine import stress as S
    from engine.routes import late_deadline
    from engine.walk import monte_carlo
    d = build(False)
    d.hz.write_static()
    warm(d.site)
    d.command({"cmd": "demo"})
    wall = 0.0
    while d.program is not None and wall < 900:
        d.tick(0.05); wall += 0.05; d.drain()
    out = {}
    for scn, iid in A.SCEN_IDS.items():
        rows = []
        for r in d.history[iid]["routes"]:
            dl = late_deadline(r["ctx"])
            res, _ = monte_carlo(d.site, r["poly"], r["legs"], r["nominal"]["prm"], n, seed0=4242 + r["id"])
            cls = [S.classify(row, dl) for row in res]
            k = sum(1 for c in cls if c != "ok")
            rows.append(dict(route=r["id"], shelter=r["shelter"], label=r["label"], n=n, fail_rate=k / n, ci=wilson(k, n),
                             classes={c: sum(1 for q in cls if q == c) / n for c in CLASSES}, nominal_time_s=r["time_s"]))
        out[scn] = rows
    with open(os.path.join(RUNS, "eval_engine_check.json"), "w") as f:
        json.dump(out, f, default=float)
    for scn, rows in out.items():
        for q in rows:
            print(scn, q["route"], q["label"], "engine walker fail %.3f%%" % (100 * q["fail_rate"]), {k: round(100 * v, 3) for k, v in q["classes"].items() if v})
    return out


def sensitivity(scenario="S1", scales=(0.7, 1.3), iters=20, pop=2048, seeds=(0, 1)):
    import ast_cem as C
    device = torch.device("cuda")
    case = Case(scenario, device)
    out = {}
    for sc in scales:
        for terminal in (True, False):
            nominal = A.nominal_runs(case, terminal)
            rows = []
            for r in range(case.R):
                if not A.feasible(nominal[r]):
                    rows.append(None)
                    continue
                res = C.cem_multi(case, r, nominal, [dict(seed=s, adapt=True) for s in seeds], terminal, sc, iters, pop, verbose=False)
                best = max([q["best_log_p"] for q in res if q["best_log_p"] is not None], default=None)
                rows.append(None if best is None else -best)
                print("sigma x%.1f %s %s: %s nats" % (sc, C.cfg_name(terminal), case.route_name(r), None if best is None else round(-best, 2)), flush=True)
            out["%s|%.1f|%s" % (scenario, sc, C.cfg_name(terminal))] = rows
    with open(os.path.join(RUNS, "eval_sensitivity_%s.json" % scenario), "w") as f:
        json.dump(out, f, default=float)
    return out


def ppo_fresh(scenario="S1", n_eval=4096):
    """Trained adversaries on RNG seeds never used in training, against plain Monte Carlo at the same number of rollouts."""
    import train_ast as T
    import ast_mc as M
    device = torch.device("cuda")
    case = Case(scenario, device)
    out = {}
    for cfg in CONFIGS:
        ck = os.path.join(RUNS, "ckpt_ppo_%s_%s.pt" % (scenario, cfg))
        if not os.path.exists(ck):
            continue
        st = torch.load(ck, map_location=device, weights_only=False)
        groups = [tuple(g) for g in st["groups"]]
        net = T.Adversary(len(groups), st["n_obs"], [0] * len(groups)).to(device)
        net.load_state_dict(st["state"])
        env = T.evaluate_policy(case, net, groups, st["falls_terminal"], st["sig_scale"], n_eval, seed=20261115)
        evs = T.summarise_eval(case, env, groups, n_eval)
        mcd = _load("mc_%s_%s.json" % (scenario, cfg))
        rows = []
        for g, (r, s) in enumerate(groups):
            e = evs[g]
            thr = None
            if mcd and mcd["routes"][r]["best_log_p_events"] is not None:
                thr = mcd["routes"][r]["top"][min(len(mcd["routes"][r]["top"]) - 1, 9)]["log_p_events"]
            lp = env.logp.view(len(groups), n_eval)[g].cpu().numpy(); fl = env.fail.view(len(groups), n_eval)[g].cpu().numpy() > 0
            rows.append(dict(route_index=r, seed=s, n=n_eval, best_log_p=e["best_log_p"], fail_rate_mean_action=e["fail_rate_mean_action"],
                             fail_rate_sampled=e["fail_rate_sampled"], classes=e["classes"], distinct_sites=e["distinct_sites"],
                             mc_fail_rate=None if not mcd else mcd["routes"][r]["fail_rate"],
                             failures_per_1000_above_minus15=float(1000 * (fl & (lp > -15)).mean()),
                             failures_per_1000_above_minus12=float(1000 * (fl & (lp > -12)).mean())))
            print(scenario, cfg, "route", r, "seed", s, "best %s, failures per 1000 rollouts with log p > -15: %.1f (adversary), failure rate %.3f vs MC %.5f" % (
                e["best_log_p"], rows[-1]["failures_per_1000_above_minus15"], e["fail_rate_sampled"], rows[-1]["mc_fail_rate"] or float("nan")), flush=True)
        out[cfg] = rows
    with open(os.path.join(RUNS, "eval_ppo_%s.json" % scenario), "w") as f:
        json.dump(out, f, default=float)
    return out


def write_extra():
    L = []
    w = L.append
    ec = _load("eval_engine_check.json")
    if ec:
        w("## Cross-check against the engine's walker")
        w("")
        w("The stress test runs on the batched field-following simulator (`rl/ast_env.py`). The engine replays walkers with its own "
          "port of the same model that follows the drawn polyline (`engine/walk.py`). Plain Monte Carlo failure rates of both, same "
          "routes, same nominal disturbances (falls can be incapacitating):")
        w("")
        w("| Scenario | Route | Engine walker (n = %d) | Batched simulator |" % ec[list(ec)[0]][0]["n"])
        w("|---|---|---|---|")
        for scn, rows in ec.items():
            mc = _load("mc_%s_falls_terminal.json" % scn)
            for i, q in enumerate(rows):
                mine = "not run"
                if mc and i < len(mc["routes"]):
                    m = mc["routes"][i]
                    mine = "%.3f %% (%s)" % (100 * m["fail_rate"], ", ".join("%s %.3f %%" % (k, 100 * v / m["n"]) for k, v in m["classes"].items() if v) or "no failures")
                w("| %s | %d %s | %.3f %% (%s) | %s |" % (scn, q["route"], q["label"], 100 * q["fail_rate"],
                                                        ", ".join("%s %.3f %%" % (k, 100 * v) for k, v in q["classes"].items() if v) or "no failures", mine))
        w("")
        w("Differences come from the path following (guidance field with a 53 m navigation offset applied to the believed position, "
          "against pure pursuit of the polyline) and are part of the model uncertainty.")
        w("")
    for scn in ("S1", "S2", "S3"):
        se = _load("eval_sensitivity_%s.json" % scn)
        if not se:
            continue
        w("## Sensitivity to the assumed disturbance scales (%s, CEM)" % scn)
        w("")
        w("All Gaussian disturbance scales multiplied by 0.7 and 1.3 (stumble and injury probabilities unchanged). Robustness in nats per route index; "
          "`None` = infeasible without any disturbance.")
        w("")
        w("| Sigma scale | Configuration | Robustness per route (nats) | Order of the scored routes |")
        w("|---|---|---|---|")
        base = {}
        for cfg in CONFIGS:
            d = _load("cem_%s_%s.json" % (scn, cfg))
            if d:
                base[cfg] = [None if q.get("robustness_nats") is None else q["robustness_nats"] for q in d["routes"]]
        rows = [("1.0", cfg, v) for cfg, v in base.items()] + [(k.split("|")[1], k.split("|")[2], v) for k, v in se.items()]
        orders = {}
        for sc, cfg, v in sorted(rows, key=lambda q: (q[1], q[0])):
            idx = [i for i, x in enumerate(v) if x is not None]
            order = sorted(idx, key=lambda i: -v[i])
            orders.setdefault(cfg, []).append(order)
            w("| x%s | `%s` | %s | %s |" % (sc, cfg, ", ".join("-" if x is None else "%.2f" % x for x in v), " > ".join(str(i) for i in order)))
        w("")
        for cfg, o in orders.items():
            w("- `%s`: the route order is %s across the three scales." % (cfg, "the same" if all(x == o[0] for x in o) else "NOT the same"))
        w("")
    for scn in ("S1", "S2", "S3"):
        pe = _load("eval_ppo_%s.json" % scn)
        if not pe:
            continue
        w("## Trained adversaries on fresh seeds (%s)" % scn)
        w("")
        w("Rollouts with random seeds never used in training (%d per adversary, half with the mean action, half sampled). The adversary "
          "samples from a tilted distribution, so the count is of failures at least as plausible as a threshold, not a failure rate of the crew." % pe[list(pe)[0]][0]["n"])
        w("")
        w("| Configuration | Route index | Seed | Best failure log-likelihood | Failures per 1000 rollouts with log p > -15 | Distinct failure sites (> 100 m apart or other class) | Plain Monte Carlo failure rate |")
        w("|---|---|---|---|---|---|---|")
        for cfg, rows in pe.items():
            for q in rows:
                w("| `%s` | %d | %d | %s | %.1f | %d | %s |" % (cfg, q["route_index"], q["seed"], "none" if q["best_log_p"] is None else "%.2f" % q["best_log_p"],
                                                              q["failures_per_1000_above_minus15"], q["distinct_sites"],
                                                              "n/a" if q["mc_fail_rate"] is None else "%.3f %%" % (100 * q["mc_fail_rate"])))
        w("")
    re_rows = []
    for tag, val in (("_re50", 50), ("", 100), ("_re200", 200)):
        for cfg in CONFIGS:
            d = _load("ppo_S1_%s%s.json" % (cfg, tag))
            if d:
                re_rows.append((val, cfg, [None if (q is None or q["best_log_p"] is None) else -q["best_log_p"] for q in d["routes"]]))
    if len({v for v, _, _ in re_rows}) > 1:
        w("## Sensitivity of the PPO adversary to R_E (S1)")
        w("")
        w("| R_E | Configuration | Robustness per route (nats, best seed) |")
        w("|---|---|---|")
        for val, cfg, v in re_rows:
            w("| %d | `%s` | %s |" % (val, cfg, ", ".join("-" if x is None else "%.2f" % x for x in v)))
        w("")
    with open(os.path.join(RUNS, "report_extra.md"), "w", encoding="utf8") as f:
        f.write("\n".join(L) + "\n")
    print("wrote report_extra.md (%d lines)" % len(L))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine-check", action="store_true")
    ap.add_argument("--sensitivity", action="store_true")
    ap.add_argument("--ppo", action="store_true")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--scenario", default="S1")
    args = ap.parse_args()
    if args.engine_check:
        engine_check()
    if args.sensitivity:
        sensitivity(args.scenario)
    if args.ppo:
        ppo_fresh(args.scenario)
    if args.write or not (args.engine_check or args.sensitivity or args.ppo):
        write_extra()
