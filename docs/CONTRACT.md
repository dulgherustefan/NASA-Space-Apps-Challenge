# Contract between the three processes

Version 0.2, 14 Nov 2026. Change it only with a note to everyone who builds against it.

```
engine (Python, authority)
   ├── WebSocket  ws://127.0.0.1:8765/ws   → dashboard (Electron)
   ├── HTTP       http://127.0.0.1:8765/files/<repo path>   (read-only: runtime/, data/site/, data/ast/)
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
A client that connects late gets `hello`, then every `incident`, `assessment`, `routes`, `stress` and `decision` message sent since the last reset, in order.

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

## 6. Message examples (normative: field names and units)

Positions are local metres. Fractions are 0..1. `kind` on any number: `measured`, `model`, `requirement`, `assumption`, `scenario`.

```json
{"type":"hello","t":0,"product":"Solway","version":"0.2",
 "site":{"name":"NE Melas Chasma","lat":-10.0,"lon":-69.0,"core":{"e0":1650,"s0":6600,"size":4000},"z_ref":-3148.992,
         "ortho":"data/site/core_ortho.webp"},
 "places":[{"id":"S","name":"Science site","kind":"site","e":4450,"s":8100,"z":-3301.2},
           {"id":"H","name":"Habitat","kind":"habitat","e":2350,"s":9900,"z":-3310.0},
           {"id":"R","name":"Rover","kind":"rover","e":3350,"s":9200,"z":-3305.0},
           {"id":"A","name":"Overhang A","kind":"shelter","e":4248,"s":8458,"z":-3290.0}],
 "scenario":[{"id":"sep-1","kind":"sep","title":"Solar particle event","at_s":60},
             {"id":"quake-1","kind":"quake","title":"Marsquake","at_s":420},
             {"id":"sci-1","kind":"science","title":"Fresh boulder","at_s":900}]}

{"type":"snapshot","t":134.2,
 "clock":{"t":134.2,"sol":1,"lmst":"14:49:02","utc":"2026-11-15T07:02:14Z","speed":8,"paused":false},
 "phase":"assess","incident_id":"sep-1",
 "crew":[{"id":0,"name":"EV1","e":4450.0,"s":8100.0,"z":-3301.2,"heading":212.0,"pace":1.1,
          "o2":0.82,"heat":0.31,"dose":0.004,"status":0}],
 "sensors":{"dose_rate":12.4,"seismic":0.02,"tau":0.6},
 "light_time_s":656.7}

{"type":"incident","t":60,"id":"sep-1","kind":"sep","title":"Solar particle event",
 "summary":"Dose rate rising. Peak expected within 53 minutes.",
 "source":"Loewe et al. 2025, arXiv:2502.02469, Table 1 (MSL RAD, 20 May 2024)","scenario":true,
 "e":null,"s":null,
 "params":[{"label":"Time to peak","value":53,"unit":"min","kind":"measured","source":"arXiv:2502.02469"}]}

{"type":"assessment","t":64,"incident_id":"sep-1",
 "changes":[{"label":"Shelter rule","value":30,"unit":"min","kind":"requirement","source":"..."}],
 "overlays":[{"layer":"sky","file":"runtime/overlay_sky.png","label":"Open sky (unshielded)"}],
 "shelters":[{"id":"A","name":"Overhang A","e":4248,"s":8458,"open":true,"reason":""}]}

{"type":"routes","t":68,"incident_id":"sep-1","file":"runtime/routes.json",
 "routes":[{"id":0,"shelter":"A","label":"Overhang A","length_m":912,"time_s":780,"ascent_m":35,"max_slope":18.2,
            "o2_margin":0.61,"heat_margin":0.44,"dose":0.8,
            "robustness_nats":null,"mc_fail_rate":null,"status":"candidate"}]}

{"type":"stress","t":80,"incident_id":"sep-1","route_id":0,"method":"cem","source":"data/ast",
 "robustness_nats":7.9,"mc_fail_rate":0.012,"mc_ci":[0.008,0.018],"n":20000,
 "failures":[{"class":"heat","e":4300,"s":8350,"t":410,"log_p":-8.1,
              "summary":"Cooling at 0.71 for 6 min on the 14 degree climb",
              "events":[{"t":300,"channel":"cooling","value":0.71,"log_p":-3.2}]}],
 "heatmap":"runtime/overlay_failures.png"}

{"type":"decision","t":95,"incident_id":"sep-1","route_id":1,"shelter":"C","auto":true,
 "reasons":["Highest robustness of the routes inside the 30-minute rule"],
 "avoided":[{"label":"Rockfall runout band","detail":"Route 0 crosses 140 m of it"}],
 "time_to_shelter_s":820,"margins":{"o2":0.58,"heat":0.40,"dose":0.9}}

{"type":"log","t":96,"level":"info","text":"Crew EV1 moving to Overhang C","source":"engine"}
```

Units: `o2` usable oxygen left, `heat` stored heat as a fraction of the failure limit, `dose` cumulative mSv on this walk,
`dose_rate` in uGy/h, `seismic` ground acceleration in m/s2, `tau` dust optical depth, margins = fraction left on arrival.
Route `status`: `candidate`, `testing`, `tested`, `rejected`, `chosen`, `infeasible`.
`stress.method`: `ppo-ast`, `cem`, `mc`. `stress.source`: `data/ast` (trained offline) or `local preview` (small Monte Carlo run by the engine).
`failure.class`: `fall`, `heat`, `oxygen`, `late`, `stuck`.

Commands (dashboard to engine, same socket):

```json
{"cmd":"start"} {"cmd":"pause"} {"cmd":"resume"} {"cmd":"reset"} {"cmd":"speed","value":8}
{"cmd":"trigger","id":"quake-1"} {"cmd":"choose","route_id":1} {"cmd":"cue","name":"wall"} {"cmd":"demo"}
```

`demo` plays the three incidents back to back with fixed pacing (about 90 s of wall time).
The product name is sent in `hello.product`; nothing else hard-codes it.
