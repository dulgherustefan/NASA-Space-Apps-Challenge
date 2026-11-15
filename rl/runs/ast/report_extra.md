## Cross-check against the engine's walker

The stress test runs on the batched field-following simulator (`rl/ast_env.py`). The engine replays walkers with its own port of the same model that follows the drawn polyline (`engine/walk.py`). Plain Monte Carlo failure rates of both, same routes, same nominal disturbances (falls can be incapacitating):

| Scenario | Route | Engine walker (n = 20000) | Batched simulator |
|---|---|---|---|
| S1 | 0 Terrain shelter A | 0.575 % (fall 0.555 %, late 0.020 %) | 0.590 % (fall 0.591 %) |
| S1 | 1 Terrain shelter C | 2.645 % (fall 1.360 %, late 1.285 %) | 1.230 % (fall 1.213 %, late 0.018 %) |
| S1 | 2 Rover | 100.000 % (fall 2.080 %, late 97.920 %) | 100.000 % (fall 1.388 %, late 98.612 %) |
| S1 | 3 Habitat | 100.000 % (fall 3.250 %, late 96.750 %) | 100.000 % (fall 1.344 %, late 98.656 %) |
| S2 | 0 Rover | 19.720 % (fall 1.580 %, late 18.140 %) | 34.549 % (fall 1.719 %, late 32.830 %) |
| S2 | 1 Habitat | 100.000 % (fall 2.950 %, late 97.050 %) | 100.000 % (fall 1.758 %, late 98.242 %) |
| S3 | 0 Boulder and back, band-avoiding weights | 0.635 % (fall 0.535 %, stuck 0.100 %) | 0.520 % (fall 0.520 %) |
| S3 | 1 Boulder and back, standing weights | 0.850 % (fall 0.595 %, stuck 0.255 %) | 0.535 % (fall 0.535 %) |

Differences come from the path following (guidance field with a 53 m navigation offset applied to the believed position, against pure pursuit of the polyline) and are part of the model uncertainty.

## Sensitivity to the assumed disturbance scales (S1, random search + CEM restarts)

All Gaussian disturbance scales multiplied by 0.7 and 1.3 (stumble and injury probabilities unchanged). Robustness in nats per route index; `-` = infeasible without any disturbance, or no failure found above the search floor of -100 nats.

| Sigma scale | Configuration | Robustness per route (nats) | Order of the scored routes |
|---|---|---|---|
| x0.7 | `falls_penalty` | -, 13.03, -, - | 1 |
| x1.0 | `falls_penalty` | -, 4.39, -, - | 1 |
| x1.3 | `falls_penalty` | -, 3.12, -, - | 1 |
| x0.7 | `falls_terminal` | 7.98, 7.73, -, - | 0 > 1 |
| x1.0 | `falls_terminal` | 7.78, 4.76, -, - | 0 > 1 |
| x1.3 | `falls_terminal` | 7.76, 2.50, -, - | 0 > 1 |

- `falls_penalty`: the route order is the same across the three scales.
- `falls_terminal`: the route order is the same across the three scales.

## Trained adversaries on fresh seeds (S1)

Rollouts with random seeds never used in training (4096 per adversary, half with the mean action, half sampled). The adversary samples from a tilted distribution, so the count is of failures at least as plausible as a threshold, not a failure rate of the crew.

| Configuration | Route index | Seed | Best failure log-likelihood | Failures per 1000 rollouts with log p > -15 | Distinct failure sites (> 100 m apart or other class) | Plain Monte Carlo failure rate |
|---|---|---|---|---|---|---|
| `falls_terminal` | 0 | 0 | -8.30 | 1000.0 | 3 | 0.590 % |
| `falls_terminal` | 0 | 1 | -8.34 | 1000.0 | 2 | 0.590 % |
| `falls_terminal` | 0 | 2 | -8.33 | 1000.0 | 2 | 0.590 % |
| `falls_terminal` | 1 | 0 | -7.80 | 1000.0 | 2 | 1.230 % |
| `falls_terminal` | 1 | 1 | -7.73 | 1000.0 | 3 | 1.230 % |
| `falls_terminal` | 1 | 2 | -7.84 | 1000.0 | 3 | 1.230 % |
| `falls_penalty` | 0 | 0 | none | 0.0 | 0 | 0.000 % |
| `falls_penalty` | 0 | 1 | none | 0.0 | 0 | 0.000 % |
| `falls_penalty` | 0 | 2 | none | 0.0 | 0 | 0.000 % |
| `falls_penalty` | 1 | 0 | none | 0.0 | 0 | 0.019 % |
| `falls_penalty` | 1 | 1 | none | 0.0 | 0 | 0.019 % |
| `falls_penalty` | 1 | 2 | none | 0.0 | 0 | 0.019 % |

## Trained adversaries on fresh seeds (S2)

Rollouts with random seeds never used in training (4096 per adversary, half with the mean action, half sampled). The adversary samples from a tilted distribution, so the count is of failures at least as plausible as a threshold, not a failure rate of the crew.

| Configuration | Route index | Seed | Best failure log-likelihood | Failures per 1000 rollouts with log p > -15 | Distinct failure sites (> 100 m apart or other class) | Plain Monte Carlo failure rate |
|---|---|---|---|---|---|---|
| `falls_terminal` | 0 | 0 | -8.25 | 1000.0 | 6 | 34.549 % |
| `falls_terminal` | 0 | 1 | -8.22 | 999.8 | 6 | 34.549 % |
| `falls_terminal` | 0 | 2 | -8.64 | 1000.0 | 6 | 34.549 % |
| `falls_penalty` | 0 | 0 | -5.82 | 176.3 | 4 | 33.687 % |
| `falls_penalty` | 0 | 1 | -6.53 | 726.8 | 5 | 33.687 % |
| `falls_penalty` | 0 | 2 | -5.20 | 739.3 | 5 | 33.687 % |

## Trained adversaries on fresh seeds (S3)

Rollouts with random seeds never used in training (4096 per adversary, half with the mean action, half sampled). The adversary samples from a tilted distribution, so the count is of failures at least as plausible as a threshold, not a failure rate of the crew.

| Configuration | Route index | Seed | Best failure log-likelihood | Failures per 1000 rollouts with log p > -15 | Distinct failure sites (> 100 m apart or other class) | Plain Monte Carlo failure rate |
|---|---|---|---|---|---|---|
| `falls_terminal` | 0 | 0 | -10.26 | 991.0 | 2 | 0.520 % |
| `falls_terminal` | 0 | 1 | -10.29 | 980.7 | 4 | 0.520 % |
| `falls_terminal` | 0 | 2 | -10.27 | 997.6 | 2 | 0.520 % |
| `falls_terminal` | 1 | 0 | -10.29 | 994.9 | 3 | 0.535 % |
| `falls_terminal` | 1 | 1 | -10.05 | 992.9 | 6 | 0.535 % |
| `falls_terminal` | 1 | 2 | -10.23 | 998.8 | 2 | 0.535 % |

## Sensitivity of the PPO adversary to R_E (S1)

Separate short runs (100 updates, 26M simulator steps per adversary, three seeds each); the value is the best seed. The reward for a found failure is R_E; the best failure found moves by less than half a nat across the three values.

| R_E | Configuration | Robustness per route (nats, best seed) |
|---|---|---|
| 50 | `falls_terminal` | 7.95, 6.91, -, - |
| 100 | `falls_terminal` | 7.98, 6.50, -, - |
| 200 | `falls_terminal` | 8.00, 6.93, -, - |

