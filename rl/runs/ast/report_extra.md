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
| S3 | 0 Boulder and back, band-avoiding weights | 0.635 % (fall 0.535 %, stuck 0.100 %) | not run |
| S3 | 1 Boulder and back, standing weights | 0.850 % (fall 0.595 %, stuck 0.255 %) | not run |

Differences come from the path following (guidance field with a 53 m navigation offset applied to the believed position, against pure pursuit of the polyline) and are part of the model uncertainty.

