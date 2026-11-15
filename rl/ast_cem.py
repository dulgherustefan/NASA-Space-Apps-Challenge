"""Cross-entropy method (CEM) adversary and a random-search baseline over a parametric disturbance script.

The script has the same channels as the reinforcement-learning adversary (rl/ast_env.py), with a fixed structure:
  4 episode values (metabolic, cooling, navigation x, y), one pace-drift window (z, start, length along the route),
  K forced stumbles (position along the route + on/off), and whether the first forced stumble is incapacitating.
Stumbles that are not forced are suppressed; their log(1 - pFall) terms are still counted.
Objective (maximised): log-likelihood of the disturbances if the walk fails, otherwise -R_E - 100 * miss distance.

Three searches are run per route and compared at equal simulator budgets:
  random search    the script sampled from a fixed distribution (no adaptation)
  CEM              one Gaussian over the script, adapted from the start
  CEM restarts     random search first, then local CEM refinement around its most likely distinct failures
                   (the failure landscape has several separate basins; one Gaussian settles in the first it finds)

  python rl/ast_cem.py --scenario S1 --both --seeds 0 1 2

Writes rl/runs/ast/cem_<scenario>_<config>.json.
"""
import argparse
import json
import math
import os
import time

import numpy as np
import torch

import ast_env as A
from ast_env import ASTEnv, Case, CLASSES, BIG, RUNS, R_E
from env import DT, O2_TANK_KG

K_STUMBLES = {True: 3, False: 12}
C_CODE = {0: 0, 1: 3, 2: 4, 3: 5, 4: 7, 5: 1}        # failure code -> contract status (stuck shown as idle)


def cfg_name(falls_terminal):
    return "falls_terminal" if falls_terminal else "falls_penalty"


def theta_dim(K):
    return 4 + 3 + 2 * K + 1


def theta_init(K, device):
    D = theta_dim(K)
    mu = torch.zeros(D, device=device); sd = torch.ones(D, device=device)
    sd[5:7] = 1.5; sd[7:7 + K] = 1.5
    mu[7 + K:7 + 2 * K] = -0.5
    mu[-1] = 0.0
    return mu, sd


class Script:
    """Disturbance script for n walkers from theta [n, D]."""

    def __init__(self, env, theta, K, route_len):
        self.K = K
        self.z_setup = theta[:, :4]
        self.zp = theta[:, 4].clamp(-A.Z_CLIP, A.Z_CLIP)
        self.p0 = torch.sigmoid(theta[:, 5])
        self.p1 = self.p0 + torch.sigmoid(theta[:, 6]) * (1 - self.p0)
        self.pos = torch.sigmoid(theta[:, 7:7 + K])
        self.gate = theta[:, 7 + K:7 + 2 * K] > 0
        self.inj = theta[:, -1] > 0
        self.fired = torch.zeros_like(self.gate)
        self.L = route_len
        self.cur = None

    def act(self, env):
        frac = env.dist / self.L
        zv = torch.where((frac >= self.p0) & (frac <= self.p1), self.zp, torch.zeros_like(self.zp))
        due = self.gate & ~self.fired & (frac[:, None] >= self.pos)
        any_due = due.any(1)
        self.cur = torch.argmax(due.to(torch.int8), 1)
        self.any = any_due
        pos = torch.full_like(frac, BIG)
        d_fall = torch.where(any_due, pos, -pos)
        d_inj = torch.where(any_due & self.inj & (self.cur == 0), pos, -pos)
        return zv, d_fall, d_inj

    def after(self, env):
        hit = env.s_fell & self.any
        if bool(hit.any()):
            idx = torch.nonzero(hit).squeeze(1)
            self.fired[idx, self.cur[idx]] = True


def evaluate(case, rid, theta, falls_terminal=True, sig_scale=1.0, record=False, route_len=None, only=None):
    """Run the scripts theta [n, D] on routes rid [n]. only: failure code per walker (0 = any class counts).
    Returns (env, objective J [n] float64)."""
    n = theta.shape[0]
    K = (theta.shape[1] - 8) // 2
    env = ASTEnv(case, n, seed=0, falls_terminal=falls_terminal, sig_scale=sig_scale, mode="adv", record=record)
    env.reset_routes(rid)
    sc = Script(env, theta, K, route_len[env.rid])
    env.setup(sc.z_setup)
    k = 0
    while not bool(env.done.all()) and k < 2200:
        o = env.observe()
        zv, df, di = sc.act(env)
        env.ast_step(zv, df, di, obs=o)
        sc.after(env)
        k += 1
    if only is None:
        failed = env.fail > 0
        J = torch.where(failed, env.logp, -R_E - 100.0 * env.miss_distance())
    else:
        failed = torch.where(only > 0, env.fail == only, env.fail > 0)
        J = torch.where(failed, env.logp, -R_E - 100.0 * env.miss_distance() - 50.0 * ((only > 0) & (env.fail == 0)).double())
    env.failed_mask = failed
    return env, J


def route_lengths(case, nominal):
    return torch.tensor([max(q["dist_m"], 1.0) for q in nominal], device=case.device)


def distinct(items, k=3, min_dist=100.0):
    """Most likely failures that differ in class or lie more than min_dist metres apart."""
    out = []
    for it in sorted(items, key=lambda q: -q["log_p"]):
        if all(it["class"] != o["class"] or math.hypot(it["x"] - o["x"], it["y"] - o["y"]) > min_dist for o in out):
            out.append(it)
        if len(out) == k:
            break
    return out


def cem_multi(case, r, nominal, specs, falls_terminal=True, sig_scale=1.0, iters=30, pop=2048, elite=0.05, smooth=0.7,
              verbose=True):
    """Several independent searches on route index r in one batch. specs: list of dict(seed, adapt, only) where
    adapt=False is random search (the sampling distribution never moves) and only restricts the failure class."""
    dev = case.device
    G = len(specs)
    K = K_STUMBLES[falls_terminal]
    L = route_lengths(case, nominal)
    gen = torch.Generator(device=dev)
    gen.manual_seed(424243 + 97 * r + sum((i + 1) * 7919 * (q["seed"] + 1) for i, q in enumerate(specs)))
    mu0, sd0 = theta_init(K, dev)
    D = mu0.numel()
    mu = mu0[None].repeat(G, 1); sd = sd0[None].repeat(G, 1)
    for g, q in enumerate(specs):                    # local refinement: start at a given script with a small spread
        if q.get("init") is not None:
            mu[g] = torch.as_tensor(np.asarray(q["init"]), device=dev, dtype=mu.dtype)
            sd[g] = float(q.get("sd0", 0.3))
    adapt = torch.tensor([bool(q.get("adapt", True)) for q in specs], device=dev)
    only_g = torch.tensor([int(q.get("only") or 0) for q in specs], device=dev)
    rid = torch.full((G * pop,), r, device=dev, dtype=torch.long)
    only = only_g.repeat_interleave(pop)
    ne = max(8, int(pop * elite))
    steps = np.zeros(G); best = np.full(G, -math.inf)
    curves = [[] for _ in range(G)]; archives = [[] for _ in range(G)]
    best_theta = [None] * G
    t0 = time.time()

    def absorb(env, J, theta, m):
        fail = env.failed_mask.view(G, m)
        lp = torch.where(env.failed_mask, env.logp, torch.full_like(env.logp, -math.inf)).view(G, m)
        st = (env.ft / DT).view(G, m).sum(1).cpu().numpy()
        nf = fail.sum(1).cpu().numpy()
        Jm = J.view(G, m).mean(1).cpu().numpy()
        th = theta.view(G, m, D)
        kk = min(48, m)
        top = torch.topk(lp, kk, dim=1)
        tv = top.values.cpu().numpy(); ti = top.indices.cpu().numpy()
        fc = env.fail.view(G, m).cpu().numpy(); fx = env.fx.view(G, m).cpu().numpy(); fy = env.fy.view(G, m).cpu().numpy()
        ft = env.ft.view(G, m).cpu().numpy()
        for g in range(G):
            steps[g] += st[g]
            for v, i in zip(tv[g], ti[g]):
                if not math.isfinite(v):
                    break
                archives[g].append(dict(**{"class": CLASSES[int(fc[g, i]) - 1]}, x=float(fx[g, i]), y=float(fy[g, i]), t=float(ft[g, i]),
                                        log_p=float(v), theta=th[g, i].cpu().numpy()))
            if math.isfinite(tv[g, 0]) and tv[g, 0] > best[g]:
                best[g] = float(tv[g, 0]); best_theta[g] = th[g, ti[g, 0]].clone()
            archives[g] = sorted(archives[g], key=lambda q: -q["log_p"])[:384]
            curves[g].append([int(steps[g]), best[g] if math.isfinite(best[g]) else None, float(nf[g]) / m, float(Jm[g])])

    for it in range(iters):
        theta = (mu[:, None, :] + sd[:, None, :] * torch.randn((G, pop, D), generator=gen, device=dev)).view(G * pop, D)
        env, J = evaluate(case, rid, theta, falls_terminal, sig_scale, route_len=L, only=only)
        absorb(env, J, theta, pop)
        el = torch.topk(J.view(G, pop), ne, dim=1).indices
        eth = torch.gather(theta.view(G, pop, D), 1, el[:, :, None].expand(G, ne, D))
        nmu = (1 - smooth) * mu + smooth * eth.mean(1)
        nsd = ((1 - smooth) * sd + smooth * eth.std(1)).clamp_min(0.02)
        mu = torch.where(adapt[:, None], nmu, mu); sd = torch.where(adapt[:, None], nsd, sd)
    # polish (adaptive searches): sweep the position of the first forced stumble around the best script found
    m = 1024
    if any(bt is not None for bt in best_theta) and bool(adapt.any()):
        base = torch.stack([bt if bt is not None else mu[g] for g, bt in enumerate(best_theta)], 0)
        th = base[:, None, :].repeat(1, m, 1)
        u = (torch.arange(m, device=dev) + 0.5) / m
        th[:, :, 7] = torch.where(adapt[:, None], torch.logit(u.clamp(1e-4, 1 - 1e-4))[None, :], th[:, :, 7])
        th = th.view(G * m, D)
        env, J = evaluate(case, rid[:G * m], th, falls_terminal, sig_scale, route_len=L, only=only_g.repeat_interleave(m))
        keep = steps.copy()
        absorb(env, J, th, m)
        for g in range(G):
            if not bool(adapt[g]):
                steps[g] = keep[g]; curves[g].pop()
    out = []
    for g, q in enumerate(specs):
        if verbose:
            print("  %s %s seed %d%s: best failure log p %s after %.1fM steps" % (
                ("CEM" if q.get("init") is None else "local CEM") if q.get("adapt", True) else "random search", case.route_name(r), q["seed"],
                "" if not q.get("only") else " only " + CLASSES[q["only"] - 1],
                "%.2f" % best[g] if math.isfinite(best[g]) else "none found", steps[g] / 1e6), flush=True)
        out.append(dict(best_log_p=best[g] if math.isfinite(best[g]) else None, curve=curves[g], sim_steps=int(steps[g]), seed=q["seed"],
                        archive=archives[g], mu=mu[g].cpu().numpy(), sd=sd[g].cpu().numpy(),
                        best_theta=None if best_theta[g] is None else best_theta[g].cpu().numpy(), K=K))
    if verbose:
        print("    (%d searches in one batch, %.0f s)" % (G, time.time() - t0), flush=True)
    return out


# ---------------------------------------------------------------------------------------------- replays
def describe(case, f):
    """One-line summary of a failure, in the engine's style."""
    ev = {e["channel"]: e for e in f["events"]}
    hints = []
    if "cooling" in ev and ev["cooling"]["value"] < 0.95:
        hints.append("cooling at %.2f" % ev["cooling"]["value"])
    if "metabolic" in ev and ev["metabolic"]["value"] > 1.05:
        hints.append("metabolic cost x%.2f" % ev["metabolic"]["value"])
    if "navigation" in ev and ev["navigation"]["value"] > 20:
        hints.append("navigation off by %.0f m" % ev["navigation"]["value"])
    if "pace" in ev and abs(ev["pace"]["value"] - 1) > 0.02:
        hints.append("pace x%.2f for %.0f min" % (ev["pace"]["value"], ev["pace"].get("minutes", 0)))
    nst = sum(1 for e in f["events"] if e["channel"] == "stumble")
    cls = f["class"]
    if nst and cls != "fall":
        hints.append("%d stumble%s" % (nst, "s" if nst > 1 else ""))
    tail = (": " + ", ".join(hints)) if hints else ""
    t_min = f["t"] / 60.0
    if cls == "fall":
        return "Incapacitating fall after %.0f min on a %.0f degree slope%s" % (t_min, f.get("slope_deg", 0), tail)
    if cls == "heat":
        return "Heat limit reached after %.0f min%s" % (t_min, tail)
    if cls == "oxygen":
        return "O2 below the 60-minute reserve%s" % tail
    if cls == "late":
        what = "the expected dose-rate peak" if case.late_basis == "peak" else "the shelter rule"
        return "Not under cover when %s runs out (%.0f min of walking)%s" % (what, t_min, tail) if case.late_basis != "peak" else \
            "Not under cover at %s (%.0f min of walking)%s" % (what, t_min, tail)
    return "No way forward after %.0f min%s" % (t_min, tail)


def unpack_record(case, env, i, max_points=200, rec=None):
    """Trajectory and disturbance events of walker i from a recorded run. Positions in local metres e, s, z."""
    rec = (torch.stack(env.rec, 0) if rec is None else rec)[:, i].numpy()            # [steps, cols]
    steps = int(rec[:, 15].sum())
    rec = rec[:steps]
    core = case.core
    xs = torch.as_tensor(rec[:, 1], device=case.device); ys = torch.as_tensor(rec[:, 2], device=case.device)
    zs = case.T.z_at(xs, ys).cpu().numpy()
    fcode = int(env.fail[i])
    stride = max(1, int(math.ceil(steps / max_points)))
    idx = list(range(0, steps, stride))
    if idx and idx[-1] != steps - 1:
        idx.append(steps - 1)
    traj = []
    for k in idx:
        st = 0
        if k == steps - 1:
            st = C_CODE[fcode] if fcode else 6
        elif rec[k, 10] > 0:
            st = 2
        traj.append([round(float(rec[k, 0]), 1), round(core["e0"] + float(rec[k, 1]), 1), round(core["s0"] + float(rec[k, 2]), 1),
                     round(float(zs[k]), 1), round(float(rec[k, 3]), 1), round(float(rec[k, 4]) / O2_TANK_KG, 4),
                     round(float(rec[k, 5]), 2), int(rec[k, 6]), st])
    z = env.z_setup[i].cpu().numpy().astype(float)
    s = env.sig_scale
    events = [dict(t=0.0, channel="cooling", value=round(max(A.COOL_FLOOR, 1 - A.SIG["cool"] * s * z[1]), 3), log_p=round(-0.5 * z[1] ** 2, 3)),
              dict(t=0.0, channel="metabolic", value=round(math.exp(A.SIG["eff"] * s * z[0]), 3), log_p=round(-0.5 * z[0] ** 2, 3)),
              dict(t=0.0, channel="navigation", value=round(A.SIG["nav"] * s * math.hypot(z[2], z[3]), 1),
                   log_p=round(-0.5 * (z[2] ** 2 + z[3] ** 2), 3))]
    events = [e for e in events if e["log_p"] < -0.005]
    vm = rec[:, 14]
    zv = np.log(np.maximum(vm, 1e-6)) / (A.SIG["pace"] * s)
    on = np.abs(zv) > 1e-3
    if on.any():
        events.append(dict(t=round(float(rec[on, 0][0] - DT), 1), channel="pace", value=round(float(vm[on].mean()), 3),
                           log_p=round(float(-0.5 * (zv[on] ** 2).sum()), 3), minutes=round(float(on.sum() * DT / 60), 1)))
    other = 0.0
    for k in range(steps):
        pf = float(rec[k, 12])
        if rec[k, 10] > 0:
            events.append(dict(t=round(float(rec[k, 0] - DT), 1), channel="stumble", value=1, log_p=round(math.log(max(pf, 1e-12)), 3)))
            if env.falls_terminal:
                pi = float(rec[k, 13])
                if rec[k, 11] > 0:
                    events.append(dict(t=round(float(rec[k, 0] - DT), 1), channel="injury", value=1, log_p=round(math.log(max(pi, 1e-12)), 3)))
                else:
                    other += math.log1p(-pi)
        elif pf > 0:
            other += math.log1p(-min(pf, 1 - 1e-9))
    events.sort(key=lambda e: e["t"])
    cell = case.T.cell_at(torch.as_tensor([float(env.fx[i])], device=case.device), torch.as_tensor([float(env.fy[i])], device=case.device))[0]
    f = dict(**{"class": CLASSES[fcode - 1] if fcode else "none"}, e=round(core["e0"] + float(env.fx[i]), 1),
             s=round(core["s0"] + float(env.fy[i]), 1), x=float(env.fx[i]), y=float(env.fy[i]), t=round(float(env.ft[i]), 1),
             log_p=round(float(env.logp[i]), 3), log_p_no_stumble_steps=round(other, 3),
             slope_deg=round(float(case.T.attr[cell, 2]), 1), heat_end_kj=round(float(env.heat[i]), 1),
             heat_peak_kj=round(float(env.heatPeak[i]), 1), o2_end=round(float(env.o2[i]) / O2_TANK_KG, 4),
             dose_ugy=round(float(env.dose[i]), 1), falls=int(env.falls[i]), events=events, trajectory=traj,
             trajectory_columns=["t_s", "e", "s", "z", "heat_kj", "o2_frac", "dose_ugy", "falls", "status"])
    f["summary"] = describe(case, f)
    return f


def replay(case, r, thetas, nominal, falls_terminal=True, sig_scale=1.0):
    """Recorded replays of scripts thetas [m, D] on route r: list of failure dicts with trajectory and events."""
    th = torch.as_tensor(np.asarray(thetas), device=case.device, dtype=torch.float32)
    rid = torch.full((th.shape[0],), r, device=case.device, dtype=torch.long)
    env, J = evaluate(case, rid, th, falls_terminal, sig_scale, record=True, route_len=route_lengths(case, nominal))
    rec = torch.stack(env.rec, 0)
    return [unpack_record(case, env, i, rec=rec) for i in range(th.shape[0])]


def run_route(case, r, nominal, falls_terminal, seeds, iters, pop, sig_scale=1.0, classes=True, n_restart=3, refine_iters=15):
    specs = [dict(seed=q, adapt=True) for q in seeds] + [dict(seed=q, adapt=False) for q in seeds]
    names = [c for c in CLASSES if not (c == "fall" and not falls_terminal)] if classes else []
    specs += [dict(seed=100 + CLASSES.index(c), adapt=True, only=CLASSES.index(c) + 1) for c in names]
    res = cem_multi(case, r, nominal, specs, falls_terminal, sig_scale, iters, pop)
    ns = len(seeds)
    runs, rs, per_class = res[:ns], res[ns:2 * ns], res[2 * ns:]
    # CEM restarts: local refinement around the most likely distinct failures of each random-search seed
    rspecs, owner = [], []
    for i, q in enumerate(rs):
        for j, cand in enumerate(distinct(q["archive"], n_restart)):
            rspecs.append(dict(seed=1000 + 10 * q["seed"] + j, adapt=True, init=cand["theta"], sd0=0.3)); owner.append(i)
    refined = cem_multi(case, r, nominal, rspecs, falls_terminal, sig_scale, refine_iters, pop) if rspecs else []
    restart = []
    for i, q in enumerate(rs):
        mine = [x for x, o in zip(refined, owner) if o == i]
        base_steps = q["sim_steps"]; best = q["best_log_p"]
        curve = [[row[0], row[1]] for row in q["curve"]]
        for t in range(max([len(x["curve"]) for x in mine], default=0)):
            st = base_steps + sum(x["curve"][min(t, len(x["curve"]) - 1)][0] for x in mine)
            vals = [x["curve"][min(t, len(x["curve"]) - 1)][1] for x in mine] + [best]
            vals = [v for v in vals if v is not None]
            curve.append([int(st), max(vals) if vals else None])
        fin = [v for v in [best] + [x["best_log_p"] for x in mine] if v is not None]
        restart.append(dict(seed=q["seed"], best_log_p=max(fin) if fin else None,
                            sim_steps=int(base_steps + sum(x["sim_steps"] for x in mine)), curve=curve))
    arch = [a for q in runs + rs + per_class + refined for a in q["archive"]]
    top = distinct(arch, 3)
    failures = replay(case, r, [t["theta"] for t in top], nominal, falls_terminal, sig_scale) if top else []
    failures = [f for f in failures if f["class"] != "none"]
    best = max([a["log_p"] for a in arch], default=None)
    table = {}
    for cname, q in zip(names, per_class):
        b_ = max([a["log_p"] for a in arch if a["class"] == cname], default=None)
        table[cname] = dict(best_log_p=b_, robustness_nats=None if b_ is None else -b_, sim_steps=q["sim_steps"])
    if table:
        print("    most likely failure per class (nats): %s" % {k: (None if v["robustness_nats"] is None else round(v["robustness_nats"], 1))
                                                                  for k, v in table.items()}, flush=True)
    # samples around the best failures: heatmap points and 32 rollouts
    pts, rollouts = [], []
    if top:
        dev = case.device
        gen = torch.Generator(device=dev); gen.manual_seed(31337 + r)
        base = torch.as_tensor(np.stack([t["theta"] for t in top]), device=dev, dtype=torch.float32)
        m = 4096
        pick = torch.randint(0, base.shape[0], (m,), generator=gen, device=dev)
        pick[:32] = 0
        th = base[pick] + 0.35 * torch.randn((m, base.shape[1]), generator=gen, device=dev)
        rid = torch.full((m,), r, device=dev, dtype=torch.long)
        env, J = evaluate(case, rid, th, falls_terminal, sig_scale, route_len=route_lengths(case, nominal))
        fm = env.fail > 0
        pts = torch.stack([env.fail.double(), env.fx.double(), env.fy.double(), env.ft.double(), env.logp], 1)[fm].cpu().numpy()
        pts = np.concatenate([pts, np.array([[CLASSES.index(a["class"]) + 1, a["x"], a["y"], a["t"], a["log_p"]] for a in arch])], 0)
        rollouts = replay(case, r, th[:32].cpu().numpy(), nominal, falls_terminal, sig_scale)
        for q in rollouts:
            q.pop("trajectory_columns", None)
    strip = lambda L: [dict(seed=q["seed"], best_log_p=q["best_log_p"], sim_steps=q["sim_steps"], curve=q["curve"]) for q in L]
    return dict(route=case.routes[r]["id"], shelter=case.routes[r]["shelter"], best_log_p=best,
                robustness_nats=None if best is None else -best, failures=failures, class_table=table,
                cem=strip(runs), random_search=strip(rs), cem_restart=restart,
                best_thetas=[t["theta"].tolist() for t in top], K=runs[0]["K"], rollouts=rollouts), pts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", default="S1")
    ap.add_argument("--iters", type=int, default=30)
    ap.add_argument("--pop", type=int, default=2048)
    ap.add_argument("--seeds", type=int, nargs="+", default=[0, 1, 2])
    ap.add_argument("--penalty", action="store_true")
    ap.add_argument("--both", action="store_true")
    ap.add_argument("--sig-scale", type=float, default=1.0)
    ap.add_argument("--no-classes", action="store_true")
    ap.add_argument("--refine-iters", type=int, default=15)
    ap.add_argument("--tag", default="")
    args = ap.parse_args()
    device = torch.device("cuda")
    case = Case(args.scenario, device)
    os.makedirs(RUNS, exist_ok=True)
    for terminal in ([True, False] if args.both else [not args.penalty]):
        nominal = A.nominal_runs(case, terminal)
        print("CEM %s, %s: pop %d, %d iterations, seeds %s, sigma scale %.2f" % (
            args.scenario, cfg_name(terminal), args.pop, args.iters, args.seeds, args.sig_scale), flush=True)
        routes, pts = [], {}
        for r in range(case.R):
            nom = {k: v for k, v in nominal[r].items() if k != "track"}
            if not A.feasible(nominal[r]):
                print("  %s: infeasible without any disturbance (%s), not scored" % (case.route_name(r), nominal[r]["failure"]), flush=True)
                routes.append(dict(route=case.routes[r]["id"], shelter=case.routes[r]["shelter"], infeasible=True, nominal=nom,
                                   best_log_p=None, robustness_nats=None))
                continue
            res, p = run_route(case, r, nominal, terminal, args.seeds, args.iters, args.pop, args.sig_scale, classes=not args.no_classes,
                               refine_iters=args.refine_iters)
            res["nominal"] = nom
            routes.append(res); pts["r%d" % r] = p
            print("  => %s: robustness %.2f nats; top failures: %s" % (
                case.route_name(r), res["robustness_nats"] if res["robustness_nats"] is not None else float("nan"),
                " | ".join("%s %.1f (%s)" % (f["class"], f["log_p"], f["summary"]) for f in res["failures"])), flush=True)
        name = "cem_%s_%s%s" % (args.scenario, cfg_name(terminal), args.tag)
        with open(os.path.join(RUNS, name + ".json"), "w") as f:
            json.dump(dict(scenario=args.scenario, config=cfg_name(terminal), sig_scale=args.sig_scale, pop=args.pop, iters=args.iters,
                           seeds=args.seeds, refine_iters=args.refine_iters, R_E=R_E, routes=routes, failure_definitions=A.FAILURE_DEFS, assumptions=A.ASSUMPTIONS),
                      f, default=float)
        np.savez_compressed(os.path.join(RUNS, name + ".npz"), **pts)


if __name__ == "__main__":
    main()
