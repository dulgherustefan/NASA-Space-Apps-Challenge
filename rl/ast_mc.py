"""Plain Monte Carlo on the candidate routes (nominal disturbances, no adversary) and the smoke test of the hooks.

  python rl/ast_mc.py --scenario S1 --smoke                 U2 section 9.8, five checks
  python rl/ast_mc.py --scenario S1 --n 200000              failure rate with Wilson interval per route

Writes rl/runs/ast/mc_<scenario>_<config>.json (+ .npz with the failure points for the heatmaps).
"""
import argparse
import json
import math
import os
import time

import numpy as np
import torch

import env as E
from env import WalkEnv, baseline_action, make_world, build_bank, DEMO_GOALS, DT
import ast_env as A
from ast_env import ASTEnv, Case, CLASSES, BIG, RUNS, wilson

EZ2 = 0.99113       # E[min(z, 3)^2] for z ~ N(0, 1) clipped to +/-3  (1 - 2 * int_3^inf (z^2 - 9) phi(z) dz)


def cfg_name(falls_terminal):
    return "falls_terminal" if falls_terminal else "falls_penalty"


def mc_route(case, r, n, batch=16384, seed=0, falls_terminal=True, sig_scale=1.0, keep=4096, verbose=True):
    """n nominal rollouts on route index r. Returns a result dict (curve = best failure log-likelihood vs sim steps)."""
    dev = case.device
    gen = torch.Generator(device=dev); gen.manual_seed(1000003 * (seed + 1) + 7919 * r)
    counts = np.zeros(6, np.int64)
    done_n, steps = 0, 0
    best, best_ev = -math.inf, -math.inf
    curve = []
    pts = []            # failure points: class, x, y, t, log p (all channels), log p (without pace drift)
    lp_all = []
    t0 = time.time()
    b = 0
    while done_n < n:
        m = min(batch, n - done_n)
        env = ASTEnv(case, m, seed=seed * 7919 + 31 * r + b, falls_terminal=falls_terminal, sig_scale=sig_scale, mode="mc")
        env.reset_routes(r)
        env.setup(torch.randn((m, 4), generator=gen, device=dev))
        lp_pace = torch.zeros(m, device=dev, dtype=torch.float64)
        k = 0
        while not bool(env.done.all()) and k < 2200:
            zv = torch.randn(m, generator=gen, device=dev).clamp(-A.Z_CLIP, A.Z_CLIP)
            act = ~env.done
            env.ast_step(zv)
            lp_pace += torch.where(act, -0.5 * zv.double() ** 2, torch.zeros_like(lp_pace))
            k += 1
        f = env.fail.cpu().numpy()
        counts += np.bincount(f, minlength=6)
        lp = env.logp.cpu().numpy(); lpe = (env.logp - lp_pace).cpu().numpy()
        lp_all.append(lp[:512])
        fm = f > 0
        if fm.any():
            best = max(best, float(lp[fm].max())); best_ev = max(best_ev, float(lpe[fm].max()))
            P_ = np.stack([f[fm], env.fx.cpu().numpy()[fm], env.fy.cpu().numpy()[fm], env.ft.cpu().numpy()[fm], lp[fm], lpe[fm]], 1)
            pts.append(P_)
        done_n += m; steps += env.steps_done; b += 1
        curve.append([steps, best if math.isfinite(best) else None, best_ev if math.isfinite(best_ev) else None, int(counts[1:].sum())])
    pts = np.concatenate(pts, 0) if pts else np.zeros((0, 6))
    kf = int(counts[1:].sum())
    order = np.argsort(-pts[:, 5]) if len(pts) else np.zeros(0, int)
    res = dict(route=case.routes[r]["id"], shelter=case.routes[r]["shelter"], n=int(done_n), failures=kf, fail_rate=kf / done_n,
               ci=wilson(kf, done_n), classes={c: int(counts[i + 1]) for i, c in enumerate(CLASSES)},
               best_log_p=best if math.isfinite(best) else None, best_log_p_events=best_ev if math.isfinite(best_ev) else None,
               sim_steps=int(steps), seconds=time.time() - t0, curve=curve, seed=seed,
               mean_log_p=float(np.concatenate(lp_all).mean()),
               top=[dict(**{"class": CLASSES[int(p[0]) - 1]}, x=float(p[1]), y=float(p[2]), t=float(p[3]), log_p=float(p[4]),
                         log_p_events=float(p[5])) for p in pts[order[:32]]])
    if verbose:
        print("  MC %s: n=%d fail %.4f%% CI [%.4f, %.4f]%% classes %s best log p %s (events only %s) %.1fM steps %.0f s" % (
            case.route_name(r), done_n, 100 * res["fail_rate"], 100 * res["ci"][0], 100 * res["ci"][1],
            {c: v for c, v in res["classes"].items() if v}, "%.1f" % best if math.isfinite(best) else "none",
            "%.1f" % best_ev if math.isfinite(best_ev) else "none", steps / 1e6, res["seconds"]), flush=True)
    keep_idx = order[:keep] if len(order) > keep else order
    return res, pts[keep_idx] if len(pts) else pts


# ---------------------------------------------------------------------------------------------- smoke test
class _Bare:
    """Stand-in case for the parity run on the v1 training bank."""
    deadline = math.inf
    pk = 2
    R = 0
    rescue = False


def smoke(case, device):
    out = dict(checks={})
    print("== 1. throughput (hooks on, plain Monte Carlo, 8192 walkers) ==", flush=True)
    res, _ = mc_route(case, 0, 8192, batch=8192, verbose=False)           # warm-up
    torch.cuda.synchronize() if device.type == "cuda" else None
    t0 = time.time()
    steps = 0
    for r in range(case.R):
        res, _ = mc_route(case, r, 32768, batch=32768, seed=1, verbose=False)
        steps += res["sim_steps"]
    torch.cuda.synchronize() if device.type == "cuda" else None
    sps = steps / (time.time() - t0)
    out["checks"]["throughput"] = dict(steps_per_s=sps, sim_steps=steps, ok=sps >= 100e3, floor_ok=sps >= 50e3)
    print("   %.0f sim steps/s over %.1fM steps (gate 100k, floor 50k)" % (sps, steps / 1e6), flush=True)

    print("== 2. nominal parity ==", flush=True)
    g, blocked, T = case.g, case.blocked, case.T
    bank, _ = build_bank(g, blocked, device, verbose=False)
    bare = _Bare(); bare.T = T; bare.bank = bank
    n = 8192
    ref = WalkEnv(T, bank, n, seed=11)
    hooked = ASTEnv(bare, n, seed=11)
    hooked.auto_reset = True
    names = [k for k, v in vars(ref).items() if torch.is_tensor(v) and k in vars(hooked) and k not in ("acc",)]
    gen = torch.Generator(device=device); gen.manual_seed(5)
    worst = 0.0
    for k in range(150):
        for nm in names:
            setattr(hooked, nm, getattr(ref, nm).clone())
        o = ref.observe(); oh = hooked.observe()
        worst = max(worst, float((o - oh).abs().max()))
        hk, pk = baseline_action(o)
        u = torch.rand((3, n), generator=gen, device=device)
        ref.step_dynamics(hk, pk, u[0], u[1], u[2]); hooked.step_dynamics(hk, pk, u[0], u[1], u[2])
        for nm in ("x", "y", "heat", "o2", "dose", "fallTimer", "dist"):
            worst = max(worst, float((getattr(ref, nm) - getattr(hooked, nm)).abs().max()))
        worst = max(worst, float((ref.status != hooked.status).sum()), float((ref.falls != hooked.falls).sum()))
        ref.reset(ref.status != E.WALKING)
    # the v1 scripted-baseline statistics, run through the hooked step
    env = ASTEnv(bare, 16384, seed=3)
    env.auto_reset = True
    env.reset()
    eps = 0
    while eps < 32768:
        hk, pk = baseline_action(env.observe())
        env.step(hk, pk)
        eps = float(env.acc[0])
    st = env.pop_stats()
    refv = dict(arrive=0.90393, stuck=0.08868, incap=0.00708)
    dv = {k: abs(st[k] - v) for k, v in refv.items()}
    nom = A.nominal_runs(case)
    arrive_phys = sum(1 for q in nom if q["failure"] in (None, "late"))
    n_ok = sum(1 for q in nom if A.feasible(q))
    out["checks"]["parity"] = dict(max_abs_state_diff=worst, baseline=dict(arrive=st["arrive"], stuck=st["stuck"], incap=st["incap"],
                                   episodes=st["episodes"]), reference=refv, max_diff_pp=100 * max(dv.values()),
                                   nominal_arrive_routes=arrive_phys, nominal_with_reserve_routes=n_ok, routes=case.R,
                                   ok=(worst == 0.0 and max(dv.values()) < 0.015))
    print("   hooked step vs WalkEnv.step_dynamics, 150 steps x %d walkers: max |diff| = %g" % (n, worst))
    print("   scripted baseline through the hooked step: arrive %.2f%% stuck %.2f%% incap %.2f%% (v1: 90.39 / 8.87 / 0.71), %d episodes" % (
        100 * st["arrive"], 100 * st["stuck"], 100 * st["incap"], st["episodes"]))
    for q in nom:
        print("   nominal %s: %s in %.1f min, slack %s, heat peak %.0f kJ, O2 %.0f min" % (
            case.route_name(nom.index(q)), "arrives" if q["arrived"] else "FAILS (%s)" % q["failure"], q["time_s"] / 60,
            "%.1f min" % (q["slack_s"] / 60) if q["slack_s"] is not None else "n/a", q["heat_peak_kj"], q["o2_reserve_min"]), flush=True)

    print("== 3. hook sanity ==", flush=True)
    m = 512
    # forced stumble + injury at the step with the largest fall probability of the undisturbed walk
    env = ASTEnv(case, case.R, mode="adv", record=True)
    env.reset_routes(torch.arange(case.R, device=device))
    neg = torch.full((case.R,), -BIG, device=device)
    A.run_episode(env, lambda e, o, k: (None, neg, neg))
    rec = torch.stack(env.rec, 0)                       # [steps, R, cols]
    k_star = rec[:, :, 12].argmax(0)                    # step of max pFall per route
    env = ASTEnv(case, m * case.R, mode="adv")
    rid = torch.arange(case.R, device=device).repeat_interleave(m)
    env.reset_routes(rid)
    ks = k_star.to(device)[rid]
    pos = torch.full((m * case.R,), BIG, device=device); negm = -pos
    A.run_episode(env, lambda e, o, k: (None, torch.where(ks == k, pos, negm), torch.where(ks == k, pos, negm)))
    incap = float((env.fail == A.F_FALL).float().mean())
    pf = rec[:, :, 12].double()
    quiet = torch.where(pf > 0, torch.log1p(-pf.clamp(max=1 - 1e-9)), torch.zeros_like(pf))      # steps without a stumble
    before = torch.stack([quiet[:int(k_star[r]), r].sum() for r in range(case.R)])
    exp_lp = (torch.log(rec[k_star, torch.arange(case.R), 12]) + torch.log(rec[k_star, torch.arange(case.R), 13]) + before).numpy()
    got_lp = env.logp.view(case.R, m)[:, 0].cpu().numpy()
    # degraded suit: cooling at the floor and metabolic cost at +3 sigma
    env2 = ASTEnv(case, case.R, mode="adv")
    env2.reset_routes(torch.arange(case.R, device=device))
    z = torch.zeros((case.R, 4), device=device); z[:, 0] = 3; z[:, 1] = 3
    env2.setup(z)
    A.run_episode(env2, lambda e, o, k: (None, neg, neg))
    peak_nom = [q["heat_peak_kj"] for q in nom]
    peak_deg = env2.heatPeak.cpu().numpy().tolist()
    out["checks"]["hooks"] = dict(forced_incap_rate=incap, heat_peak_nominal_kj=peak_nom, heat_peak_degraded_kj=peak_deg,
                                  ok=(incap == 1.0 and all(d > q for d, q in zip(peak_deg, peak_nom))))
    print("   forced stumble + injury at the highest-risk step: incapacitated %.1f%%" % (100 * incap))
    print("   peak heat kJ nominal %s -> cooling 0.65, metabolic x1.43 %s" % (
        ["%.0f" % v for v in peak_nom], ["%.0f" % v for v in peak_deg]), flush=True)

    print("== 4. reachability ==", flush=True)
    rates = []
    for terminal in (True, False):
        env = ASTEnv(case, m * case.R, mode="adv", falls_terminal=terminal)
        env.reset_routes(rid)
        z = torch.full((m * case.R, 4), 3.0, device=device)
        env.setup(z)
        zv = torch.full((m * case.R,), -3.0, device=device)
        A.run_episode(env, lambda e, o, k: (zv, pos, None))
        rates.append((env.fail > 0).float().view(case.R, m).mean(1).cpu().numpy().tolist())
    out["checks"]["reachability"] = dict(fail_rate_falls_terminal=rates[0], fail_rate_falls_penalty=rates[1],
                                         ok=sum(1 for v in rates[1] if v >= 0.5) >= min(3, case.R))
    print("   all channels at 3 sigma + forced stumbles: failure rate per route %s (falls terminal), %s (falls as a penalty)" % (
        ["%.2f" % v for v in rates[0]], ["%.2f" % v for v in rates[1]]), flush=True)

    print("== 5. likelihood bookkeeping ==", flush=True)
    mm = 32768
    env = ASTEnv(case, mm, seed=77, mode="mc")
    env.reset_routes(0)
    gen = torch.Generator(device=device); gen.manual_seed(99)
    gauss = env.setup(torch.randn((mm, 4), generator=gen, device=device)).clone()
    bern = torch.zeros(mm, device=device, dtype=torch.float64); bern_exp = torch.zeros_like(bern)
    nsteps = 0
    while not bool(env.done.all()):
        zv = torch.randn(mm, generator=gen, device=device).clamp(-A.Z_CLIP, A.Z_CLIP)
        act = ~env.done
        env.ast_step(zv)
        gauss += torch.where(act, -0.5 * zv.double() ** 2, torch.zeros_like(gauss))
        bern += env.s_lp
        pF = env.s_pFall.double().clamp(1e-12, 1 - 1e-9); pI = env.s_pInj.double().clamp(1e-12, 1 - 1e-9)
        h = pF * pF.log() + (1 - pF) * torch.log1p(-pF) + pF * (pI * pI.log() + (1 - pI) * torch.log1p(-pI))
        bern_exp += torch.where(env.s_can, h, torch.zeros_like(h))
        nsteps += int(act.sum())
    mean_steps = nsteps / mm
    expect = -0.5 * EZ2 * (4 + mean_steps)
    res = dict(mean_log_p=float(env.logp.mean()), gauss=float(gauss.mean()), bern=float(bern.mean()), bern_exp=float(bern_exp.mean()))
    nomlp = [q["log_p"] for q in nom]
    err_forced = float(np.abs(got_lp - exp_lp).max())
    out["checks"]["likelihood"] = dict(mc_mean_log_p=res["mean_log_p"], expected_gaussian_part=expect, mean_steps=mean_steps,
                                       undisturbed_log_p=nomlp, forced_stumble_log_p=got_lp.tolist(),
                                       forced_stumble_expected=exp_lp.tolist(), forced_err=err_forced,
                                       gaussian_part=res["gauss"], bernoulli_part=res["bern"], bernoulli_expected=res["bern_exp"],
                                       ok=(abs(res["gauss"] - expect) < 0.01 * abs(expect) and abs(res["bern"] - res["bern_exp"]) < 0.1
                                           and err_forced < 0.1))
    print("   MC mean log p %.2f = Gaussian part %.2f (expected %.2f for %.1f steps) + stumble part %.3f (expected %.3f)" % (
        res["mean_log_p"], res["gauss"], expect, mean_steps, res["bern"], res["bern_exp"]))
    print("   undisturbed walk (stumbles suppressed) log p %s" % ["%.3f" % v for v in nomlp])
    print("   forced stumble + injury: log p %s, expected (log pFall + log pInj + no-stumble steps before) %s (max error %.3f)" % (
        ["%.2f" % v for v in got_lp], ["%.2f" % v for v in exp_lp], err_forced), flush=True)
    out["passed"] = {k: bool(v["ok"]) for k, v in out["checks"].items()}
    print("smoke test:", out["passed"], flush=True)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", default="S1")
    ap.add_argument("--n", type=int, default=200000)
    ap.add_argument("--batch", type=int, default=32768)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--penalty", action="store_true", help="falls are a time-and-energy penalty, not terminal")
    ap.add_argument("--both", action="store_true", help="run both fall configurations")
    ap.add_argument("--sig-scale", type=float, default=1.0)
    ap.add_argument("--tag", default="")
    args = ap.parse_args()
    device = torch.device("cuda")
    torch.backends.cuda.matmul.allow_tf32 = True
    print("device", torch.cuda.get_device_name(0), flush=True)
    case = Case(args.scenario, device)
    os.makedirs(RUNS, exist_ok=True)
    if args.smoke:
        out = smoke(case, device)
        with open(os.path.join(RUNS, "smoke_%s.json" % args.scenario), "w") as f:
            json.dump(out, f, indent=1, default=float)
        return
    for terminal in ([True, False] if args.both else [not args.penalty]):
        print("Monte Carlo %s, %s, n=%d per route" % (args.scenario, cfg_name(terminal), args.n), flush=True)
        routes, pts = [], {}
        for r in range(case.R):
            res, p = mc_route(case, r, args.n, batch=args.batch, seed=args.seed, falls_terminal=terminal, sig_scale=args.sig_scale)
            routes.append(res); pts["r%d" % r] = p
        name = "mc_%s_%s%s" % (args.scenario, cfg_name(terminal), args.tag)
        with open(os.path.join(RUNS, name + ".json"), "w") as f:
            json.dump(dict(scenario=args.scenario, config=cfg_name(terminal), sig_scale=args.sig_scale, seed=args.seed, routes=routes,
                           failure_definitions=A.FAILURE_DEFS, assumptions=A.ASSUMPTIONS), f, default=float)
        np.savez_compressed(os.path.join(RUNS, name + ".npz"), **pts)


if __name__ == "__main__":
    main()
