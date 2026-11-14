# Contract between the three processes

Version 0.1, 14 Nov 2026. Change it only with a note to everyone who builds against it.

```
engine (Python, authority)
   ├── WebSocket  ws://127.0.0.1:8765      → dashboard (Electron)
   ├── OSC / UDP  127.0.0.1:9000           → simulation (Unreal)
   └── files      runtime/                 → both
```

Port 8000 belongs to the Unreal editor's MCP server. The engine never binds it.

## 1. Coordinates

All positions are **local metres**: `e` east and `s` south of the origin in `data/site/meta.json`
(`origin.lon`, `origin.lat`), plus `z` = elevation in metres (MOLA datum, from the DTM).

| Grid | Origin (e0, s0) | Size | Cell |
|---|---|---|---|
| core (EVA box) | 1650, 6600 | 4000 × 4000 m | 2.5 m render, 5 m analysis (800 × 800) |
| region | −1008, −12000 | 9216 × 28224 m | 16 m |

Analysis cell `(row i, col j)` has its centre at `e = e0 + (j + 0.5) · 5`, `s = s0 + (i + 0.5) · 5`.

Unreal (centimetres, left-handed, Z up):

```
X = e · 100
Y = s · 100
Z = (z − Z_REF) · 100        Z_REF is in unreal_import/import_values.json
```

Image columns run east, rows run south, so textures need no flip.
Heading is degrees clockwise from north; Unreal yaw = heading − 90.

## 2. Engine → dashboard (WebSocket, JSON, one object per message)

Every message has `type` and `t` (mission seconds).

| type | When | Payload |
|---|---|---|
| `hello` | on connect | `product`, `version`, `site` (meta subset), `scenario` (incident list with planned times) |
| `snapshot` | 10 Hz | `clock` {t, sol, lmst, speed, paused}, `phase` (`detect` \| `assess` \| `simulate` \| `respond` \| `idle`), `crew` [{id, e, s, z, heading, pace, o2, heat, dose, status}], `sensors` {dose_rate, seismic, tau} |
| `incident` | when one fires | `id`, `kind` (`sep` \| `quake` \| `dust` \| `science`), `title`, `source` (citation), `scenario` (true if not an observation), `params` |
| `assessment` | after an incident | `incident_id`, `changes` [{label, value, unit, source, kind}], `overlays` [{layer, file}], `shelters` [{id, name, e, s, open, reason}] |
| `routes` | after planning | `incident_id`, `file` (`runtime/routes.json`), `routes` [{id, shelter, length_m, time_s, ascent_m, max_slope, o2_margin, heat_margin, dose, robustness_nats, mc_fail_rate, status}] |
| `stress` | per route, as results load | `route_id`, `robustness_nats`, `failures` [{class, e, s, t, log_p, events}], `heatmap` (file), `method` (`ppo-ast` \| `cem` \| `mc`) |
| `decision` | when a route is chosen | `route_id`, `reasons` [..], `avoided` [..], `time_to_shelter_s`, `margins` {o2, heat, dose} |
| `log` | any time | `level`, `text`, `source` |

`kind` on a number is one of `measured`, `model`, `requirement`, `assumption`, `scenario`. The dashboard shows it next to the value.

Dashboard → engine (same socket): `{"cmd": "start" | "pause" | "resume" | "reset" | "speed" | "trigger" | "choose" | "cue", ...}`.

## 3. Engine → Unreal (OSC over UDP)

| Address | Arguments | Rate |
|---|---|---|
| `/clock` | `t` f, `speed` f, `sun_az` f, `sun_el` f | 2 Hz |
| `/crew` | `id` i, `e` f, `s` f, `z` f, `heading` f, `pace` f, `status` i | 20 Hz |
| `/agent` | `route` i, `id` i, `e` f, `s` f, `z` f, `heading` f, `status` i | 20 Hz, only during Simulate |
| `/incident` | `kind` s, `phase` s, `intensity` f, `e` f, `s` f | on change |
| `/overlay` | `layer` s, `opacity` f | on change (file is `runtime/overlay_<layer>.png`) |
| `/reload` | `what` s (`routes` \| `trajectories` \| `overlay`) | after the engine writes a file |
| `/cue` | `name` s, `duration` f | camera cues: `overview`, `follow`, `wall`, `shelter`, `failure` |
| `/route` | `id` i, `state` s (`candidate` \| `testing` \| `failed` \| `chosen` \| `hidden`) | on change |

`status`: 0 walking, 1 idle, 2 stumbled, 3 incapacitated, 4 heat, 5 oxygen, 6 arrived, 7 late.

## 4. Files in `runtime/`

`routes.json`

```json
{"incident_id": "sep-1", "routes": [
  {"id": 0, "shelter": "A", "points": [[e, s, z], ...], "time_s": 780, "length_m": 912}
]}
```

`trajectories.json` (stress-test replays; one entry per virtual crew)

```json
{"dt": 10, "runs": [
  {"route": 0, "id": 3, "outcome": "incapacitated", "log_p": -8.1,
   "samples": [[e, s, z, heading, status], ...],
   "events": [{"t": 410, "channel": "stumble", "value": 1, "log_p": -4.4}]}
]}
```

`overlay_<layer>.png`: 800 × 800 RGBA over the core box, straight alpha, already coloured by the engine.
Layers: `hazard`, `slope`, `rockfall`, `sand`, `sky`, `dose`, `failures`.

## 5. Precomputed inputs (in git)

`data/site/` terrain and hazard layers, `data/scenario/*.json` incident scripts,
`data/ast/` stress-test results from the Windows training run (`ast_results.json`, `ast_training.json`,
`ast_baselines.json`, `ast_heatmap_<scenario>_<route>.png`).

The demo plays from these files. Nothing is fetched at run time.
