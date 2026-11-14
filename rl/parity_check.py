"""Replay the TS reference dump (app/scripts/parity_dump.ts) through rl/env.py and report differences.

    cd app && npx tsx scripts/parity_dump.ts
    python rl/parity_check.py

 one-step ("teacher forced"): load the TS state before every step, compare observe() and the state after
   stepAgent() - run with float64 (reference precision) and float32 (training precision).
 free-running: start from the first TS state and apply the dumped actions / randoms for the whole dump.
"""
import json, os, sys
import numpy as np
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import planner as P
from terrain import load_grid, ROOT
import env as E

D = os.path.join(ROOT, "rl", "runs", "parity")
FLOATS = ["x", "y", "t", "heat", "o2", "dose", "fallTimer", "bandSec", "dist", "heatPeak", "lastV"]
INTS = ["falls", "blockedRun", "status"]
COLS = ["x", "y", "t", "heat", "o2", "dose", "fallTimer", "falls", "blockedRun", "bandSec", "dist", "heatPeak", "status", "lastV",
        "effM", "cool", "vmul", "react", "seed"]


def load_state(env, row):
    dt = env.dtype
    for k, name in enumerate(COLS):
        v = torch.as_tensor(row[:, k].copy(), device=env.device)
        setattr(env, name, v.long() if name in INTS else v.to(dt))


def run_case(c, g, blocked, device, dtype):
    nA, R = c["nAg"], c["R"]
    rd = lambda nm, d: np.fromfile(os.path.join(D, "env_%s_%s" % (c["name"], nm)), dtype=d)
    pre = rd("pre.f32", np.float32).reshape(R, nA, c["NPRE"])
    post = rd("post.f32", np.float32).reshape(R, nA, c["NPOST"])
    obs_ts = rd("obs.f32", np.float32).reshape(R, nA, E.N_OBS)
    act = rd("act.u8", np.uint8).reshape(R, nA, 2)
    u = rd("u.f64", np.float64).reshape(R, nA, 3)
    info = rd("info.f64", np.float64).reshape(R, nA, 5)
    reset = rd("reset.u8", np.uint8).reshape(R, nA)
    T = E.Terrain(g, blocked, device, dtype)
    f = P.plan(g, blocked, c["gx"], c["gy"], c["active"], c["alpha"])
    bank = E.FieldBank([f], [(c["gx"], c["gy"])], [c["active"]], [c["alpha"]], device, g["n"])
    env = E.WalkEnv(T, bank, nA, auto_reset=False)
    z = torch.zeros(nA, device=device, dtype=dtype)
    env.goal_x = z + c["gx"]; env.goal_y = z + c["gy"]
    env.sep_el = z + c["sepElapsedS"]; env.deadline = z + (float("inf") if c["deadlineS"] is None else c["deadlineS"])
    env.dust = z + c["dust"]; env.terr_err = z + c["terrainError"]
    env.band_active = torch.zeros(nA, device=device, dtype=torch.bool) | bool(c["active"]); env.alpha = z + c["alpha"]
    tt = lambda a: torch.as_tensor(a.copy(), device=device)
    out = {}
    # ---- one-step parity
    d_obs = np.zeros(E.N_OBS); d_state = {k: 0.0 for k in FLOATS}; mism = {k: 0 for k in INTS}
    d_info = {"progress": 0.0, "doseInc": 0.0, "met": 0.0}; m_info = {"fell": 0, "blocked": 0}
    obs_bad = 0
    for r in range(R):
        load_state(env, pre[r])
        o = env.observe().cpu().numpy()
        dd = np.abs(o.astype(np.float64) - obs_ts[r])
        d_obs = np.maximum(d_obs, dd.max(0)); obs_bad += int((dd > 1e-3).sum())
        inf = env.step_dynamics(tt(act[r, :, 0]).long(), tt(act[r, :, 1]).long(), tt(u[r, :, 0]).to(dtype), tt(u[r, :, 1]).to(dtype), tt(u[r, :, 2]).to(dtype))
        for name in FLOATS:
            k = COLS.index(name)
            d_state[name] = max(d_state[name], float(np.abs(getattr(env, name).cpu().numpy().astype(np.float64) - post[r, :, k]).max()))
        for name in INTS:
            k = COLS.index(name)
            mism[name] += int((getattr(env, name).cpu().numpy() != post[r, :, k].astype(np.int64)).sum())
        m_info["fell"] += int((inf["fell"].cpu().numpy() != (info[r, :, 0] > 0)).sum())
        m_info["blocked"] += int((inf["blocked"].cpu().numpy() != (info[r, :, 1] > 0)).sum())
        d_info["progress"] = max(d_info["progress"], float(np.abs(inf["progress"].cpu().numpy() - info[r, :, 2]).max()))
        d_info["doseInc"] = max(d_info["doseInc"], float(np.abs(inf["doseInc"].cpu().numpy() - info[r, :, 3]).max()))
        d_info["met"] = max(d_info["met"], float(np.abs(inf["met"].cpu().numpy() - info[r, :, 4]).max()))
    out["one_step"] = dict(samples=R * nA, obs_max_abs=float(d_obs.max()), obs_argmax=int(d_obs.argmax()), obs_elems_gt_1e3=obs_bad,
                           state_max_abs=d_state, int_mismatch=mism, info_max_abs=d_info, info_mismatch=m_info)
    # ---- free-running parity (agents never re-initialised by the TS dump)
    load_state(env, pre[0])
    alive = np.ones(nA, bool)
    worst = {k: 0.0 for k in ("x", "y", "heat", "o2", "dose")}; st_mis = 0; cnt = 0; steps_cmp = 0
    for r in range(R):
        alive &= reset[r] == 0
        if not alive.any(): break
        active = env.status == 0
        env.step_dynamics(tt(act[r, :, 0]).long(), tt(act[r, :, 1]).long(), tt(u[r, :, 0]).to(dtype), tt(u[r, :, 1]).to(dtype), tt(u[r, :, 2]).to(dtype), active=active)
        st = env.status.cpu().numpy()
        st_ts = post[r, :, COLS.index("status")].astype(np.int64)
        st_mis += int((st[alive] != st_ts[alive]).sum())
        same = alive & (st == st_ts)
        for name in worst:
            k = COLS.index(name)
            if same.any():
                worst[name] = max(worst[name], float(np.abs(getattr(env, name).cpu().numpy().astype(np.float64)[same] - post[r, same, k]).max()))
        cnt += int(alive.sum()); steps_cmp = r + 1
    out["free_run"] = dict(agent_steps=cnt, steps=steps_cmp, max_abs=worst, status_mismatch=st_mis)
    return out


def main():
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    meta = json.load(open(os.path.join(D, "env_cases.json")))
    # parameters / constants must agree with the TS dump
    p = E.load_params()
    bad = {k: (v, p.get(k)) for k, v in meta["params"].items() if k in p and abs(p[k] - v) > 1e-12}
    assert not bad, bad
    sim = meta["sim"]
    for k in ("CELL", "DT", "SUB", "MET_B", "MET_C", "MET_REST", "ETA_UP", "K_DOWN", "O2_KG_PER_J", "O2_TANK_KG", "ROUGH0", "K_ROUGH",
              "K_SAND_MET", "FALL_SLOPE_REF", "FALL_T_MIN", "FALL_T_MAX", "ARRIVE_R", "T_MAX", "LOOK0", "LOOK1", "LOOK2", "MOVE_LOOK",
              "STUCK_STEPS", "DUST_SLOW", "DUST_FALL", "N_OBS"):
        assert abs(getattr(E, k) - sim[k]) < 1e-15, (k, getattr(E, k), sim[k])
    assert list(sim["PACES"]) == E.PACES and list(sim["HEADINGS"]) == E.HEADINGS
    g, _ = load_grid()
    keep, blocked = P.statics(g)
    res = {}
    for c in meta["cases"]:
        for name, dtype in (("float64", torch.float64), ("float32", torch.float32)):
            r = run_case(c, g, blocked, device, dtype)
            res["%s/%s" % (c["name"], name)] = r
            o, fr = r["one_step"], r["free_run"]
            print("%-12s %s  one-step (%d samples): obs max %.2e (idx %d, %d elems > 1e-3) | x %.2e y %.2e heat %.2e o2 %.2e dose %.2e | status mism %d falls %d blockedRun %d"
                  % (c["name"], name, o["samples"], o["obs_max_abs"], o["obs_argmax"], o["obs_elems_gt_1e3"], o["state_max_abs"]["x"],
                     o["state_max_abs"]["y"], o["state_max_abs"]["heat"], o["state_max_abs"]["o2"], o["state_max_abs"]["dose"],
                     o["int_mismatch"]["status"], o["int_mismatch"]["falls"], o["int_mismatch"]["blockedRun"]))
            print("%-12s %s  free-run (%d agent-steps, %d steps): x %.2e y %.2e heat %.2e o2 %.2e dose %.2e | status mism %d"
                  % ("", name, fr["agent_steps"], fr["steps"], fr["max_abs"]["x"], fr["max_abs"]["y"], fr["max_abs"]["heat"], fr["max_abs"]["o2"],
                     fr["max_abs"]["dose"], fr["status_mismatch"]))
    json.dump(res, open(os.path.join(D, "env_parity.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
