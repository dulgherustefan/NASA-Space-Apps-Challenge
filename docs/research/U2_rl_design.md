# U2: RL design for the "Simulate" step (Martian Map, Melas Chasma), Sat 14 Nov 2026 ~22:00

Research only. Nothing was trained, installed or run. Marks: **[V]** verified at a source I fetched (URL given), **[R]** verified in the team's own repo/notes (read from the files), **[S]** seen only in a search summary, **[I]** my inference or untested estimate. Concept and wording remain the team's decision (Space Apps AI rule).

---

## 0. Decision in six lines

1. **Primary: Design B = Adaptive Stress Testing (AST) with a PPO adversary.** A scripted crew follows each candidate route in the (already written) GPU walker simulator; the RL agent controls the *disturbances* (when the crew stumbles, how degraded the suit cooling is, how far navigation drifts, pace drift), is paid in log-likelihood, and so finds the **most plausible way each route fails**. Output per route: most-likely failure trajectory, failure heatmap, a robustness score in nats. Safest route = hardest to break.
2. **Fallback (2 h): the same simulator hooks and the same outputs, with a cross-entropy-method (CEM) / Monte Carlo adversary instead of PPO.** CEM is a documented AST solver. Honest label: "adversarial search", not RL.
3. **Do not** ship "RL produces the final route" (v2 navigator): never trained, R4 lists 10 open issues, and on a static cost it can at best tie Dijkstra [V, MarsPlanBench via R4/S2]. **Do not** ship "RL agents walk the routes" either, as worded: the walker is not the learner in B.
4. **No new install needed on the Windows laptop.** The repo's existing `.venv` (torch cu128) already trained 157 M steps on the RTX 5070 Ti [R: HANDOFF.md line 44, policy.json meta]. Do not upgrade torch tonight.
5. **Train in PyTorch, replay in Unreal.** Unreal receives JSON trajectories and a PNG heatmap. No in-engine training, no ONNX required.
6. **Precompute everything** for the scripted scenarios; a live sidecar is optional and must not be on the demo's critical path.

---

## 1. What the previous attempt designed, what R4 found, what is reusable

**Designed** (`old_repo/rl/SPEC.md`, `SPEC_NAV.md`, `env.py`, `nav_env.py`, `train_*.py`):
- v1 "virtual crew": PPO policy (tanh MLP 44-64-64-10) picks heading offset (5) and pace (5) every 10 s along a planner corridor; point walker with Tobler speed, Santee/Pandolf-style metabolic cost at Mars g, heat storage vs 586 W cooling, O2, falls (rate grows with slope^2, roughness, speed^2, downhill, heat, dust), SEP dose with terrain shielding. Trained 157,286,400 env steps; eval 32,768 episodes: RL sample 97.6 % arrival, greedy 96.9 %, incapacitating falls 2.4 %; scripted baseline 90.4 % arrival, 8.9 % stuck, 0.7 % incapacitated [R: `app/public/policy/policy.json` meta].
- v2 "navigator" (`SPEC_NAV.md`): 16 headings x 5 paces, masked, reward = real objective J in equivalent seconds + potential shaping on a static time-to-go field; the greedy rollout *is* the route; never trained. Throughput quoted: 286k env steps/s on the RTX 5070 Ti laptop [R: SPEC_NAV.md §5; BUILD_LOG.md line 29].

**R4 critique (key points, all checked there against sources):** assist trigger fires on legitimate band detours; gamma 0.995 makes the learner see "arrive in 50 min" vs "never arrive" as a ~400 eq-s gap (use 0.998 or action repeat); SEP deadline bonus is a cliff; observation is dominated by the planner's own field so "RL learned the route" is hard to defend (add ablations A1-A4, deviation rate); 160 m look-ahead cannot see a detour around a km-long band; held-out set leaks (random starts within 5-10 m of training starts); checkpoint selection on the report set; baseline B2 ignores dose/heat so RL "wins" against a weaker objective (add B3); mask checks sample points not the 15 m segment; need 3-5 seeds. R4's honest conclusion: RL can only legitimately beat a static Dijkstra where cost is **state-dependent** (heat storage, time-varying dose, deadline, stochastic falls). MarsPlanBench: Dijkstra 100 % success on 306 HiRISE maps; learned planners do not generalise [V via R4 ref 27, https://arxiv.org/html/2512.21438v1].

**S2 (feasibility):** "1,000 agents" is Monte Carlo/agent-based modelling with strong NASA precedent (CSRM, ENav 1,200-run MC, PRA for Artemis); calling it RL would be overclaiming; own-trained 0.38 g humanoid = very high risk; a rival (Astro-Reza/marswalk-model) has an unfinished RL walker [V via S2].

**Directly reusable (this is why B is cheap):**
- `rl/env.py` `WalkEnv.step_dynamics(hk, pk, u1, u2, u3)` already takes the fall draw `u1`, injury draw `u2`, fall-duration draw `u3` as *explicit inputs*, plus per-walker traits (`effM`, `cool`, `vmul`, `react`), `dust`, `terr_err`, SEP clock. That is exactly an AST "seed-action" simulator: the adversary only has to supply those numbers instead of `torch.rand` [R: env.py lines 265-395].
- `FieldBank` / `plan_many` / `build_bank`: goal-rooted planner fields for several presets, so "candidate route k" = "walker follows preset-k field's guidance, re-planning from wherever it is" [R: env.py lines 97-130, 545-620].
- `baseline_action` (scripted follower), `terrain.py` loader, status codes (arrived / fall injury / heat casualty / O2 out / timeout / stuck), 44-float observation, PPO scaffolding in `train_ppo.py`/`train_nav.py` (GAE, orthogonal init, CUDA-only guard), `export_policy.py`, float64 parity discipline with `sim.ts`.
- Caveats I could not check without running code: whether `WalkEnv` takes the route preset as a per-walker index (it has `fidx`, so very likely), and how much `reward()`/`observe()` cost per step.

---

## 2. Adaptive Stress Testing: is it the right, citeable framing?

**Yes, with two honest caveats (below).** Evidence:

- **Primary reference:** Lee, Mengshoel, Saksena, Gardner, Genin, Silbermann, Owen, Kochenderfer, "Adaptive Stress Testing: Finding Likely Failure Events with Reinforcement Learning", JAIR 69 (2020) 1165-1201, DOI 10.1613/jair.1.12190, arXiv 1811.02188. [V] https://jair.org/index.php/jair/article/view/12190 ; NASA NTRS 20210018655 lists **NASA Ames Research Center** as acquisition source and Ritchie Lee (Ames) as an author [V https://ntrs.nasa.gov/citations/20210018655]. Case study: prototype ACAS X (FAA) collision-avoidance system [V arXiv text].
- **The MDP [V, read in the paper's PDF, Eq. 3 and 6]:** a simulator S = system under test M + environment E, treated as a black box. The learner A is an adversary: at each step it observes the simulator state s, chooses a **disturbance x**, and the simulator transitions. Objective: `max over x_0..x_tend of  prod_t p(x_t | s_t)   subject to   s_tend in E` (E = failure/event set). Reward, with **gamma = 1** so that the sum equals the log of the path likelihood:
  - `R(s,x) = R_E` if s terminal and s in E (failure bonus, non-negative constant);
  - `R(s,x) = -d` if s terminal and not in E, where d = **miss distance** (how close the run came to failure; a constant if unavailable);
  - `R(s,x) = log p(x | s)` otherwise.
  Partially observable case: "seed-action" simulators where the action is the simulator's random seed, solved with MCTS-SA (modified MCTS needing only access to the PRNG). DAST (differential AST) finds failures present in one system and not in another.
- **Deep-RL solver:** Koren, Alsaif, Lee, Kochenderfer, "Adaptive Stress Testing for Autonomous Vehicles", arXiv 1902.01909: "DRL can find more likely failure scenarios than MCTS with fewer calls to the simulator" [V abstract; TRPO is the policy-step method per search summary S]. Venue (IEEE IV 2018) [I, not shown on the arXiv page].
- **Fixes for known AST weaknesses:** Corso, Du, Driggs-Campbell, Kochenderfer, "AST with Reward Augmentation" (ITSC 2019, arXiv 1908.01046): AST "tends to find scenarios where failure is unavoidable and repeatedly discovers the same types of failures"; adds a safety-policy term (RSS) and a dissimilarity metric [V search result]. Koren & Kochenderfer, Go-Explore for AST (arXiv 2004.04292) [V listing]. Koren, Nassar, Kochenderfer, backward algorithm for high-fidelity simulators (arXiv 2107.12940) [V listing].
- **Survey:** Corso, Moss, Koren, Lee, Kochenderfer, "A Survey of Algorithms for Black-Box Safety Validation of Cyber-Physical Systems", JAIR 72 (2021) 377-428, arXiv 2005.02979. Tasks: **falsification**, **most-likely failure analysis**, **failure-probability estimation**; algorithm families: optimisation, path planning, reinforcement learning, **importance sampling** (for failure probability) [V abstract https://arxiv.org/abs/2005.02979].
- **Related adversarial RL:** Pinto, Davidson, Sukthankar, Gupta, "Robust Adversarial RL" (RARL), arXiv 1703.02702: zero-sum two-player game, adversary applies destabilising disturbance forces, jointly trained, H-infinity motivation [V abstract]. Risk-sensitive: Chow, Ghavamzadeh, Janson, Pavone, "Risk-constrained RL with percentile risk criteria" (CVaR constraints, policy-gradient/actor-critic), arXiv 1512.01629 [V abstract].

**Caveat 1: AST is not a probability estimator.** It finds the most likely failure path and its likelihood under the *assumed* disturbance model. It does not output "P(crew dies on route A)". Probability needs importance sampling or plain Monte Carlo (survey, above). We can run plain GPU Monte Carlo for any route whose failure probability is above ~1e-4 (200k rollouts x ~500 steps = 100 M steps ~ 6-10 min [I]) and report Wilson intervals, but must label it "under model assumptions".

**Caveat 2: no precedent found for AST on EVA, rovers or human spaceflight.** Searches returned aviation (ACAS X, flight-management trajectory prediction), image-based NN controllers (Julian, Lee, Kochenderfer, NASA Ames, NTRS 20205003426), autonomous vehicles. The EVA RL/decision-support results were LLM-based (RASAGE) or non-RL (NASA PersEIDS, DST) [S]. So: cite AST's NASA Ames / FAA lineage, and say plainly that applying it to an EVA walk is our adaptation, not an established NASA practice. NASA CSRM / PRA Monte Carlo is the closest EVA-side precedent (via S2). Do not write "NASA uses AST for EVA".

**Toolboxes (is using them faster than ~150 lines of PPO over our own simulator? No):**
| Tool | Status | Verdict |
|---|---|---|
| `sisl/AdaptiveStressTestingToolbox` (Python, MIT) | last push **2022-12-08**; `requirements.txt` pins 2020-era packages (absl-py 0.9.0, aiohttp 3.6.2, atari-py 0.1.15, box2d-py); README: Docker preferred because of "dependency conflicts"; v2020.09.01.7 [V GitHub API + raw file] | Do not use. Will not install on Python 3.12 + torch 2.x tonight [I]. |
| `sisl/POMDPStressTesting.jl` (Julia) | last push 2024-02-06; solvers MCTSPW, TRPO, PPO, **CEM**, **RandomSearch**; interface GrayBox/BlackBox with `transition!` returning log-likelihood, `distance` (miss distance), `isevent`, `isterminal` [V GitHub] | Do not use (Julia, our simulator is Python/PyTorch). **But copy its design**: its solver list is the baseline list we should compare against (random search, CEM, deep RL). |
| `sisl/AdaptiveStressTesting.jl` | GitHub API 404 under `sisl/` [V]; likely superseded by POMDPStressTesting.jl [I] | n/a |
| Our own ~150-line PPO on the GPU env | the repo already has PPO + GAE + masks | Use this. |

---

## 3. Candidate designs compared

| | A. Walker policy (old v2) | B. AST adversary (recommended) | C. Two-player / population | D. Others |
|---|---|---|---|---|
| Agent controls | heading + pace of the crew | disturbances: stumble/fall timing, injury draw, suit-cooling and metabolic degradation, navigation drift, pace drift (bounded, with likelihood) | A and B alternating (RARL), or domain-randomised walkers + MC, RL only for abort/pace decisions | D1 CVaR/risk-constrained walker; D2 RL abort policy ("continue / divert to shelter j / turn back") on top of A* replanning; D3 failure-aware re-planning loop (heatmap -> A* cost -> re-test) |
| What it learns | a route (greedy rollout) | where and how the walk breaks | a robust walker and its adversary | D2: when to abort |
| Demo shows | route + learning curve | per-route weakest point, failure replay in 3D, heatmap, robustness ranking, "A* fastest route fails at 1.7 sigma, safer route needs 4 sigma" | walkers adapting vs adversary | D3: route visibly moves away from hotspot |
| Honesty risk | High: ties Dijkstra at best on static cost; "RL found the route" is attackable; R4's ten fixes unfinished | Medium: result depends on assumed disturbance bounds; adversary may exploit sim artefacts; "unavoidable failure" trap. All mitigable and checkable | High: minimax instability, more things to explain | D1/D2 medium; D3 low |
| Training cost | 1-2 h per run x seeds, plus tuning R4 issues; high risk of not converging in budget | 6-10 min per route-seed at ~150-250k steps/s [I]; 15 runs ~2-3 h, parallelisable | 2-3x B, unstable | D2 ~1.5-2 h extra; D3 ~1 h extra, no training |
| Adds over A* | nothing on static cost; only state-dependent costs | **tail risk and failure modes, which A* (nominal cost) cannot show**; ranking by robustness can differ from ranking by nominal cost | same as B plus a better walker | D3 closes the loop planner <-> adversary |
| Verdict | Drop | **Primary** | Skip (too much for 4-6 h) | D3 first (cheap), D2 only if everything else is done, D1 skip |

Why B fits the product: Detect and Assess already give a known incident and hazard map; Respond needs "which route and what margin". A* picks routes under a nominal cost; B asks **how much has to go wrong before this route breaks**, which is the question a flight surgeon or EVA flight director actually asks (cf. NASA risk framing in RESEARCH.md §1). Where a nominal-fastest route is fragile, B shows it; where it is not, B says so. Either outcome is a result.

---

## 4. Recommendation

### 4.1 Primary: "AST adversary on the walker simulator" (design B, with D3 as a bonus)

**One-line description for the team (replaces both previous framings):**
"Simulate: a reinforcement-learning adversary, trained with Adaptive Stress Testing (the method developed at NASA Ames and Stanford for aircraft collision avoidance), searches a physics-based simulation of the walk for the most plausible way each candidate route fails (a stumble on a steep downhill, degraded suit cooling, navigation drift). Routes are ranked by how large a disturbance it takes to make the crew fail."

**System under test (SUT):** crew protocol = scripted follower of preset-k planner field at the planned pace (`baseline_action`), plus two scripted protocol rules (heat governor: slow to 0.6 when stored heat >= warning; O2 abort: divert to nearest shelter if remaining O2 time < time-to-go x 1.25). Scenario fixed by Detect (S1-S3): start, goal(s), SEP clock, band state, dust. **Nominal walker (zero disturbance, expected falls) must reach the goal with reserve, else the route is reported "infeasible without any disturbance" and not scored** (this is the AST "unavoidable failure" guard from Corso 2019).

**Adversary:** PPO policy that picks, at a setup step (t=0) and at every 10 s decision step, bounded disturbances (table in §9.2). Reward = AST reward (Lee 2020 Eq. 6), gamma = 1. The Bernoulli disturbances are parameterised as a **tilt of the simulator's own probability**: q = sigmoid(logit(p_nominal) + delta(s)); delta = 0 at initialisation, so the untrained adversary *is* the nominal simulator (plain Monte Carlo) and learning starts from MC, not from nothing. [I: this parameterisation is mine, not from the AST papers; it follows from the importance-sampling view.]

**What it outputs per scenario x route:**
1. **Most-likely failure(s):** up to 3 diverse failures (different failure class or >100 m apart), each with trajectory, state traces (heat, O2, dose, falls), and the disturbance sequence. Failure classes: incapacitating fall, heat casualty, O2 reserve breached / O2 out, SEP deadline missed or dose limit exceeded (if SEP active), timeout/stuck.
2. **Robustness score = -log-likelihood of the most likely failure, in nats** (higher = harder to break), and the radius `sqrt(sum z^2)` for the Gaussian channels. Plain statement: "Route A fails at 4.1 sigma of combined suit/pace/navigation error or an 11-nat stumble-and-injury; route B at 1.7 sigma." It is a likelihood ratio under assumed distributions, not a probability.
3. **Failure heatmap** (800x800, 5 m cells): likelihood-weighted density of failure locations from the final adversary's stochastic rollouts. Label: "where the crew breaks when the disturbances are pushed to the plausible limit".
4. **Monte Carlo companion** (plain nominal disturbances, 200k rollouts): failure rate with Wilson 95 % interval per route, to show scale ("most routes fail < 1 in 1,000 under nominal noise, but the weakest point is X").
5. **Optional D3 loop (1 h, no training):** add cost proportional to heatmap density to the planner, re-run A*, re-run the adversary; report robustness before/after. Only show if it improves; do not show if it does not.

**Expected honest outcomes to prepare for [I]:**
- With the v1 model, the cheapest failure is probably a **fall with incapacitating injury** (v1 greedy: 2.4 % incapacitation, heat casualty 0.0 % nominally [R]). Per-step cost of forcing a fall at a steep downhill: p_fall per 10 s step ~ 0.15/1000 x 6.5 m x (1+(20/12)^2) x (1+2r) x 1.6 ~ 1e-2, so ~ -4.4 nats; injury p ~ 0.03, ~ -3.5 nats: total ~ 8 nats. Suit degradation at the documented floor (cooling x0.65, 3 sigma) costs ~ 4.5 nats and may not suffice to cause heat casualty alone. So injury-by-fall may dominate every route. **Run two adversary configurations and show both:** (i) all failure classes; (ii) "resource failures only" where a fall is a time/energy penalty (20-60 s plus a metabolic spike) but not terminal. (ii) is the one that says something about heat/O2/dose margins and route choice. Decide which to headline from the data.
- CEM may match PPO because the channel set is low-dimensional (3 setup parameters + a few stumble times) [I]. Report whichever is true.

### 4.2 Strictly smaller fallback (about 2 h): "adversarial search with the same hooks"

Same SUT, same disturbance channels, same outputs, but the adversary is **CEM over a parametric disturbance** (3 setup parameters + K=3 stumble events each with (route-distance, severity) + one pace-drift amplitude; Gaussian CEM distribution, 1,024 samples per iteration, elite 5 %, 30 iterations) evaluated by the batched simulator, minimising -log-likelihood subject to failure. No network, no PPO, no GAE. ~120 lines. Label honestly: "adversarial search (cross-entropy method, an AST solver per POMDPStressTesting.jl)". RL then appears only as v1 virtual-crew history. **Build this first**: it is also the baseline B needs for the credibility plot, so it is not wasted.

Floor below that (30 min): plain Monte Carlo with the hooks, report the lowest-norm failing sample per route. Calls it Monte Carlo; no RL claim.

### 4.3 Stretch (only if everything above is exported by T+4 h)
D2: RL abort/divert policy trained under domain randomisation, then **stress-tested by the same adversary** ("a learned crew policy vs the scripted protocol: which is harder to break?"). The `FieldBank` already has several goals (A, C, R, H in `DEMO_GOALS`), so divert targets exist. This is the only version where "RL agent" and "walker" are literally the same sentence; do it last.

---

## 5. Environment and tooling

### 5.1 Comparison
| Option | Verdict for tonight | Evidence |
|---|---|---|
| **Own batched PyTorch env on GPU (reuse `rl/env.py`)** | **Use.** Already runs on the RTX 5070 Ti; 286k steps/s quoted for v1 PPO [R SPEC_NAV §5]. 800x800 grid = 640k cells, gathers only. | repo |
| Gymnasium + SB3 / sb3-contrib `MaskablePPO` | Not needed (adversary has no action masking) and SB3 steps one Python env at a time. `sb3-contrib` latest 2.9.2, requires Python >=3.10 and `stable_baselines3>=2.9.2,<3.0` [V https://pypi.org/pypi/sb3-contrib/json]. Wrapping a 4096-batched GPU env as a VecEnv works but adds CPU/GPU copies [I]. | |
| CleanRL | Copy the single-file PPO idea; do **not** pip-install (README prerequisite: Python >=3.7.1,<3.11 [V https://github.com/vwxyzjn/cleanrl]; may be stale but it conflicts with Python 3.12). The repo already has its own PPO. | |
| PufferLib | Not evaluated; README page I could read gave no Windows/macOS statement [V page content; docs at puffer.ai]. Skip. | |
| TorchRL, RSL-RL | Both reasonable for GPU envs [I, not checked]; no advantage over the existing script tonight. Skip. | |
| JAX (gymnax, PureJaxRL, MJX) | **Excluded on the Windows laptop:** JAX docs: NVIDIA GPU on native Windows = "no"; WSL2 = "experimental"; pip GPU installs "do not work with Windows, and may fail silently"; CUDA 13 wheels "only available on linux" [V https://docs.jax.dev/en/latest/installation.html]. | |

### 5.2 Throughput
- RTX 5070 Ti laptop (12 GB): 286k env steps/s for v1 PPO (4096-8192 envs) [R]. The AST env adds disturbance application, a likelihood sum and a small adversary MLP forward on the same batch, so expect 150-250k steps/s [I]. 100 M steps = 7-11 min. Memory: field bank for 5 presets x goals x float32 cost-to-go fields is the main allocation (old bank worked on this GPU) [R/I].
- M5 Pro 24 GB, MPS: **no measurement exists; I found no published PPO-on-MPS numbers.** Known issues: **MPS does not support float64** ("Cannot convert a MPS Tensor to float64 dtype") [V search of PyTorch forum/Apple forum results, e.g. https://discuss.pytorch.org/t/apple-m1-silicon-typeerror-cannot-convert-a-mps-tensor-to-float64-dtype/164655]; the old env keeps state in float64 for TS parity [R: train_nav.py `state_dtype="float64"`], so it needs a float32 path on Mac. Small-MLP RL loops are dispatch-bound on MPS (PyTorch forum: ~25 us/op floor, small batches favour CPU) [S]. Verdict: MPS is usable for dev smoke tests and plots; **train on the RTX**. Expect 5-20x slower than the 5070 Ti [I, untested].

### 5.3 Install / run
**Windows (preferred: reuse existing venv; no installs):**
```
cd <repo root>
.venv\Scripts\python -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.get_device_name(0), torch.cuda.get_arch_list())"
```
Expect a cu128 build with `sm_120` in the arch list (it trained before [R]).

If the venv is gone, fresh (Python 3.12, wheels exist for cp312 win_amd64):
```
uv venv --python 3.12 .venv
uv pip install --python .venv\Scripts\python.exe numpy scipy numba rasterio
uv pip install --python .venv\Scripts\python.exe torch --index-url https://download.pytorch.org/whl/cu132
```
- PyTorch 2.15.0 released 2026-10-28; Python 3.11-3.15; default wheel CUDA 13.2, CUDA 13.4 wheels alongside for Linux x86_64/aarch64 and **Windows** [V https://pytorch.org/blog/pytorch-2-15-release-blog/ and https://dev-discuss.pytorch.org/t/pytorch-2-15-0-general-availability/3470]. CUDA 12.6 wheels dropped; **Blackwell sm_100/sm_120 "Retained"** [V https://dev-discuss.pytorch.org/t/notice-cuda-12-6-wheels-will-no-longer-be-published-from-pytorch-2-15-drops-maxwell-pascal-volta/3432]. I confirmed that `https://download.pytorch.org/whl/cu132/torch/` and `/cu134/torch/` serve `torch-2.15.0+cu132-cp312-cp312-win_amd64.whl` and the cu134 equivalent [V curl].
- Driver: CUDA 13.2 maps to the R595 driver branch, 13.4 to R615; "existing CUDA 13.x applications run on drivers >=580 under minor-version compatibility" [V https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/index.html]. Check `nvidia-smi`; if the laptop driver is < 580, stay on the working cu128 venv.
- **Flags for RTX 50 / Windows:** early stable wheels lacked sm_120 (before cu128, 2025) and many forum threads show "sm_120 is not compatible" and "sm_120 is not defined for option 'gpu-name'" (ptxas/Triton) [S: https://discuss.pytorch.org/t/nvidia-geforce-rtx-5070-ti-with-cuda-capability-sm-120/221509 and /t/rtx-5070-ti-blackwell-pytorch-nightly-triton-still-getting-sm-120-is-not-defined-for-option-gpu-name-error/220460]. For our use: all of that is resolved by a cu128+ wheel, and **avoid `torch.compile` on Windows** (Triton is where the ptxas errors live); run eager [I]. Do not use nightly.

**macOS (dev / plots / export only):**
```
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python numpy scipy numba torch
```
PyTorch 2.15 reportedly needs macOS 15+ for the new MPS paths [S: tilnote.io summary]; M5 Pro machines ship newer, so fine. Set `device="mps"` only with float32 state; otherwise run CPU.

---

## 6. Physics simulators: is a rigid-body humanoid at 0.38 g realistic in the time budget?

**No.** (a) Time: even with a pretrained robot policy, observation layout, rough terrain, suit mass and export take 10-20 h by S2's estimate [V via S2]; the one rival attempting a musculoskeletal walker had no walking policy as of today [V via S2]. (b) Fidelity: a 1 m HiRISE DTM does not contain the footstep-scale rocks and soil stiffness that decide a humanoid's slip; the Stanford paper (arXiv 2610.30080) shows humanoid survival swinging 0.10 to 0.99 with controller and training recipe, and states results are "conditional on the contact model and soil stiffness" [V via S2]. (c) Tooling on our laptop: MJX/Brax need JAX GPU, unsupported on native Windows [V §5.1]; Isaac Lab/Genesis not checked for Windows [I]. (d) Even a perfect humanoid would produce a survival number driven by the controller, not by Mars.

**Honest wording if we model the walker as a point with a metabolic/terrain model:**
"The simulated environment is a point walker on the real 5 m terrain grid. Martian gravity (3.71 m/s^2) enters through the metabolic cost of climbing and descending, the speed-slope relation, and the fall hazard model; it is not a humanoid locomotion simulation. Fall rates scale from Apollo's 27 falls and 21 near-falls. Every parameter is a model assumption listed on screen."

---

## 7. Unreal Learning Agents (UE 5.8): verdict

**Train in PyTorch; replay in Unreal.** Reasons:
- Learning Agents is Epic's built-in RL plugin. From forum posts (search summaries, not fetched): only PPO trainer, Python trainer files sit in the engine plugin folder, inference uses custom ISPC code rather than NNE, and the Python part is stripped from Shipping builds [S: https://forums.unrealengine.com/t/learning-agents-pytorch-flexibility-and-non-policy-onnx-support/1726063 and related threads]. I could **not** confirm anything about 5.8: Epic's docs pages are JavaScript-rendered and returned empty to my fetch [V: attempted]; the 5.8 release notes coverage I found mentions an experimental MCP/AI-agent plugin, Megalights production-ready, and a 5.8.1 hotfix, nothing on Learning Agents [S].
- AMD Schola v2 (MIT): connects UE to Ray RLlib / SB3 via CLI, **UNNEPolicy** runs ONNX through NNE; tested with UE 5.5-5.6 only; needs VS 2022, Python 3.10-3.12 [V https://gpuopen.com/learn/announcing-amd-schola-v2-nextgen-rl-unreal-engine/]. Unverified for 5.8.
- Our simulator is a tensor program on a 800x800 grid, not an Unreal scene. Moving it into Unreal would mean re-implementing the physics model in Blueprint/C++ and training at engine speed (thousands of times slower than 286k steps/s). No benefit for judges, high schedule risk.
- What Unreal needs: positions + states over time (a spline follower) and a heatmap. A trajectory JSON is enough. Policy inference in-engine is unnecessary because the adversary's output is a *recorded failure*, not a live controller.

---

## 8. Export and runtime

**Principle (the demo does not depend on live APIs):** precompute for every scripted scenario x route; ship static files; live recompute is an optional extra.

Files (core metres, x east, y south, plus z from the DTM so Unreal does not need to resample):
| File | Content | Size [I] |
|---|---|---|
| `ast_results.json` | per scenario x route: config (disturbance bounds, seeds, budgets), nominal run, robustness (nats, radius), failure classes table, MC failure rate + Wilson CI, top-3 failures (trajectory ≤200 points: t, x, y, z, heat, o2, dose, falls, status, disturbance events with channel/value/log-p), 32 sampled adversary rollouts for flavour | 2-4 MB JSON, <1 MB gz |
| `ast_heatmap_<scenario>_<route>.png` | 800x800 uint8, likelihood-weighted failure density (log scaled), world transform in JSON | ~50-150 KB each |
| `ast_training.json` | learning curves: update, env_steps, mean return, failure rate, best log-likelihood so far, entropy, KL, explained variance; baselines (MC, random search, CEM) on the same axes; 3 seeds | <200 KB |
| `ast_baselines.json` | equal-budget comparison table (see §10) | small |
| `ast_policy_<route>.json` | MLP weights in the existing `export_policy.py` format (TS forward is 20 lines); ONNX optional (`torch.onnx.export`, verify with onnxruntime) | ~120 KB each (30k params) |

**Live inference?** Not needed for the demo. If a "what if" button is wanted: a Python sidecar (FastAPI/websocket on the RTX laptop) running the stored adversary on a modified scenario takes ~1-3 s for 8k rollouts [I]; keep it behind a flag and never as the only path. A browser-side forward pass of a 30k-param MLP is also trivial, but the *simulator* is the heavy part and lives in Python/GPU; the TS `sim.ts` reference could run a few hundred rollouts in a worker (S2 measured 1,000 walkers x 3,000 steps in 0.24 s on one thread [V via S2]), so a TS-side replay of a *found failure* (disturbance sequence applied to `sim.ts`) is feasible and doubles as the independent verification.

---

## 9. Concrete spec

### 9.1 Episode, observation, action, reward, termination

- **Episode:** one adversary episode = one full walk of one route in one scenario. Decision step 10 s (same as v1 `DT`), `T_MAX` = 3 h = 1,080 steps (typical route 400-700). Step 0 is a "setup" step.
- **Observation (≈ 28 floats, scaled to ~[-1,1]):** route progress fraction; time / planned time; distance to goal (log-scaled); stored heat / heat-warning; heat / heat-max; O2 fraction; O2-time margin (O2 minutes left minus time-to-go minutes) / 60; dose / limit; SEP on, SEP rate; local slope at 3 look-aheads (7.5, 20, 60 m); roughness; sand; downhill flag; **pFall_now** (the simulator's own fall probability for this step), **pInj_now**; fall timer; current effM, cool-multiplier, nav-offset (chosen at setup); in-band flag; dust; `is_setup` flag; steps-remaining fraction. Critic sees the same vector (state is fully observable by construction). Running mean/std normalisation, clip ±10, frozen on export [V Andrychowicz via R4].
- **Action (mixed):**
  - Setup step only: `z_eff, z_cool, z_nav_x, z_nav_y` ∈ R, nominal N(0,1), clipped ±3 (nav as 2D).
  - Every step: `z_v` ∈ R (pace drift, N(0,1), clipped ±3), `b_fall` ∈ {0,1} (force a stumble this step), `b_inj` ∈ {0,1} (if a stumble occurs, make it incapacitating).
  - Policy: Gaussian head for z's (state-dependent mean, learned log-std init -0.5; log-prob counted only on the dims used at that step), two Bernoulli heads as tilts (above). Joint log-prob = sum.
- **Likelihood term (nats):** `log p = -0.5 * sum(z^2)` for Gaussian dims (constants dropped, so zero-disturbance = 0 cost); for Bernoulli: `log p_nom` if b=1, `log(1 - p_nom)` if b=0, with `p_nom` = the simulator's own pFall/pInj at that state. Using the simulator's probabilities means the adversary automatically concentrates stumbles on steep, rough, downhill, hot, dusty cells.
- **Reward (Lee et al. 2020 Eq. 6, gamma = 1):** per step `r = log p(a_t | s_t)`. Terminal failure: `+R_E`, `R_E = 100` nats-equivalent [I: must exceed the largest plausible path cost, ~30 nats]. Terminal non-failure: `-100 * d`, `d = 1 - max_t stress_t` in [0,1], `stress_t = max(heat/heatMax, 1 - o2/o2_0 normalised to the reserve, dose/limit if SEP)` ("how close to failing it got"). Scale all rewards by 1/10 for PPO. **Sensitivity run at R_E = 50 and 200.**
- **Failure set E:** incapacitating fall; heat >= heatMax (844 kJ, `params.ts`); O2 <= reserve at arrival or O2 out; if SEP active: arrival after the 30-min shelter-rule deadline or dose over the team's threshold [limits: team's assumptions, state them]; timeout or stuck.
- **Termination:** arrival (≤ 12 m of goal, as v1), any failure, or `T_MAX`. Truncation bootstraps (R4 action 2).

### 9.2 Disturbance model: bounds and sources (every one shown on screen)
| Channel | Nominal | Adversary range | Basis |
|---|---|---|---|
| Suit cooling capacity (episode) | 586 W (`coolW`) | multiplier 1 - 0.117 z, z in [-3,3]: **floor 0.65 (=380 W)** | SWME 380 W without sweep gas, 716 W with, 810 W in vacuum, tested 6-10 Torr [V RESEARCH.md §3, NTRS 20160001058] |
| Metabolic efficiency multiplier (episode) | 1.0 | exp(0.12 z), z in [-3,3]: x0.70 to x1.43 | v1 crew traits; Apollo-14 measured 349 W vs scaled Pandolf 194 W shows model-form error can exceed this [V RESEARCH.md §3]: either widen or declare. **Team to confirm.** [I] |
| Navigation error (episode, 2-D offset applied to where the crew thinks it is) | 0 m | sigma 53 m, 3 sigma = 160 m | JETT3 mean position error 160 m [V RESEARCH.md §1] |
| Pace drift (per step) | 1.0 | exp(0.08 z) | speeds 0.76-0.98 m/s, i.e. about ±13 % [V RESEARCH.md §3, ICES-2026-127] |
| Stumble / fall (per step Bernoulli) | simulator's pFall (`fallPerKm` = 0.15/km base, x(1+slope^2)(1+2r)(speed/0.65)^2 x1.6 downhill x2 if heat-impaired x(1+1.5 dust)) | forced if b=1; cost log pFall | Apollo: 27 falls + 21 near-falls catalogued (Thuro & Stirling 2021, via Chiou-Tan 2026) [S via S2]; base rate calibration in `params.ts` [R]: **source of 0.15/km not documented, team to confirm** |
| Injury given fall (per fall) | `fallInjuryP` = 0.01 x (1+v/0.65) x 1.5 downhill, cap 0.3 | forced if b_inj=1 | same, [R env.py] |
| **Not adversarial (scenario inputs from Detect):** SEP onset/rate/deadline, band state, dust, start, goal | | | per scenario S1-S3; dust may be a channel in a later version |

Sensitivity: rerun with all sigmas x0.7 and x1.3 (and R_E 50/200); report whether the **route ranking** is stable (rank correlation). If it flips, say so.

### 9.3 Network and PPO
- Adversary actor MLP 2 x 128 tanh (≈ 30 k params with heads), separate critic 2 x 256 tanh; orthogonal init (sqrt2 hidden, 0.01 policy head, 1.0 value) [V 37 details via R4].
- 4096 envs x 128 steps = 524,288 per update; 8 minibatches, 4 epochs; Adam 3e-4 linear anneal to 3e-5, eps 1e-5; clip 0.2; entropy 0.003 (Gaussian) with the Bernoulli tilts regularised by nothing else; value coef 0.5, no value clipping; grad-norm 0.5; advantage norm per minibatch; **gamma 1.0, GAE lambda 0.95** (AST: gamma 1; if the critic is noisy at 600-step horizons use 0.999). Starting values, tune lr and entropy first [I; base values from R2/R4].
- Budget: 100 M env steps per route-seed (≈ 190 updates). Evaluate every 10 updates with 4,096 stochastic rollouts, logging best-failure log-likelihood so far.

### 9.4 Training budget (wall-clock)
| Machine | Throughput | 1 run (100 M) | 5 routes x 3 seeds = 15 runs |
|---|---|---|---|
| RTX 5070 Ti laptop | 150-250k steps/s [I, v1 = 286k [R]] | 7-11 min | 1.8-2.8 h sequential; run 2-3 processes in parallel if GPU utilisation < 50 % |
| M5 Pro MPS (float32) | unknown, expect 5-20x slower [I] | 40-200 min | not for training |
Time plan (RL budget 4-6 h): T+0:00-0:30 hooks + smoke; 0:30-1:30 CEM + MC baselines + route-follow SUT; 1:30-2:15 PPO adversary on route 0, tune; 2:15-4:00 seeds x routes in background while exporting; 4:00-5:00 plots, replay verification, JSON; reserve 1 h.

### 9.5 Evaluation protocol
- **Equal budget:** every method (MC, random search over scaled disturbances, CEM, PPO-AST) gets the same simulator-step budgets (10 M, 25 M, 50 M, 100 M) per route, 3 seeds.
- **Metrics:** (1) best failure log-likelihood found vs sim steps (the AST-literature figure, Koren 2019 / POMDPStressTesting.jl solver list); (2) number of failing rollouts with log-likelihood above a fixed threshold (e.g. all failures at least as plausible as the best MC failure) per 1,000 rollouts; (3) failure-class table; (4) diversity: number of distinct failure sites (>100 m apart).
- **Held-out:** final evaluation rollouts use fresh RNG seeds never used in training; the scenario/route set is fixed (S1-S3 x K routes) so there is no "generalisation" claim, and we say so.
- **Verification:** replay the top-20 failures per route through the independent reference `sim.ts` (float64) using the recorded disturbance sequence; report how many reproduce the failure. If few do, the adversary is exploiting a Python-port artefact: fix before showing anything.
- **Seeds:** 3 training seeds per route, ship the seed chosen on a validation rollout set, report all three in the plots (Henderson 2018; Agarwal 2021 intervals via R4 refs 23-24).
- **Nominal check:** nominal deterministic walker per route must succeed with reserve; log margin.

### 9.6 File outputs
`rl/ast_env.py` (wrapper around `WalkEnv` + hooks + likelihood), `rl/ast_mc.py`, `rl/ast_cem.py`, `rl/train_ast.py`, `rl/eval_ast.py`, `rl/export_ast.py`; outputs as in §8; `rl/runs/ast/<scenario>_<route>_s<seed>/{ckpt.pt, log.csv, config.json}`; `learning_curve_ast.png`, `baselines_ast.png`, `heatmap_*.png`. (Filenames are my proposal, not existing files.)

### 9.7 Exact commands (Windows, existing venv; nothing installs)
```
cd <repo root>
:: 0. environment check
.venv\Scripts\python -c "import torch;print(torch.__version__,torch.version.cuda,torch.cuda.get_device_name(0),torch.cuda.get_arch_list())"
:: 1. smoke test (30 min milestone, below)
.venv\Scripts\python rl\ast_mc.py --scenario S1 --routes all --envs 4096 --steps 4000000 --smoke
:: 2. baselines at equal budgets (the 2 h fallback is already complete after this + step 4)
.venv\Scripts\python rl\ast_mc.py  --scenario S1 --routes all --steps 100000000 --out rl\runs\ast\mc
.venv\Scripts\python rl\ast_cem.py --scenario S1 --routes all --iters 30 --pop 1024 --out rl\runs\ast\cem
:: 3. PPO adversary, one route first
.venv\Scripts\python rl\train_ast.py --scenario S1 --route 0 --seed 0 --envs 4096 --rollout 128 --total-steps 100000000
:: 4. all routes and seeds (sequential or two shells)
.venv\Scripts\python rl\train_ast.py --scenario S1 --route all --seeds 0 1 2 --total-steps 100000000
:: 5. evaluate, verify against sim.ts, export for the app and Unreal
.venv\Scripts\python rl\eval_ast.py --scenario S1 --all --verify-ts
.venv\Scripts\python rl\export_ast.py --out app\public\ast
```

### 9.8 30-minute smoke test (detects failure early)
Run on the RTX, one scenario, one route, 4 M steps:
1. **Throughput** >= 100k steps/s with the hooks (else profile; if < 50k, go straight to the fallback, CEM needs far fewer steps).
2. **Nominal parity:** hook-free run reproduces the v1 scripted-baseline numbers from `policy.json` (arrival 90.4 %, stuck 8.9 %, incap 0.7 %) within ~1 percentage point; the nominal deterministic walker reaches the goal with reserve on >= 3 of the K routes.
3. **Hook sanity:** forcing `b_fall=b_inj=1` at the steepest downhill gives 100 % incapacitation; setting cooling multiplier 0.65 and effM 1.43 raises peak heat vs nominal.
4. **Reachability:** with all channels at +3 sigma plus forced stumble, failure rate >= 50 % on >= 3 routes (else failure definitions are unreachable; relax limits before training).
5. **Likelihood bookkeeping:** MC rollouts' mean log-likelihood = 0 for nominal draws within noise; a forced stumble costs the expected nats (±0.1).
**Decision rule:** all five pass -> continue to PPO. 1 or 2 fails -> stop, fix or take the **CEM fallback** (do not debug throughput for more than 30 min). 3-5 fail -> hook bug; fix once; otherwise **Monte Carlo floor**.
**Second gate at T+2 h:** PPO adversary on route 0 must beat the equal-budget MC and CEM baselines on best failure log-likelihood or distinct failures in >= 2 of 3 seeds. If not by T+3 h, ship CEM as the headline adversary and report PPO truthfully ("matched CEM", or "did not beat it").

---

## 10. Credibility package (what convinces aerospace engineers and the data/AI judge)

1. **Learning curve** of the adversary (best failure log-likelihood vs env steps, 3 seeds) **plotted against MC, random search and CEM at equal budget**. This is the standard AST figure and the honest answer to "why RL".
2. **Failures per 1,000 rollouts above a plausibility threshold**, AST vs random disturbances (MC). Be precise: AST samples from a tilted distribution, so say "failures at least as plausible as X", not raw failure counts.
3. **Ablations:** remove each disturbance channel (which one drives the failure?); R_E and sigma sensitivity; two failure configurations (falls terminal vs falls as delay).
4. **Independent replay** of found failures in `sim.ts` (reproduction rate).
5. **Ranking value:** show nominal-cost ranking vs robustness ranking of the K routes (rank correlation). If equal, say so ("A* ranking holds; here is why"); if different, show the case.
6. **Scripted vs RL walker** only if stretch D2 is done.
7. **Validation honesty:** the nominal walker vs Apollo 14 EVA-2 (finished with 31.7 % O2; traverses +43.6 % vs plan [V RESEARCH.md §3]) is a *sanity regression of the model, with Moon gravity*, not validation of Mars outcomes; do only if cheap (swap g, distance, suit), and show it as "model reproduces order of magnitude" or omit. Also cite SEXTANT's field result (time and energy significantly above predictions, p < 0.01) as the reason every number is a model [V via R4 ref 15].
8. **Limits slide:** one site; model not validated for crews; likelihood depends on assumed distributions; AST finds a plausible failure, not the probability; adversary results hold for the scripted protocol tested; terrain footstep-scale effects absent (1 m DTM).

**Do NOT claim:** "survival probability"; "validated"; "digital twin of the astronaut"; "AI-planned route"; "RL found the safest route" (A* generated the candidates; the adversary stress-tested them); "NASA uses adaptive stress testing for EVA" (no source found); "1,000 RL agents"; "the AI learned Mars physics" (the physics is written by us); anything about humanoid gait unless a humanoid exists; LLM-planned rover drives as RL; results from a cherry-picked seed.

**Safe wording:** "Adaptive Stress Testing (Lee et al., NASA Ames/Stanford, JAIR 2020) uses reinforcement learning to search a simulator for the most likely failure. We apply it to a physics-based walk model with documented bounds. We rank routes by how much has to go wrong to break them. Results are model-based, not crew-validated."

---

## 11. Risks and open questions

**Top risks:**
1. Hook work in `WalkEnv` takes longer than expected (per-walker route index, forced draws, likelihood). Mitigation: smoke test; fallback to CEM (same hooks) or Monte Carlo.
2. **Trivial result:** every route's most-likely failure is the same incapacitating fall. Mitigation: two configurations; failure-class table; choose headline from data.
3. **Unavoidable failures** and baseline fragility: v1 scripted baseline has 8.9 % stuck even nominally under random traits [R]. Mitigation: deterministic nominal-success gate; fix terrain noise at nominal for the adversary or make it a channel.
4. **Adversary exploits sim artefacts** (float32 rounding, blocked-move logic, `stuck` rule). Mitigation: replay in `sim.ts`, inspect top failures by eye, require physical plausibility.
5. PPO does not beat CEM (low-dimensional channel set). Mitigation: report honestly; keep CEM as headline if so.
6. Port/parity drift between `env.py` and `sim.ts` if the TS reference has changed since the 14 Nov build [I].
7. Windows/RTX pitfalls: driver too old for a fresh cu132 install; `torch.compile`/Triton errors. Mitigation: reuse working cu128 venv, eager mode.
8. Scope creep into Unreal (training, ONNX). Mitigation: JSON replay only.

**Questions only the team can answer:**
1. Is the old repo's `rl/` + `app/public/data/site` + `.venv` (torch cu128) present and runnable on the Windows laptop **tonight**, and does `sim.ts` (the parity reference) still match `env.py`? (This decides primary vs fallback in the first 30 minutes.)
2. Which demo scenario(s) and failure limits do you want to stand behind: is an incapacitating fall counted as a route failure, which dose threshold and shelter-rule deadline apply, and is the 0.15/km fall base rate (and the disturbance bounds in §9.2) acceptable to present as stated assumptions?

---

## 12. Sources

Fetched and read ([V]) unless marked:
- Lee et al., AST, JAIR 2020: https://jair.org/index.php/jair/article/view/12190 ; arXiv https://arxiv.org/abs/1811.02188 (full text read from PDF: Eq. 3, Eq. 6, Fig. 1, MCTS-SA, DAST, ACAS X); NTRS https://ntrs.nasa.gov/citations/20210018655
- Koren et al. 2019 (DRL vs MCTS): https://arxiv.org/abs/1902.01909 ; Corso et al. reward augmentation https://arxiv.org/pdf/1908.01046 [search] ; Go-Explore AST https://arxiv.org/pdf/2004.04292 [listing]; backward algorithm https://arxiv.org/abs/2107.12940 [listing]
- Corso et al. survey: https://arxiv.org/abs/2005.02979
- Pinto et al. RARL: https://arxiv.org/abs/1703.02702 ; Chow et al. CVaR: https://arxiv.org/abs/1512.01629
- Toolboxes: https://github.com/sisl/AdaptiveStressTestingToolbox (GitHub API, raw requirements.txt), https://github.com/sisl/POMDPStressTesting.jl
- NASA Ames AST for NN controllers (Julian, Lee, Kochenderfer): https://ntrs.nasa.gov/api/citations/20205003426/downloads/Julian%2CLee%2CKochenderfer-Validation%20of%20image-based%20neural%20network%20controllers%20through%20adaptive%20stress%20testing%20(2020).pdf [search]
- PyTorch 2.15: https://pytorch.org/blog/pytorch-2-15-release-blog/ ; https://dev-discuss.pytorch.org/t/pytorch-2-15-0-general-availability/3470 ; https://dev-discuss.pytorch.org/t/notice-cuda-12-6-wheels-will-no-longer-be-published-from-pytorch-2-15-drops-maxwell-pascal-volta/3432 ; https://download.pytorch.org/whl/cu132/torch/ and /cu134/torch/ (curl); https://pypi.org/pypi/torch/json (2.15.0, Python >=3.11)
- NVIDIA CUDA release notes (driver branches, 13.x compatibility floor 580): https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/index.html
- RTX 50 / sm_120 threads [S]: https://discuss.pytorch.org/t/nvidia-geforce-rtx-5070-ti-with-cuda-capability-sm-120/221509 ; https://discuss.pytorch.org/t/rtx-5070-ti-blackwell-pytorch-nightly-triton-still-getting-sm-120-is-not-defined-for-option-gpu-name-error/220460
- MPS float64 unsupported: https://discuss.pytorch.org/t/apple-m1-silicon-typeerror-cannot-convert-a-mps-tensor-to-float64-dtype/164655 [search]; MPS small-model overhead https://discuss.pytorch.org/t/sequential-throughput-of-gpu-execution/156303 [S]
- JAX install matrix: https://docs.jax.dev/en/latest/installation.html ; sb3-contrib https://pypi.org/pypi/sb3-contrib/json ; CleanRL https://github.com/vwxyzjn/cleanrl ; PufferLib https://github.com/PufferAI/PufferLib (no usable facts)
- Unreal: https://forums.unrealengine.com/t/learning-agents-pytorch-flexibility-and-non-policy-onnx-support/1726063 [S]; AMD Schola v2 https://gpuopen.com/learn/announcing-amd-schola-v2-nextgen-rl-unreal-engine/ ; UE 5.8 release coverage https://forums.unrealengine.com/t/unreal-engine-5-8-released/2729274 [S]; Epic docs pages JS-rendered, not readable by my tools
- EVA AI decision support (no RL): RASAGE https://bioastro.ucdavis.edu/rasage [S]
- Team files read: `scratchpad/zip_extract/research_notes/desktop_pivot/R2_rl_route_planning.md`, `R4_rl_design_review.md`, `.../Comparație idei misiune rapidă și canion/S2_rl_agents_feasibility.md`; `scratchpad/old_repo/rl/SPEC.md, SPEC_NAV.md, env.py, train_nav.py, train_ppo.py`; `old_repo/app/public/policy/policy.json`; `old_repo/HANDOFF.md`, `BUILD_LOG.md`; `/Users/stefandulgheru/projects/NASA/RESEARCH.md` §1, §3.
- Not read in full: `nav_env.py`, `eval_nav.py`, `export_policy.py`, `planner.py` (only grep/headers); I did not run any code.
