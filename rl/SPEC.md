# RL specification — "virtual crew" walking policy

The browser simulation in `app/src/engine/sim.ts` is the **reference model**. The training environment
(`rl/env.py`) must reproduce it step for step, so that a policy trained here behaves the same in the app.

## What the agent is
A suited astronaut walking on the real 5 m terrain grid of the EVA box (800 × 800 cells, HiRISE DTM),
trying to reach a shelter. The route corridor comes from the planner (goal-rooted Dijkstra,
`app/src/engine/planner.ts`); the agent decides **how to walk it**:

- **Action** every 10 s: heading offset relative to the planner guidance ∈ {−60, −30, 0, +30, +60}° and
  pace ∈ {0, 0.4, 0.65, 0.95, 1.3} m/s. Two independent categorical heads (5 + 5 logits).
- **Observation**: 44 floats (`observe()` in `sim.ts`, exact order and scaling there): for each of the five
  headings — grade at 7.5 m and 20 m, impassable flag, planner progress, soil difficulty, rockfall-band
  flag; then body and mission state — stored heat, own metabolic / cooling / pace traits, planned time to
  go, deadline pressure, solar-storm flag and normalised dose rate, local terrain shielding, O₂ fraction,
  heat-impaired flag, local slope, blocked-move counter, dust level.
- **Dynamics** (`stepAgent()`): Tobler-shaped slope speed factor, loose-sand and roughness slowdown,
  unmapped-terrain noise, metabolic rate (level cost + climbing work at Mars gravity), heat storage against
  the suit cooling limit (586 W ≈ 2,000 BTU/h; 506 kJ performance drop; 844 kJ failure), O₂ use, falls
  (rate grows with slope², roughness, speed², downhill, heat impairment, dust) with a chance of an
  incapacitating injury, radiation dose (GCR + idealised solar-particle-event profile, reduced by terrain
  blocked-sky fraction), time inside an active rockfall band.
- **Episode ends** on arrival (≤ 12 m from the goal), incapacitating fall, heat casualty, O₂ exhaustion,
  being boxed in for 18 decisions, or 3 h timeout.

## What it does *not* learn
No humanoid locomotion, no joint control, no vision. The policy learns **pacing and local steering** of a
point walker with a physiological budget. Route finding is done by A*/Dijkstra, not by RL.

## Reward (training only)
```
r = + (cost-to-go decrease) / 60                     progress, in planner minutes
    - 0.5 * dt / 60                                  time
    - doseIncrement / 40          (solar storm only) µGy
    - 0.03 * max(0, heat - 0.6*heatWarn) / heatWarn  heat build-up
    - 1.0  per fall,  - 0.2 per blocked move
    - 0.3 * dt / 60 while inside an ACTIVE rockfall band
terminal: +10 arrived (+5 more if before the shelter-rule deadline)
          -15 incapacitated / heat casualty / out of O2,  -10 timeout or stuck
```

## Training set-up
- Vectorised PyTorch environment on the GPU, thousands of walkers in parallel on the real terrain.
- Each episode samples: a goal (terrain shelters found by the engine + random walkable cells), a hazard
  state (rockfall band standing / active with a reach angle from the cited set), a solar storm
  (on/off, random elapsed time, 30-min rule deadline), dust level, initial heat and O₂, and a random
  physiology (metabolic efficiency, cooling, pace capability, reaction time).
- PPO (clipped), GAE(λ); small tanh MLP so that 1,000 walkers × 4 routes run in about a second in a
  browser worker.

## Parity
`app/scripts/parity_dump.ts` writes observations and step results for fixed states, actions and random
numbers; `rl/parity_check.py` replays them through `rl/env.py` and reports the largest difference.

## Export
`app/public/policy/policy.json`:
```json
{ "layers": [ { "nin": 44, "nout": H, "W": [...row-major nout×nin...], "b": [...] }, ... , { "nin": H, "nout": 10, ... } ],
  "meta": { "obs": 44, "act": "5 heading + 5 pace logits", "algo": "PPO", "steps": 0, "date": "", "eval": {} } }
```
Hidden activations are `tanh`; the last layer is linear (logits 0–4 heading, 5–9 pace).
