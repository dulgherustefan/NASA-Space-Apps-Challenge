# Solway

Solway is an incident-response aid for crews on foot on the Martian surface. It is meant for a crew member or a
planner who has to decide, with little time and no help from Earth, where to walk when something goes wrong during an
extravehicular walk. A message to Earth and back takes about 22 minutes in November 2026 (from JPL Horizons
distances) and up to about 44 minutes at the longest. The demo is set in north-east Melas Chasma (about 10.0°S, 290.04°E)
on real HiRISE and CTX terrain.

It was made for the NASA Space Apps Challenge 2026, challenge "Interplanetary Survival Guide: Martian Map".
It is not affiliated with or endorsed by NASA, and it is a planning aid only. Nothing here has been tested with a crew.

![The Solway dashboard during the solar particle event scenario](docs/img/dashboard.png)

The dashboard during the scripted solar particle event: the incident, what changed on the hazard map, the stress-tested
routes and the chosen one. Every figure is labelled as measured, model, requirement, assumption or scenario.

![The 3D view: two crew members walk the chosen route](docs/img/scene.jpg)

The 3D view: the crew walks the chosen route on the HiRISE terrain, with the rover and the habitat marked ahead.
The terrain colour is approximate, and the dust is set dressing.

## How it works

An incident goes through four phases.

1. **Detect.** A scripted incident fires on the mission clock, or after the crew has walked for a set time. It appears
   with its source and a flag that says it is a scenario, not an observation.
2. **Assess.** The engine updates the hazard layers over the 4 × 4 km core box (800 × 800 cells of 5 m): combined hazard,
   slope, rockfall runout band, loose-sand likelihood, blocked sky, dose rate in the open, and where virtual crews failed.
   Shelters that fall inside an active rockfall band are closed.
3. **Simulate.** A grid planner (goal-rooted Dijkstra on the 5 m grid) proposes candidate routes from the crew to each
   open shelter. Each route is then stress-tested with a walk model of one suited walker (pace, stored heat, oxygen,
   falls, dose). The result is a failure rate from Monte Carlo runs with its confidence interval. When results of an
   Adaptive Stress Testing run (Lee et al., 2020) are present in `data/ast/`, the engine also reports a robustness
   figure in nats and the most likely failures. In that method a reinforcement-learning adversary searches the
   disturbances (weaker suit cooling, stumbles, navigation drift) for the most likely way a route fails. The adversary
   tests routes. It does not choose them, and the virtual crews follow the planner's polyline.
4. **Respond.** The engine marks one route as chosen, or the operator picks one. Among the routes that meet the
   incident's rule it prefers the highest robustness when that exists, otherwise the lowest failure rate. If none meets
   the rule it falls back to the fastest route or the lowest failure rate (`Director._choose`). The dashboard
   shows time to shelter, oxygen, heat and dose margins on arrival, and the hazards avoided. Every number carries a kind
   (`measured`, `model`, `requirement`, `assumption`, `scenario`) and a source.

The demo plays three linked scenario incidents (`data/scenario/`):

| Id | Incident | What happens |
|---|---|---|
| `sep-1` | Solar particle event | Timing follows the 20 May 2024 event seen by the MSL RAD instrument. The crew walks to a shelter under a 30-minute rule. |
| `quake-1` | Marsquake | The rockfall runout band below the wall becomes active, shelters inside it close, routes are planned again from where the crew is. |
| `sci-1` | Fresh boulder | One sol later, no storm. A sortie from the rover to a fresh boulder and back, with the runout band as a hazard. |

## Architecture

Three processes on one machine. The Python engine is the authority: it owns the mission clock, the scenario, the hazard
layers, the routes and the stress-test results. The two windows display what the engine sends.

```
                    WebSocket + HTTP, 127.0.0.1:8765
  dashboard  <------------------------------------------>  engine (Python)
  (Electron + React)        commands go back on the socket      |   |
                                                                |   |  files in runtime/
                                       OSC over UDP, 127.0.0.1:9000 |  (routes.json, trajectories.json,
                                                                |   |   overlay_<layer>.png)
                                                                v   v
                                                  simulation window (Unreal Engine 5.8)

  data/site, data/scenario, data/ast  --->  engine   (precomputed inputs, read at start)
```

| Part | What it does | Technology | Port |
|---|---|---|---|
| Engine | Clock, scenario, hazards, route planning, stress tests; serves the dashboard and sends OSC | Python 3.12, numpy, numba, FastAPI, uvicorn, python-osc | 8765 (HTTP and WebSocket `/ws`), sends to UDP 9000 |
| Dashboard | The product: four columns (Detect, Assess, Simulate, Respond), tactical map, method, parameters, decision log, sources | Electron, Vite, React 19, Tailwind 4, Recharts | dev server 5173 |
| Simulation | Real terrain in 3D, crew, hazard overlays, routes, marsquake effects, cameras | Unreal Engine 5.8, project `unreal/MelasSim` | listens on UDP 9000 |
| Adversary training (optional) | Trains the stress-test adversary offline on another machine and writes `data/ast/` | Python, PyTorch | none |

Port 8000 belongs to the Unreal editor's MCP server (off unless the editor is started with `-ModelContextProtocolStartServer`).
The engine never uses it. The dashboard does not start the Unreal window; start it yourself (`unreal/README.md`).
Messages, OSC addresses, coordinates and file formats are defined in `docs/CONTRACT.md`.
The demo plays from saved files. Nothing is fetched from the network at run time.

## Run it

Requirements: Python 3.12 with [uv](https://docs.astral.sh/uv/), Node.js with npm for the dashboard, and Unreal Engine 5.8
for the 3D window. `uv` creates the environment on first run.

### Engine

```
uv run python -m engine
```

Serves on `127.0.0.1:8765` and sends OSC to `127.0.0.1:9000`. The first start compiles the numba kernels, later starts are faster.

| Flag | Effect |
|---|---|
| `--no-osc` | Do not send OSC |
| `--demo` | Start the three-incident demo immediately |
| `--check` | Play the whole scenario without sockets, print a summary, exit 1 on inconsistency |
| `--port PORT` | HTTP and WebSocket port (default 8765) |
| `--walkers N` | Monte Carlo walkers per route (default from the engine parameters) |

The OSC target is fixed at `127.0.0.1:9000` in `engine/osc.py`. Tests: `uv run pytest`.

### Dashboard

```
cd dashboard
npm install
npm run dev
```

`npm run dev` starts Vite and Electron for development and does not start the engine, so run the engine in another terminal.
To run the built app, use `npm run build` and then `npm start`; Electron then starts the engine itself with
`uv run python -m engine` from the repository root.

| Script | Effect |
|---|---|
| `dev` | Vite and Electron, development |
| `dev:web` | Vite only, open `http://127.0.0.1:5173` in a browser |
| `mock` | Mock engine on port 8766 for working on the dashboard without the real engine |
| `typecheck` | TypeScript check |
| `build` | Type check and production build into `dist/` |
| `preview` | Preview the production build |
| `start` | Electron on the built files (starts the engine) |
| `dist` | Build and package with electron-builder (unpacked directory per platform) |
| `shots` | Screenshots of the dashboard against the mock engine |

Environment variables: `VITE_ENGINE_URL` (default `ws://127.0.0.1:8765/ws`), `SOLWAY_ROOT` (repository root for the engine),
`SOLWAY_ENGINE=external` (do not start an engine from Electron).
The dashboard has five pages: Console, Method, Parameters, Log (decision log with JSON export) and Sources.
The **Run demo** button plays the three incidents.

### Simulation window

See `unreal/README.md`. In short: open `unreal/MelasSim/MelasSim.uproject` in Unreal Engine 5.8, run the director script in the
editor, press Play, then start the demo from the dashboard.

### Stress-test training (optional)

The adversary is trained on a separate machine; the task is in `rl/TASK.md`. If `data/ast/ast_results.json` exists, the
engine serves its numbers with source `data/ast`. Otherwise the engine runs a small local Monte Carlo and labels it
"local preview". In this checkout `data/ast/` is empty, so the engine uses the local preview.

## Repository map

| Path | What |
|---|---|
| `engine/` | The Python engine: clock, scenario, hazards, routes, walk model, stress tests, WebSocket server, OSC |
| `dashboard/` | Electron and React dashboard, mock engine, screenshot scripts |
| `unreal/` | Unreal project `MelasSim` and the editor scripts that build and drive the scene |
| `rl/` | Route planner and walk environment used by the engine, the training task for the adversary (`TASK.md`, `SPEC.md`), earlier walking-policy trainer |
| `tools/` | Scripts that turn `data/site/` into files for Unreal (heightmaps, meshes, scene layout, dust texture) |
| `pipeline/` | `10_build_site.py`: builds the terrain and hazard grids in `data/site/` from the NASA and USGS rasters |
| `data/site/` | Processed terrain, orthoimages and hazard layers, with `meta.json` |
| `data/scenario/` | Scripted incidents and mission (`mission.json`, `sep-1.json`, `quake-1.json`, `sci-1.json`) |
| `data/ast/` | Stress-test results from the offline run (empty in this checkout) |
| `data/exploration_zones_2015.txt` | Text of the first announcement of the 2015 landing-site and exploration-zone workshop, kept as background |
| `runtime/` | Files the engine writes while running (routes, trajectories, overlays, parameters) |
| `unreal_import/` | Generated inputs for Unreal (heightmaps, drape textures, meshes, scene layout) |
| `docs/` | `CONTRACT.md` (interfaces) and `research/` (design notes, partly in Romanian) |
| `reference/` | Earlier TypeScript engine and first walking policy, kept as reference for the Python ports |
| `tests/` | Engine tests |
| `assets_src/` | Raw 3D models and textures with a `SOURCE.txt` each (not in git) |
| `ASSETS.md`, `LICENSE` | Credits and licences, Apache 2.0 |

`pipeline/10_build_site.py` needs the extras `uv sync --extra pipeline` and raw files in `data_raw/` (not in git). It reads the
CTX DTM over the network. As written it writes to `app/public/data/site/`; copy the result into `data/site/`.
The `rl/` modules still mention the old `app/` paths in their docstrings. The engine reads `data/site/`.

## Data sources

All terrain comes from NASA Mars Reconnaissance Orbiter data distributed by USGS Astrogeology
(see `data/site/meta.json` and `ASSETS.md` for credit lines and licences).

| Dataset | Exact name | Used for |
|---|---|---|
| HiRISE DTM, 1 m | `DTEEC_028857_1700_028923_1700_A01` (USGS STAC collection `mro_hirise_socet_dtms`) | Core box elevation. Slope, roughness, rockfall reach angle, blocked sky, pits and the walk model are derived from it. |
| HiRISE orthoimage, 1 m, RED | `ESP_028857_1700_RED_C_01_ORTHO` | Greyscale base image of the map and the 3D terrain. |
| CTX DTM | `D04_028857_1684_XN_11S069W` and `D04_028923_1684_XN_11S069W` (USGS STAC collection `mro_ctx_controlled_usgs_dtms`) | Regional strip (16 m cells) and far backdrop (80 m cells); also fills the region orthoimage where HiRISE has no data. |
| JPL Horizons | Sun azimuth and elevation at the site, 06:00 to 12:00 UT on 15 Nov 2026; Earth to Mars distance for 15 and 16 Nov 2026 | Sun direction in the 3D scene and the Earth to Mars light time. Outside that window the engine uses the Mars24 algorithm (Allison and McEwen, 2000). |
| MSL RAD, event of 20 May 2024 | Löwe et al. 2025, arXiv:2502.02469, Table 1 | Solar particle event: 53 min to peak, 57 min nowcast lead time, 1730.55 µGy recorded. The unshielded dose of 8100 µGy for an astronaut is credited to NASA/JPL (10 Jun 2024) in `sep-1.json`. |
| MSL RAD background | Hassler et al. 2014, Science 343 | Background dose rate. |
| InSight Mars Seismic Catalogue | MQS V14, doi 10.12686/a21 | The scenario marsquake is described as comparable to event S0976a. The quake itself is scripted. |
| Rockfall papers | Grindrod et al. 2021 (reach angle 27.8°); Vijayan et al. 2026 (rockfall after a marsquake at Cerberus Fossae) | Rockfall runout band and the post-quake rockfall rate. |
| NASA technical reports | NTRS 20210000827 (exploration EVA testing and analogs), NTRS 20220004017 (HRP evidence report on EVA), NTRS 19730008098 (Apollo 16 time and motion study), NTRS 20160001058 (suit cooling without sweep gas) | Planning speed, slope limit, heat and oxygen limits, the suit cooling floor used in the disturbances. Each value and its source is listed in `engine/params.py` and on the Parameters page. |
| Adaptive Stress Testing | Lee et al. 2020, Journal of Artificial Intelligence Research 69 | The stress-test method. |

Surface colour is not from a dataset: the orthoimage is greyscale and the colour is an approximate tint added in `pipeline/10_build_site.py`.

## Modelled and real

Real data: elevation from the HiRISE and CTX DTMs, the greyscale orthoimage, Sun position and light time from Horizons,
and the published figures listed above.

Derived from real data by our own models, not measured: slope, roughness, the rockfall runout band
(an energy-line cone from every source cell steeper than 32°, reach angle 27.8°), blocked sky and dose shielding, closed
depressions, and the loose-sand layer, which is a proxy from image brightness and smoothness.

Modelled: the walking and consumables model (speed, soil slowdown, metabolic rate, stored heat against the suit cooling
limit, oxygen use, falls, dose), the disturbances applied in the stress test, and all margins and failure rates. Each
parameter is in `engine/params.py` with its kind and source.

Scripted: the incidents and their timing, the crew, the places (science site, habitat, rover, shelters, boulder). The
solar profile is idealised (linear rise, exponential decay). The Melas marsquake is a scenario.

Set dressing in the 3D window, not simulation output: dust, the dust devil and the scout helicopter, the seismic station,
the Earth rock scans and ground textures, and the positions of boulders in the rockfall band (seeded and illustrative).

## Limitations

- One site and three scripted incidents. Planning for another place needs new terrain data and a new scenario.
- Results are model-based. Fall rate, fall injury chance, suit mass, the sand penalty and the disturbance bounds are team assumptions.
- The stress test is only as good as the walk model. If `data/ast/` is empty, failure rates come from a small local Monte Carlo and there is no robustness figure.
- High-resolution elevation covers the 4 × 4 km core box. Beyond it the terrain is CTX with coarser cells. `data/site/meta.json` records a CTX offset of 10.9 m and a residual RMS of 38.6 m against the HiRISE DTM.
- The slope limit is a requirement borrowed from lunar suits, not established for Mars. The sand layer is an image proxy.
- The marsquake is a scenario at Melas Chasma. The rockfall response it uses was observed at Cerberus Fossae.
- Surface colour is approximate. Ground detail and rocks in 3D are Earth scans.
- The 3D window runs inside the Unreal editor with a Python director script. No packaged build is included.
- It has not been checked for operational use and does not replace a crew's judgement or mission control.

## Licence and credits

Code: Apache License 2.0, see `LICENSE`. Credits for terrain data, 3D models, textures, fonts and libraries, with authors,
sources and licences: `ASSETS.md`. No NASA logos or insignia are used.
