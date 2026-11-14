"""Compare rl/terrain.py + rl/planner.py with the TS reference dump (app/scripts/dump_fields.ts).

    cd app && npx tsx scripts/dump_fields.ts
    python rl/planner_parity.py
"""
import json, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from terrain import load_grid, ROOT
import planner as P

D = os.path.join(ROOT, "rl", "runs", "parity")


def rd(name, dt):
    return np.fromfile(os.path.join(D, name), dtype=dt)


def main():
    g, _ = load_grid()
    n = g["n"]
    info = json.load(open(os.path.join(D, "fields.json")))
    res = {"grid": {}, "fields": {}}
    for k in ("z", "slope", "rough", "sand", "beta", "sky"):
        ref = rd("grid_%s.f32" % k, np.float32)
        res["grid"][k] = float(np.abs(ref.astype(np.float64) - g[k]).max())
    keep, blocked = P.statics(g)
    res["grid"]["keepout_cells_diff"] = int((rd("keepout.u8", np.uint8) != keep).sum())
    res["grid"]["blocked_cells_diff"] = int((rd("blocked.u8", np.uint8) != blocked).sum())
    sh = P.find_terrain_shelters(g, blocked)
    ts = info["shelters"]
    res["shelters"] = dict(n_py=len(sh), n_ts=len(ts),
                           max_xy_diff=max([abs(a["x"] - b["x"]) + abs(a["y"] - b["y"]) for a, b in zip(sh, ts)] + [0.0]),
                           cells_equal=all(a["cells"] == b["cells"] for a, b in zip(sh, ts)))
    print("grid max abs diff:", res["grid"])
    print("shelters:", res["shelters"])
    for c in info["cases"]:
        tm, rm = P.build_cell_costs(g, c["active"], c["alpha"])
        goals = P.goal_cells(g, blocked, c["x"], c["y"])
        assert goals == c["goals"], "goal cells differ"
        f = P.cost_to_go(g, blocked, tm, rm, goals)
        nm = c["name"]
        r = {}
        r["timeMul"] = float(np.abs(rd("field_%s_timeMul.f32" % nm, np.float32) - tm).max())
        r["riskMul"] = float(np.abs(rd("field_%s_riskMul.f32" % nm, np.float32) - rm).max())
        for k in ("cost", "time", "gx", "gy"):
            ref = rd("field_%s_%s.f32" % (nm, k), np.float32)
            a = f[k]
            fin = np.isfinite(ref)
            r[k + "_inf_mismatch"] = int((fin != np.isfinite(a)).sum())
            both = fin & np.isfinite(a)
            d = np.abs(ref[both].astype(np.float64) - a[both])
            r[k + "_max_abs"] = float(d.max())
            if k in ("cost", "time"):
                r[k + "_max_rel"] = float((d / np.maximum(1.0, np.abs(ref[both]))).max())
        nref = rd("field_%s_next.i32" % nm, np.int32)
        r["next_diff_pct"] = float(100.0 * (nref != f["next"]).mean())
        r["next_diff_cells"] = int((nref != f["next"]).sum())
        r["reachable_pct"] = float(100.0 * np.isfinite(f["cost"]).mean())
        # the compact codes used by the GPU bank must reproduce next / gx / gy exactly
        ii, jj = np.divmod(np.arange(n * n), n)
        k = f["nextk"].astype(np.int64); has = k != P.NEXT_NONE
        nb = P.NB[np.where(has, k, 0)]
        dec = np.where(has, (ii + nb[:, 0]) * n + (jj + nb[:, 1]), -1)
        r["nextk_decode_diff"] = int((dec != f["next"]).sum())
        res["fields"][nm] = r
        print(nm, json.dumps(r))
    json.dump(res, open(os.path.join(D, "planner_parity.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
