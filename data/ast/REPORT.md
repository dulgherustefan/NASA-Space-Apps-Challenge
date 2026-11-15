# Stress test of the candidate routes: what was run

Adaptive Stress Testing (Lee et al., 2020) uses reinforcement learning to search a simulator for the most likely failure. We apply it to a physics-based walk model with documented bounds. Results are model-based, not crew-validated.

Generated 2026-11-15T02:37:14Z on an RTX 5070 Ti laptop GPU (PyTorch, CUDA). Everything below is model-based: one walk model, one site, disturbance distributions that are team assumptions. Robustness in nats is minus the log-likelihood of the most likely failure found, a likelihood ratio and not a probability.

## Setup

- Simulator: `rl/env.py` walk model (batched on the GPU) wrapped by `rl/ast_env.py`; the hooked step reproduces the original step exactly when no disturbance is applied (see `rl/runs/ast/smoke_S1.json`).
- System under test: Scripted walker following the planner field at the planned pace, with the heat governor of the walk model and a re-localise rule when it leaves the planned field (rl/ast_env.py).
- Routes: planned by `rl/planner.py` through the engine (`rl/runs/ast/engine_cases.json`, exported as `routes.json`).
- Disturbance channels: cooling (multiplier 1 - 0.117 z, floor 0.65); metabolic (multiplier exp(0.12 z)); navigation (offset 53 m x (z_x, z_y), fades out in the last 200 m); pace (multiplier exp(0.08 z) per 10 s step); stumble (Bernoulli(pFall) per step, simulator probability); injury (Bernoulli(pInj) per stumble, simulator probability); z (standard normal, clipped to +/-3).
- Two configurations: `falls_terminal`: falls can be incapacitating (all failure classes); `falls_penalty`: falls cost time and energy only (resource failures).
- Headline configuration: `falls_terminal`. Rule: The configuration that separates the feasible S1 routes by more nats (spread {'falls_terminal': 3.02, 'falls_penalty': 0.0}).

Failure definitions (team assumptions):

- Incapacitating fall (simulator fall and injury probabilities; base rate 0.15 per km is a team assumption).
- Stored heat at or above 844 kJ (params.ts heatMaxKJ).
- O2 exhausted, or below the 60-minute reserve on arrival.
- With a solar storm active: not under cover when the shelter rule runs out (30 min from the alert, alert-to-first-step time included); when no open shelter can meet that rule any more, not under cover at the expected dose-rate peak (53 min after the alert).
- Stuck (no legal move for 3 min) or not arrived after 3 h.

Assumptions:

- Fall base rate 0.15 per km on easy ground: team assumption (Apollo fall counts have no distance denominator).
- Chance that a fall is incapacitating 0.01 x (1 + v / 0.65) x 1.5 downhill, capped at 0.3: team assumption.
- Suit cooling multiplier 1 - 0.117 z, floor 0.65 (380 W, NTRS 20160001058): assumed distribution.
- Metabolic multiplier exp(0.12 z), x0.70 to x1.43: assumed distribution.
- Navigation offset sigma 53 m (3 sigma = 160 m, JETT3 mean position error), fading out in the last 200 m: assumed distribution.
- Pace drift exp(0.08 z) per 10 s step: assumed distribution.
- All z are standard normal, clipped to +/-3. Robustness in nats is a likelihood ratio under these assumed distributions, not a probability.
- Model-based results from one walk model on one site; not crew-validated.

## Results

### S1: Solar particle event

Start (2800, 1500) core metres, pace 0.95 m/s, 29.0 min of walking allowed (30-minute shelter rule).

| Route | Undisturbed walk | Monte Carlo failure rate (95 % Wilson) | Robustness, nats (`falls_terminal`) | Robustness, nats (other) | Most likely failure | Method |
|---|---|---|---|---|---|---|
| 0 Terrain shelter A | 14.3 min, 14.7 min spare | 0.590 % (0.558 to 0.625), n = 200000 | 7.78 | no failure found above the search floor (log-likelihood -100 nats) | Incapacitating fall after 5 min on a 21 degree slope: navigation off by 36 m | cem |
| 1 Terrain shelter C | 21.0 min, 8.0 min spare | 1.230 % (1.183 to 1.280), n = 200000 | 4.76 | 4.39 | Not under cover when the shelter rule runs out (29 min of walking): navigation off by 143 m | cem |
| 2 Rover | infeasible without any disturbance (late) | 100.000 % (99.998 to 100.000), n = 200000 | not scored | not scored | Infeasible without any disturbance: the undisturbed walker is not under cover in time (planned walk 47 min) | n/a |
| 3 Habitat | infeasible without any disturbance (late) | 100.000 % (99.998 to 100.000), n = 200000 | not scored | not scored | Infeasible without any disturbance: the undisturbed walker is not under cover in time (planned walk 73 min) | n/a |

- Route 0, `falls_terminal`: Monte Carlo classes fall 0.590 %; most likely failure per class (nats): fall 7.78, heat not found, oxygen not found, late not found, stuck not found; CEM best log-likelihood per seed: -7.82, -8.25, -7.94; random search best log-likelihood per seed: -8.39, -8.35, -8.29; CEM restarts best log-likelihood per seed: -7.87, -7.78, -7.78.
- Route 0, `falls_penalty`: Monte Carlo: no failures; most likely failure per class (nats): heat not found, oxygen not found, late not found, stuck not found; CEM best log-likelihood per seed: none, none, none; random search best log-likelihood per seed: none, none, none; CEM restarts best log-likelihood per seed: none, none, none.
- Route 1, `falls_terminal`: Monte Carlo classes fall 1.213 %, late 0.017 %; most likely failure per class (nats): fall 7.65, heat not found, oxygen not found, late 4.76, stuck not found; CEM best log-likelihood per seed: -7.66, -7.66, -7.65; random search best log-likelihood per seed: -8.31, -7.47, -8.01; CEM restarts best log-likelihood per seed: -7.66, -4.76, -7.76.
- Route 1, `falls_penalty`: Monte Carlo classes late 0.019 %; most likely failure per class (nats): heat not found, oxygen not found, late 4.39, stuck not found; CEM best log-likelihood per seed: -12.89, -15.58, -13.64; random search best log-likelihood per seed: -16.63, -19.02, -16.65; CEM restarts best log-likelihood per seed: -9.81, -7.07, -4.39.

## What held and what did not

- Smoke test (U2 section 9.8) on S1: 5 of 5 checks passed (throughput, parity, hooks, reachability, likelihood). Throughput 1524k simulator steps per second with the hooks on; the hooked step reproduces the original step exactly (max difference 0); see `rl/runs/ast/smoke_S1.json`.
- S1: Rover, Habitat are infeasible without any disturbance (the undisturbed walker is not under cover in time) and not scored.
- S1 ranking by robustness (`falls_terminal`): Terrain shelter A (7.78) > Terrain shelter C (4.76). Other configuration: Terrain shelter A (no failure found above the search floor (log-likelihood -100 nats)) > Terrain shelter C (4.39). The ranking is the same in both configurations.
- Which search found the most likely failure (within 0.05 nat of the best, per route and configuration, 3 cases): CEM 1, CEM restarts 3.
- A single-Gaussian CEM can settle in the first failure basin it meets (often the incapacitating fall) and miss a more likely failure elsewhere; CEM restarts (random search, then local refinement) are the reference search here.
- No PPO adversary results are included in this export; the cross-entropy search is the headline method.

## Limits

- One site, three scripted incidents, fixed candidate routes: there is no generalisation claim.
- The walk model is not crew-validated. Fall rate, injury chance and all disturbance distributions are team assumptions; robustness values move with them (see the sensitivity rows if present).
- The adversary tests routes. It does not choose or change them; the planner generates the candidates.
- The stress-test simulator follows the planner's field, the engine's replay walker follows the drawn polyline: the same model in two implementations. Undisturbed walk times of both are listed in `routes.json`.
- Non-adversarial randomness (terrain-noise seed, recovery time after a stumble) is sampled in Monte Carlo and fixed at its nominal value in the adversarial searches, so that every reported failure replays exactly.
- The 1 m DTM has no footstep-scale terrain; the loose-sand layer is an image proxy.

Files: `ast_results.json`, `routes.json`, `ast_training.json`, `ast_baselines.json`, `ast_heatmap_<scenario>_<route>.png`, `learning_curve_ast.png`, `baselines_ast.png`. Code: `rl/ast_env.py`, `rl/ast_mc.py`, `rl/ast_cem.py`, `rl/train_ast.py`, `rl/eval_ast.py`, `rl/export_ast.py`.
