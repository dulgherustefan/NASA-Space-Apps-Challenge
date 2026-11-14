"""Export the trained policy for the browser and write the public report.

    python rl/export_policy.py --run run1 [--mode sample|greedy] [--summary "..."]

 app/public/policy/policy.json        tanh MLP, W row-major [nout x nin]; logits 0-4 heading, 5-9 pace
 app/public/policy/rl_report.json     training config, env steps, wall-clock, evaluation tables, honest summary
 app/public/policy/learning_curve.png
Needs rl/runs/<run>/eval.json (python rl/evaluate.py --run <run>). If rl/runs/node_verify.json exists
(cd app && npx tsx scripts/parity_dump.ts verify) the Node-side numbers are merged into the report.
"""
import argparse, csv, json, os, sys, time
import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from terrain import ROOT

POL_DIR = os.path.join(ROOT, "app", "public", "policy")


def read_log(run_dir):
    rows = []
    with open(os.path.join(run_dir, "log.csv"), newline="") as f:
        for r in csv.DictReader(f):
            rows.append({k: float(v) for k, v in r.items()})
    return rows


def learning_curve(rows, path, title):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.style.use("dark_background")
    x = np.array([r["env_steps"] for r in rows]) / 1e6
    col = lambda k: np.array([r[k] for r in rows])
    sm = lambda v, w=7: np.convolve(np.pad(v, (w // 2, w // 2), mode="edge"), np.ones(w) / w, mode="valid")
    fig, ax = plt.subplots(2, 2, figsize=(11, 6.6), dpi=130)
    fig.patch.set_facecolor("#0b0e14")
    for a in ax.ravel():
        a.set_facecolor("#0b0e14"); a.grid(alpha=0.18); a.tick_params(labelsize=9)
        for s in a.spines.values(): s.set_color("#444b5a")
    a = ax[0, 0]
    a.plot(x, col("ret"), color="#3a5a78", lw=0.8); a.plot(x, sm(col("ret")), color="#6ec6ff", lw=2)
    a.set_title("Mean episode return (training reward)", fontsize=11); a.set_ylabel("return")
    a = ax[0, 1]
    a.plot(x, 100 * sm(col("arrive")), color="#7CFC9A", lw=2, label="arrived")
    a.plot(x, 100 * sm(col("in_rule")), color="#FFD166", lw=2, label="arrived within 30-min rule (storm episodes)")
    a.set_title("Arrival rates (%)", fontsize=11); a.set_ylim(0, 101); a.legend(fontsize=8, loc="lower right", frameon=False)
    a = ax[1, 0]
    a.plot(x, 100 * sm(col("incap")), color="#FF6B6B", lw=2, label="incapacitating fall")
    a.plot(x, 100 * sm(col("heat")), color="#FF9F1C", lw=2, label="heat casualty")
    a.plot(x, 100 * sm(col("stuck")), color="#B388FF", lw=2, label="stuck")
    a.plot(x, 100 * sm(col("timeout") + col("o2")), color="#9aa4b2", lw=1.5, label="timeout / O2")
    a.set_title("Failures (% of episodes)", fontsize=11); a.set_xlabel("environment steps (millions of 10 s decisions)"); a.legend(fontsize=8, frameon=False)
    a = ax[1, 1]
    a.plot(x, sm(col("t_arrive_min") / np.maximum(col("plan_min"), 1e-6)), color="#6ec6ff", lw=2, label="time to arrive / planner time")
    a.plot(x, sm(col("falls")), color="#FF6B6B", lw=2, label="falls per episode")
    a.set_title("Pace and falls", fontsize=11); a.set_xlabel("environment steps (millions of 10 s decisions)"); a.legend(fontsize=8, frameon=False)
    fig.suptitle(title, fontsize=12, color="#e6edf3")
    fig.tight_layout(rect=(0, 0, 1, 0.95))
    fig.savefig(path, facecolor=fig.get_facecolor())
    plt.close(fig)


def pick_mode(ev):
    s, g = ev["sampled"]["policies"]["rl_sample"], ev["sampled"]["policies"]["rl_greedy"]
    if abs(s["arrive_pct"] - g["arrive_pct"]) > 0.3:
        return "sample" if s["arrive_pct"] > g["arrive_pct"] else "greedy"
    return "sample" if s["in_rule_pct_sep"] >= g["in_rule_pct_sep"] else "greedy"


def auto_summary(ev, mode, steps):
    P = ev["sampled"]["policies"]
    r = P["rl_" + mode]; b = P["baseline"]
    cmp = lambda a, c, hi=True: "better" if (a > c) == hi and a != c else ("equal" if a == c else "worse")
    parts = []
    parts.append("PPO policy trained for %.0f M ten-second decisions; it learned pacing (share of decisions at 0/0.4/0.65/0.95/1.3 m/s: %s) and small steering corrections around the planner corridor, not route finding."
                 % (steps / 1e6, "/".join("%.0f%%" % (100 * x) for x in r["pace_share"])))
    parts.append("On %d sampled episodes (%s inference) vs the scripted baseline: arrival %.1f%% vs %.1f%% (%s), arrived within the 30-min storm rule %.1f%% vs %.1f%% (%s), median time %.1f vs %.1f min, mean dose %.0f vs %.0f uGy."
                 % (ev["sampled"]["n"], mode, r["arrive_pct"], b["arrive_pct"], cmp(r["arrive_pct"], b["arrive_pct"]), r["in_rule_pct_sep"], b["in_rule_pct_sep"],
                    cmp(r["in_rule_pct_sep"], b["in_rule_pct_sep"]), r["median_time_min"], b["median_time_min"], r["mean_dose_uGy"], b["mean_dose_uGy"]))
    parts.append("Costs: incapacitating falls %.2f%% vs %.2f%% (%s), falls per crew %.2f vs %.2f (%s), heat casualties %.2f%% vs %.2f%% (%s), stuck %.2f%% vs %.2f%%."
                 % (r["incap_fall_pct"], b["incap_fall_pct"], cmp(r["incap_fall_pct"], b["incap_fall_pct"], False), r["mean_falls"], b["mean_falls"],
                    cmp(r["mean_falls"], b["mean_falls"], False), r["heat_casualty_pct"], b["heat_casualty_pct"], cmp(r["heat_casualty_pct"], b["heat_casualty_pct"], False),
                    r["stuck_pct"], b["stuck_pct"]))
    return " ".join(parts)


def results_md(ev, node=None):
    """Markdown tables of the evaluation (pasted into rl/README.md)."""
    L = []
    hdr = "| policy | arrived % | within 30-min rule % (storm eps.) | incapacitating fall % | heat casualty % | stuck % | timeout % | median time (min) | mean dose (uGy) | falls / crew |"
    sep = "|---|---|---|---|---|---|---|---|---|---|"
    row = lambda nm, r: "| %s | %.2f | %.2f | %.2f | %.2f | %.2f | %.2f | %s | %.0f | %.3f |" % (
        nm, r["arrive_pct"], r["in_rule_pct_sep"], r["incap_fall_pct"], r["heat_casualty_pct"], r["stuck_pct"], r["timeout_pct"], r["median_time_min"], r["mean_dose_uGy"], r["mean_falls"])
    names = (("rl_sample", "RL sampled"), ("rl_greedy", "RL greedy"), ("baseline", "scripted baseline"))
    for key, title in (("sampled", "Sampled scenarios (training distribution, new draw)"), ("heldout_goals", "Held-out goals (never used in training)")):
        if not ev.get(key): continue
        L += ["**%s - %d episodes per policy, identical episodes**" % (title, ev[key]["n"]), "", hdr, sep]
        L += [row(t, ev[key]["policies"][k]) for k, t in names]
        L += [""]
        L += ["By planned time (arrived % / within-rule % / incapacitating fall % / median min):", "", "| policy | 3-20 min | 20-40 min | 40-90 min |", "|---|---|---|---|"]
        for k, t in names:
            b = ev[key]["policies"][k]["by_plan_time"]
            L.append("| %s | %s |" % (t, " | ".join("%.1f / %.1f / %.2f / %s" % (v["arrive_pct"], v["in_rule_pct_sep"], v["incap_fall_pct"], v["median_time_min"]) for v in b.values())))
        L += [""]
    L += ["**Demo situations - %d crews per route and policy** (arrived %% / within-rule %% / incapacitating fall %% / stuck %% / median min / dose uGy)" % ev["demo"][0]["n"], "",
          "| situation -> destination (planner time) | RL sampled | RL greedy | scripted baseline |", "|---|---|---|---|"]
    for d in ev["demo"]:
        if d["plan_min"] < 0.5: continue
        cell = lambda r: "%.1f / %.1f / %.2f / %.2f / %s / %.0f" % (r["arrive_pct"], r["in_rule_pct_sep"], r["incap_fall_pct"], r["stuck_pct"], r["median_time_min"], r["mean_dose_uGy"])
        L.append("| %s -> %s (%.0f min) | %s |" % (d["scenario"], d["dest"], d["plan_min"], " | ".join(cell(d["policies"][k]) for k, _ in names)))
    L += [""]
    if node:
        L += ["**Node check of the exported policy.json through `rollout()` in sim.ts - %d crews, seed %d** (arrived %% / within-rule %% / incapacitating fall %% / median min / ms per 1000 crews)" % (node["n"], node["seed"]), "",
              "| situation -> destination | RL sampled | RL greedy | scripted baseline |", "|---|---|---|---|"]
        by = {}
        for r in node["rows"]:
            by.setdefault((r["scenario"], r["dest"]), {})[r["mode"]] = r
        for (sc, dn), m in by.items():
            if m["baseline"]["plan_min"] < 0.5: continue
            cell = lambda r: "%.1f / %.1f / %.2f / %.1f / %.0f" % (100 * r["arrive"], 100 * r["in_rule"], 100 * r["incap"], r["t50_min"], r["ms_per_1000"])
            L.append("| %s -> %s | %s |" % (sc, dn, " | ".join(cell(m[k]) for k in ("rl_sample", "rl_greedy", "baseline"))))
        L += [""]
    return chr(10).join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="run1")
    ap.add_argument("--ckpt", default="")
    ap.add_argument("--mode", default="")
    ap.add_argument("--summary", default="")
    ap.add_argument("--summary_file", default="")
    ap.add_argument("--others", nargs="*", default=[], help="other evaluated runs to list in the report (reward ablation)")
    a = ap.parse_args()
    run_dir = os.path.join(ROOT, "rl", "runs", a.run)
    ev = json.load(open(os.path.join(run_dir, "eval.json")))
    ckpt = a.ckpt or os.path.join(ROOT, ev["checkpoint"])
    ck = torch.load(ckpt, map_location="cpu", weights_only=False)
    cfg = ck["cfg"]
    mode = a.mode or pick_mode(ev)
    os.makedirs(POL_DIR, exist_ok=True)
    # ---- policy.json
    layers = []
    sd = ck["pi"]
    keys = sorted({k.rsplit(".", 1)[0] for k in sd}, key=lambda s: int(s.split(".")[1]))
    for k in keys:
        W = sd[k + ".weight"].double().numpy(); b = sd[k + ".bias"].double().numpy()
        layers.append(dict(nin=int(W.shape[1]), nout=int(W.shape[0]), W=[float(np.float32(x)) for x in W.reshape(-1)], b=[float(np.float32(x)) for x in b]))
    assert layers[0]["nin"] == 44 and layers[-1]["nout"] == 10
    P = ev["sampled"]["policies"]
    hl = lambda r: {k: r[k] for k in ("arrive_pct", "in_rule_pct_sep", "incap_fall_pct", "heat_casualty_pct", "stuck_pct", "median_time_min", "mean_dose_uGy", "mean_falls")}
    meta = dict(obs=44, act="5 heading + 5 pace logits", algo="PPO", steps=int(ck["env_steps"]), date=time.strftime("%Y-%m-%d"),
                hidden=[l["nout"] for l in layers[:-1]], activation="tanh", inference=mode,
                note="no observation normalisation; logits 0-4 heading offset {-60,-30,0,30,60} deg, 5-9 pace {0,0.4,0.65,0.95,1.3} m/s",
                eval=dict(episodes=ev["sampled"]["n"], rl_sample=hl(P["rl_sample"]), rl_greedy=hl(P["rl_greedy"]), baseline=hl(P["baseline"])))
    with open(os.path.join(POL_DIR, "policy.json"), "w") as f:
        json.dump(dict(layers=layers, meta=meta), f, separators=(",", ":"))
    # ---- learning curve
    rows = [r for r in read_log(run_dir) if r["update"] <= ck["update"]]      # curve up to the exported checkpoint
    learning_curve(rows, os.path.join(POL_DIR, "learning_curve.png"),
                   "PPO virtual-crew walking policy - %d parallel walkers on the Melas 5 m grid, %.0f M decisions, %.0f min on one GPU"
                   % (cfg["envs"], ck["env_steps"] / 1e6, ck["wall_s"] / 60))
    # ---- report
    last = rows[-10:]
    final = {k: round(float(np.mean([r[k] for r in last])), 5) for k in rows[-1] if k not in ("update", "env_steps", "wall_s", "lr", "ent_coef", "epochs_run", "roll_s")}
    par = {}
    pdir = os.path.join(ROOT, "rl", "runs", "parity")
    if os.path.exists(os.path.join(pdir, "planner_parity.json")):
        pp = json.load(open(os.path.join(pdir, "planner_parity.json")))
        par["planner"] = dict(grid_max_abs_diff=pp["grid"], shelters=pp["shelters"],
                              fields={k: {q: v[q] for q in ("cost_max_abs", "time_max_abs", "gx_max_abs", "gy_max_abs", "next_diff_pct", "cost_inf_mismatch")} for k, v in pp["fields"].items()})
    if os.path.exists(os.path.join(pdir, "env_parity.json")):
        ep = json.load(open(os.path.join(pdir, "env_parity.json")))
        par["env"] = {k: dict(one_step=dict(samples=v["one_step"]["samples"], obs_max_abs=v["one_step"]["obs_max_abs"], obs_elems_gt_1e3=v["one_step"]["obs_elems_gt_1e3"],
                                            state_max_abs={q: v["one_step"]["state_max_abs"][q] for q in ("x", "y", "heat", "o2", "dose")},
                                            int_mismatch=v["one_step"]["int_mismatch"]), free_run=v["free_run"]) for k, v in ep.items()}
        par["env_note"] = "training and evaluation run the environment with float64 state (the *_/float64 rows); float32 rows are shown for reference only"
    node = None
    nv = os.path.join(ROOT, "rl", "runs", "node_verify.json")
    if os.path.exists(nv) and os.path.getmtime(nv) >= os.path.getmtime(os.path.join(POL_DIR, "policy.json")) - 5:
        node = json.load(open(nv))
    summary = a.summary or (open(a.summary_file, encoding="utf8").read().strip() if a.summary_file else auto_summary(ev, mode, ck["env_steps"]))
    train_cfg = {k: cfg[k] for k in ("envs", "rollout", "updates", "gamma", "lam", "clip", "ent0", "ent1", "lr", "lr_end", "epochs", "minibatches", "vf_coef",
                                     "max_grad", "rew_scale", "target_kl", "hidden", "seed", "fields", "state_dtype", "value_clip", "critic")}
    train_cfg.update(policy="MLP 44->%s->10 (tanh), two categorical heads" % "->".join(str(h) for h in cfg["hidden"]), reward=cfg["reward"],
                     scenario_sampling=cfg["scen"], goals=cfg["goals"], hazard_states="band standing (alpha 27.8) + band active with alpha in {21.8, 24, 26, 27.8, 31.4}",
                     domain_randomisation="fallPerKm x U(0.6,1.6), coolW x U(0.85,1.1), alphaDeg via the hazard bank; terrainError = 0.25 + 0.35*dust as in worker.ts")
    rep = dict(generated=time.strftime("%Y-%m-%d %H:%M"), ai_generated=True,
               what="Reinforcement-learning walking policy for the virtual crews (pacing + local steering of a point walker; routes come from the Dijkstra planner). "
                    "Trained with PPO in a PyTorch mirror of app/src/engine/sim.ts; numbers below are simulation results of our own model, not NASA data.",
               exported_run=a.run, training=dict(config=train_cfg, total_env_steps=int(ck["env_steps"]), updates=int(ck["update"]), wall_clock_s=round(ck["wall_s"], 1),
                             device=torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu", final_metrics_mean_last_10_updates=final),
               parity=par, recommended_inference=mode, evaluation=dict(sampled=ev["sampled"], heldout_goals=ev.get("heldout_goals"), demo=ev["demo"]),
               node_verification=node, honest_summary=summary,
               limitations=["Point walker with a physiological budget on a 5 m grid: no humanoid locomotion, joints or vision.",
                            "Fall rate, injury probability, metabolic and thermal models are team assumptions fitted to Apollo-era numbers, not validated for Mars.",
                            "Trained and evaluated on one site (NE Melas Chasma EVA box); demo destinations are part of the training goal set.",
                            "The policy cannot observe the user-adjustable parameters; it was trained with mild randomisation of fall rate and suit cooling only."])
    keys = ("arrive_pct", "in_rule_pct_sep", "incap_fall_pct", "heat_casualty_pct", "stuck_pct", "timeout_pct", "median_time_min", "mean_dose_uGy", "mean_falls")
    rep["evaluation"]["table"] = [dict(policy=k, **{q: P[k][q] for q in keys}) for k in ("rl_sample", "rl_greedy", "baseline")]
    variants = []
    for o in a.others:
        od = os.path.join(ROOT, "rl", "runs", o)
        if not os.path.exists(os.path.join(od, "eval.json")): continue
        oe = json.load(open(os.path.join(od, "eval.json"))); oc = json.load(open(os.path.join(od, "config.json")))
        variants.append(dict(run=o, hidden=oc["hidden"], gamma=oc["gamma"], reward=oc["reward"], env_steps=oe["env_steps"], train_wall_s=round(oe["train_wall_s"], 1),
                             sampled={k: {q: oe["sampled"]["policies"][k][q] for q in keys + ("pace_share",)} for k in ("rl_sample", "rl_greedy")}))
    if variants:
        rep["other_trained_variants"] = dict(note="same environment and scenario distribution, different reward weights / network size; not exported", runs=variants)
    with open(os.path.join(POL_DIR, "rl_report.json"), "w", encoding="utf8") as f:
        json.dump(rep, f, indent=1, ensure_ascii=False)
    with open(os.path.join(run_dir, "results.md"), "w", encoding="utf8") as f:
        f.write(results_md(ev, node))
    print("exported %s -> policy.json (%d layers, mode %s), rl_report.json, learning_curve.png" % (os.path.relpath(ckpt, ROOT), len(layers), mode))
    print("summary:", summary)


if __name__ == "__main__":
    main()
