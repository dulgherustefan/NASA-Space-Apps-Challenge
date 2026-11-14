# Training task: stress-test the candidate routes

Machine: the Windows laptop with the RTX 5070 Ti. Everything written to the repo is in English.
Deadline for results in the repo: **Sunday 15 Nov, 07:00** (Bucharest). A smaller result on time beats a bigger one late.

## What this is

The product is an incident-response system for crews on foot on Mars (Melas Chasma). Its loop is Detect → Assess → Simulate → Respond.
You build **Simulate**: A* proposes candidate routes to shelter; a reinforcement-learning adversary, trained with
Adaptive Stress Testing (Lee et al., JAIR 2020), attacks each route in a physics-based walk simulation and reports the most
likely way the crew fails on it. Routes are ranked by how much has to go wrong to break them.

The design is already decided. Read it before writing code:

1. `docs/research/U2_rl_design.md` sections 4, 8, 9, 10 and 11 (the spec: channels, reward, PPO settings, smoke test, gates).
2. `rl/env.py` (`WalkEnv`, `step_dynamics`, `baseline_action`, `FieldBank`, `DEMO_GOALS`), `rl/planner.py`, `rl/terrain.py`, `rl/SPEC.md`.
3. `docs/CONTRACT.md` sections 1, 4 and 5 (coordinates and the files the app reads).

`rl/train_ppo.py` and `rl/evaluate.py` are the previous walking-policy trainer: use them as a PPO reference, do not retrain that policy.

## Setup

```bat
git pull
uv venv --python 3.12 .venv
uv pip install --python .venv\Scripts\python.exe torch --index-url https://download.pytorch.org/whl/cu128
uv pip install --python .venv\Scripts\python.exe numpy numba pillow matplotlib
.venv\Scripts\python -c "import torch;print(torch.__version__,torch.version.cuda,torch.cuda.get_device_name(0))"
.venv\Scripts\python rl\terrain.py
```

If a working venv with CUDA torch already exists on this machine, use it and skip the install. No `torch.compile`.
Train on CUDA only. Keys and `.env` never go into git.

## Scenarios (core metres: x east, y south inside the 4 km box)

| Id | Situation | Start | Candidate shelters |
|---|---|---|---|
| S1 | Solar particle event; shelter rule 30 min | science site (2800, 1500) | terrain A (2598, 1858), terrain C (2343, 2083), rover R (1700, 2600), habitat H (700, 3300) |
| S2 | Same, after the marsquake: rockfall band active (reach angle 27.8°), shelters inside the band closed | where the crew is on route A when the quake hits (take the S1 route-A point at 6 min) | the ones still open |
| S3 | One sol later, no storm: walk from the rover to the fresh boulder and back | rover R | pick the nearest walkable cell below the scarp inside the 27.8° band as the boulder site |

S1 is the priority. S2 next. S3 only if S1 and S2 are exported.
Routes come from `rl/planner.py` (the same planner the app uses). Export them, because the app replays exactly these polylines.

## Deliverables

Code in `rl/`: `ast_env.py` (wrapper around `WalkEnv`: follow a fixed route, disturbance hooks, likelihood bookkeeping),
`ast_mc.py`, `ast_cem.py`, `train_ast.py`, `eval_ast.py`, `export_ast.py`.

Results in `data/ast/` (formats in `U2_rl_design.md` section 8; positions in **local metres e, s, z** as in the contract:
`e = core.e0 + x`, `s = core.s0 + y`, `z` from the terrain grid):

- `routes.json`: per scenario, each candidate route as a polyline plus length, time, ascent, max slope.
- `ast_results.json`: per scenario and route: nominal run, robustness in nats, failure-class table, Monte Carlo failure rate
  with Wilson interval, the three most likely failures (trajectory ≤ 200 points with heat, O2, dose, status, and the
  disturbance events with channel, value, log-probability), 32 sampled adversary rollouts.
- `ast_heatmap_<scenario>_<route>.png`: 800 × 800, likelihood-weighted failure density.
- `ast_training.json`: learning curves for every method and seed on the same axes.
- `ast_baselines.json`: the equal-budget comparison table.
- `REPORT.md`: one page: what was run, budgets, seeds, what held and what did not, limits.
- `learning_curve_ast.png`, `baselines_ast.png`.

## Order of work, with gates

| Step | Time | Gate |
|---|---|---|
| 1. Hooks in `ast_env.py` + the 30-minute smoke test (`U2` section 9.8, all five checks) | 0:00–0:45 | Throughput under 50k steps/s, or hooks still broken after one fix: go to step 2 only and stop at Monte Carlo. |
| 2. Monte Carlo and cross-entropy (CEM) adversaries on S1, all routes; export once | 0:45–2:00 | **After this step a complete result exists. Export it before going on.** |
| 3. PPO adversary on S1 route 0, then all routes × 3 seeds | 2:00–4:00 | PPO must beat equal-budget MC and CEM on best-failure log-likelihood or distinct failures in 2 of 3 seeds. If not by 3:00, CEM is the headline and PPO is reported as it is. |
| 4. Two configurations: falls terminal, and falls as a time-and-energy penalty | with 2–3 | Headline the one that separates the routes; report both. |
| 5. Evaluation on fresh seeds, sensitivity (sigmas × 0.7 and × 1.3, `R_E` 50 and 200), export, plots, `REPORT.md` | 4:00–5:30 | |

A route whose nominal walker (zero disturbance) does not arrive with reserve is reported as "infeasible without any disturbance" and not scored.

## Failure definitions (team assumptions, print them in every output file)

- Incapacitating fall.
- Stored heat at or above the limit in `reference/ts_engine/params.ts`.
- Oxygen below the reserve on arrival, or exhausted.
- With a storm active: arrival after the 30-minute shelter rule.
- Timeout or stuck.

The fall base rate (0.15 per km) and the disturbance bounds in `U2` section 9.2 are assumptions. Label them as such.

## Wording rules for anything a judge may read

Say: "Adaptive Stress Testing (Lee et al., 2020) uses reinforcement learning to search a simulator for the most likely failure.
We apply it to a physics-based walk model with documented bounds. Results are model-based, not crew-validated."

Never say: survival probability; validated; "RL found the route"; "NASA uses this for EVA"; digital twin; results from one hand-picked seed.
If the adversary matches CEM, write that. If every route fails the same way, write that.
