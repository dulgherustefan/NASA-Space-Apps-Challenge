"""Evaluate a trained policy against the scripted baseline on the SAME sampled scenarios.

    python rl/evaluate.py --run run1 [--ckpt rl/runs/run1/latest.pt] [--n 32768]

 (a) RL sampled   (b) RL greedy (argmax)   (c) scripted baseline (baselineAction in sim.ts)
All three see identical episodes (same scenario draw, same walker traits, same fall randoms), one episode
per walker, no auto-reset. Also evaluates the two concrete demo situations of the app.
Writes rl/runs/<run>/eval.json (export_policy.py turns it into app/public/policy/rl_report.json).
"""
import argparse, json, os, sys, time
import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import env as E
import planner as P
from terrain import ROOT
from train_ppo import Policy, sample_actions

MAX_STEPS = int(E.T_MAX / E.DT) + 2


def load_policy(path, dev):
    ck = torch.load(path, map_location=dev, weights_only=False)
    pi = Policy(tuple(ck["hidden"])).to(dev)
    pi.load_state_dict(ck["pi"])
    pi.eval()
    return pi, ck


def policy_fns(pi, dev, seed=123):
    gen = torch.Generator(device=dev); gen.manual_seed(seed)

    def sampled(obs):
        with torch.no_grad():
            h, p, _ = sample_actions(pi(obs), gen)
        return h, p

    def greedy(obs):
        with torch.no_grad():
            lg = pi(obs)
        return lg[:, :5].argmax(-1), lg[:, 5:].argmax(-1)
    return {"rl_sample": sampled, "rl_greedy": greedy, "baseline": E.baseline_action}


def run_episodes(env, fn):
    """One episode per walker (finished walkers are frozen). Returns the pace histogram of the decisions taken."""
    pace_hist = torch.zeros(5, device=env.device, dtype=torch.float64)
    head_hist = torch.zeros(5, device=env.device, dtype=torch.float64)
    for s in range(MAX_STEPS):
        active = env.status == E.WALKING
        if s % 16 == 0 and not bool(active.any()):
            break
        obs = env.observe()
        h, p = fn(obs)
        u = torch.rand((3, env.n), generator=env.gen, device=env.device, dtype=env.dtype)
        moving = active & (env.fallTimer <= 0) & (env.t >= env.react)
        pace_hist += torch.bincount(p[moving], minlength=5).double()
        head_hist += torch.bincount(h[moving], minlength=5).double()
        env.step_dynamics(h, p, u[0], u[1], u[2], active=active)
    return (pace_hist / pace_hist.sum().clamp_min(1)).cpu().numpy(), (head_hist / head_hist.sum().clamp_min(1)).cpu().numpy()


def metrics(env, mask=None):
    st = env.status.cpu().numpy()
    t = env.t.cpu().numpy(); dose = env.dose.cpu().numpy(); falls = env.falls.cpu().numpy()
    sep = (env.sep_el >= 0).cpu().numpy(); dl = env.deadline.cpu().numpy()
    band = env.bandSec.cpu().numpy(); act = env.band_active.cpu().numpy(); hp = env.heatPeak.cpu().numpy()
    o2 = env.o2.cpu().numpy()
    if mask is None: mask = np.ones_like(st, bool)
    m = mask
    n = max(int(m.sum()), 1)
    arr = (st == E.ARRIVED) & m
    pct = lambda x: round(100.0 * float(x), 3)
    o2_min = o2 / (E.O2_NOMINAL_W * E.O2_KG_PER_J) / 60
    out = dict(
        episodes=int(m.sum()),
        arrive_pct=pct(arr.sum() / n),
        in_rule_pct_sep=pct(((arr & sep & (t <= dl)).sum()) / max(int((sep & m).sum()), 1)),
        incap_fall_pct=pct(((st == E.INCAPACITATED) & m).sum() / n),
        heat_casualty_pct=pct(((st == E.HEAT) & m).sum() / n),
        o2_out_pct=pct(((st == E.O2OUT) & m).sum() / n),
        timeout_pct=pct(((st == E.TIMEOUT) & m).sum() / n),
        stuck_pct=pct(((st == E.STUCK) & m).sum() / n),
        median_time_min=round(float(np.median(t[arr]) / 60), 2) if arr.any() else None,
        mean_time_min=round(float(t[arr].mean() / 60), 2) if arr.any() else None,
        mean_dose_uGy=round(float(dose[m].mean()), 2),
        mean_dose_sep_uGy=round(float(dose[m & sep].mean()), 2) if (m & sep).any() else None,
        mean_falls=round(float(falls[m].mean()), 4),
        heat_peak_mean_kJ=round(float(hp[m].mean()), 1),
        heat_impaired_pct=pct((hp[m] >= env.p["heatWarnKJ"]).mean()),
        band_min_active=round(float(band[m & act].mean() / 60), 3) if (m & act).any() else None,
        low_o2_reserve_pct_of_arrivals=pct((o2_min[arr] < env.p["o2ReserveMin"]).mean()) if arr.any() else None,
    )
    return out


def eval_distribution(T, bank, fns, n, seed, label="training distribution"):
    res = {}; per = {}
    for name, fn in fns.items():
        env = E.WalkEnv(T, bank, n, seed=seed, auto_reset=False)
        env.reset()
        plan = (env.plan_time0 / 60).cpu().numpy()
        t0 = time.time()
        pace, head = run_episodes(env, fn)
        r = metrics(env)
        r["pace_share"] = [round(float(x), 4) for x in pace]; r["heading_share"] = [round(float(x), 4) for x in head]
        r["by_plan_time"] = {}
        for lo, hi in ((3, 20), (20, 40), (40, 90.01)):
            mk = (plan >= lo) & (plan < hi)
            b = metrics(env, mk)
            r["by_plan_time"]["%d-%d min" % (lo, int(hi))] = {k: b[k] for k in ("episodes", "arrive_pct", "in_rule_pct_sep", "incap_fall_pct", "heat_casualty_pct", "stuck_pct", "median_time_min", "mean_falls")}
        res[name] = r
        per[name] = dict(status=env.status.cpu().numpy(), t=env.t.cpu().numpy())
        print("[%s] %-10s %.0fs  arrive %.2f%%  in-rule(SEP) %.2f%%  incap %.2f%%  heat %.2f%%  stuck %.2f%%  timeout %.2f%%  t50 %s min  dose %.1f  falls %.3f  pace %s"
              % (label, name, time.time() - t0, r["arrive_pct"], r["in_rule_pct_sep"], r["incap_fall_pct"], r["heat_casualty_pct"], r["stuck_pct"], r["timeout_pct"],
                 r["median_time_min"], r["mean_dose_uGy"], r["mean_falls"], r["pace_share"]), flush=True)
    # paired comparison (same episodes): time ratio where both arrived
    paired = {}
    b = per["baseline"]
    for name in fns:
        if name == "baseline": continue
        a = per[name]
        both = (a["status"] == E.ARRIVED) & (b["status"] == E.ARRIVED)
        paired[name] = dict(both_arrived_pct=round(100.0 * float(both.mean()), 2),
                            median_time_ratio_vs_baseline=round(float(np.median(a["t"][both] / b["t"][both])), 4),
                            rl_arrived_baseline_not_pct=round(100.0 * float(((a["status"] == E.ARRIVED) & (b["status"] != E.ARRIVED)).mean()), 3),
                            baseline_arrived_rl_not_pct=round(100.0 * float(((a["status"] != E.ARRIVED) & (b["status"] == E.ARRIVED)).mean()), 3))
    return dict(label=label, n=n, seed=seed, policies=res, paired=paired)


DEMO = [
    dict(name="storm_standing", desc="solar storm, T+60 s; rockfall band standing (alpha 27.8); start (2800,1500)",
         sx=2800.0, sy=1500.0, active=False, alpha=27.8, sep=60.0),
    dict(name="quake_active", desc="marsquake hold: band ACTIVE (alpha 27.8); solar storm T+15 min; start (2598,1858)",
         sx=2598.0, sy=1858.0, active=True, alpha=27.8, sep=900.0),
]


def eval_demo(T, g, blocked, fns, n, seed):
    """The two demo situations x four destinations, all routes in one batch (n walkers per route)."""
    dev = T.device
    specs = [(x, y, sc["active"], sc["alpha"]) for sc in DEMO for (_, x, y) in E.DEMO_GOALS]
    fields = E.plan_many(g, blocked, specs)
    bank = E.FieldBank(fields, [(s[0], s[1]) for s in specs], [s[2] for s in specs], [s[3] for s in specs], dev, g["n"])
    R = len(specs)
    rid = torch.arange(R, device=dev).repeat_interleave(n)
    sx = torch.tensor([sc["sx"] for sc in DEMO for _ in E.DEMO_GOALS], device=dev, dtype=torch.float64)[rid]
    sy = torch.tensor([sc["sy"] for sc in DEMO for _ in E.DEMO_GOALS], device=dev, dtype=torch.float64)[rid]
    sep = torch.tensor([sc["sep"] for sc in DEMO for _ in E.DEMO_GOALS], device=dev, dtype=torch.float64)[rid]
    rid_np = rid.cpu().numpy()
    out = []
    k = 0
    for sc in DEMO:
        for (dn, gx, gy) in E.DEMO_GOALS:
            plan_min = float(fields[k]["time"][P.cell_of(g["n"], sc["sx"], sc["sy"])]) / 60
            out.append(dict(scenario=sc["name"], desc=sc["desc"], dest=dn, goal=[gx, gy], plan_min=round(plan_min, 2), n=n, policies={}))
            k += 1
    for name, fn in fns.items():
        env = E.WalkEnv(T, bank, R * n, seed=seed, auto_reset=False)
        env.set_route(rid, dict(x=sx, y=sy, heat=60.0, o2=0.45, dose=30.0), sep, env.p["shelterRuleMin"] * 60.0, dust=0.0, terr_err=0.25)
        run_episodes(env, fn)
        for k, row in enumerate(out):
            r = metrics(env, rid_np == k)
            row["policies"][name] = r
            print("[demo %s -> %s, plan %.1f min] %-10s arrive %.2f%%  in-rule %.2f%%  incap %.2f%%  heat %.2f%%  stuck %.2f%%  t50 %s min  dose %.0f  falls %.3f  band %s min"
                  % (row["scenario"], row["dest"], row["plan_min"], name, r["arrive_pct"], r["in_rule_pct_sep"], r["incap_fall_pct"], r["heat_casualty_pct"], r["stuck_pct"],
                     r["median_time_min"], r["mean_dose_uGy"], r["mean_falls"], r["band_min_active"]), flush=True)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="run1")
    ap.add_argument("--ckpt", default="")
    ap.add_argument("--n", type=int, default=32768)
    ap.add_argument("--n_demo", type=int, default=20000)
    ap.add_argument("--seed", type=int, default=20261114)
    ap.add_argument("--heldout", type=int, default=1)
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    dev = torch.device("cuda")
    run_dir = os.path.join(ROOT, "rl", "runs", a.run)
    ckpt = a.ckpt or os.path.join(run_dir, "latest.pt")
    pi, ck = load_policy(ckpt, dev)
    cfg = ck["cfg"]
    g, blocked, T = E.make_world(dev, torch.float64)
    t0 = time.time()
    res = dict(checkpoint=os.path.relpath(ckpt, ROOT).replace("\\", "/"), update=ck["update"], env_steps=ck["env_steps"], train_wall_s=ck["wall_s"],
               date=time.strftime("%Y-%m-%d %H:%M"), state_dtype="float64")
    fns = policy_fns(pi, dev)
    bank, goals = E.build_bank(g, blocked, dev, n_random=cfg.get("n_random_goals", 24))
    res["sampled"] = eval_distribution(T, bank, fns, a.n, a.seed, "training distribution")
    res["sampled"]["note"] = ("scenario distribution of training (same %d goals x 6 hazard states, new random draw): start with planned time 3-90 min "
                              "(uniform in time), storm p=0.6, dust p=0.2, random physiology, fallPerKm x U(0.6,1.6), coolW x U(0.85,1.1)" % len(goals))
    del bank; torch.cuda.empty_cache()
    if a.heldout:
        # goals never used in training: other random walkable cells (different seed), same hazard states
        hg = [x for x in E.choose_goals(g, blocked, n_random=16, seed=987654) if x[0].startswith("W")]
        tr = [(x, y) for _, x, y in goals]
        hg = [x for x in hg if min(abs(x[1] - u) + abs(x[2] - v) for u, v in tr) > 60]
        hbank, _ = E.build_bank(g, blocked, dev, goals=hg, seed=4321)
        res["heldout_goals"] = eval_distribution(T, hbank, fns, a.n, a.seed + 1, "held-out goals")
        res["heldout_goals"]["note"] = "%d random walkable goals NOT used in training, same hazard states and scenario distribution" % len(hg)
        res["heldout_goals"]["goals"] = [[round(x[1]), round(x[2])] for x in hg]
        del hbank; torch.cuda.empty_cache()
    res["demo"] = eval_demo(T, g, blocked, fns, a.n_demo, a.seed + 2)
    res["eval_wall_s"] = round(time.time() - t0, 1)
    out = a.out or os.path.join(run_dir, "eval.json")
    json.dump(res, open(out, "w"), indent=1)
    print("wrote", out, "(%.0f s)" % (time.time() - t0))


if __name__ == "__main__":
    main()
