# Solway heavy-job server (optional)

A small HTTP service that runs large stress tests on the bundled HiRISE site (NE Melas Chasma, 4 x 4 km core)
with the authoritative Python engine: the planner and walk model of `engine/` (`engine/freeplan.py`,
`engine/routes.py`, `engine/stress.py`, `engine/walk.py`).

**The web app never depends on it.** Live web mode plans routes and runs its Monte Carlo in the browser. The server
is an extra the app may call for jobs too large for a browser tab (up to 20 000 walkers per route). If it is down,
slow or not configured, the app keeps working with its own results.

It is separate from the desktop engine (`python -m engine`, port 8765, which feeds the dashboard and Unreal). It does
not write to `runtime/`: its plan files go to a private temporary folder and no heatmap PNG is written.

## API

Points are **core metres** (docs/CONTRACT.md): `x` east and `y` south of the corner of the 4 x 4 km walk area,
both in `0..4000`. Add the core origin (`e0`, `s0` in `data/site/meta.json`) to get local metres.

`GET /health`

```json
{"ok": true, "site": "NE Melas Chasma (HiRISE DTM, 4 x 4 km core)", "version": "Solway engine 0.2, server 1",
 "warm_s": 1.5, "n_max": 20000, "jobs": 0, "error": null}
```

`POST /stress`

```json
{"start": [2200, 1400], "goal": [1700, 2600], "n": 2000, "incident": null}
```

| Field | Meaning |
|---|---|
| `start`, `goal` | `[x, y]` core metres, finite, inside the walk area, not on blocked ground, at least 15 m apart |
| `n` | Monte Carlo walkers per candidate route, 1..20000, default 2000 |
| `incident` | `null`: nominal pace, no storm. `"storm"`: solar storm at onset (as scenario sep-1): brisk pace, arrival after the 30-minute shelter rule counts as a failure, dose from the onset. `"quake"`: rockfall runout band active (as scenario quake-1), brisk pace |

Response (one entry per candidate route; the planner tries the hazard weights as they stand and, when the rockfall
band is standing, a variant clear of the band, kept only if its path differs):

```json
{"ok": true, "engine": "python", "engine_version": "0.2", "method": "mc", "incident": null, "n": 2000,
 "start": [2200.0, 1400.0], "goal": [1700.0, 2600.0], "recommended": 0, "compute_ms": 1416.0,
 "frame": "core metres x east, y south, z MOLA",
 "routes": [{"id": 0, "label": "Direct", "status": "tested", "time_s": 2890.0, "length_m": 1366.8,
             "ascent_m": 0.1, "max_slope_deg": 17.5, "o2_margin": 0.727, "heat_margin": 0.822, "dose_msv": 0.0192,
             "rule_ok": true, "rule_reasons": [],
             "fail_rate": 0.005, "ci95": [0.0027, 0.0092], "n": 2000,
             "classes": {"fall": 0.005, "heat": 0.0, "oxygen": 0.0, "late": 0.0, "stuck": 0.0},
             "arrival_s": {"p10": 3040.0, "p50": 3170.0, "p90": 3350.0},
             "failures": [{"cls": "fall", "x": 2102.1, "y": 1696.5, "t": 740.0, "summary": "..."}],
             "polyline": [[2200.0, 1400.0, -3236.9], "... at most 400 points [x, y, z]"]}]}
```

`ci95` is the Wilson 95 % interval of `fail_rate` (`engine/stress.py`). `time_s` is the nominal (undisturbed) walk.

Errors: `400` for a bad body (with the reason in `detail`), `422` when no walkable route joins the two points,
`503` while the site is still loading. CORS allows every origin for GET and POST. One job runs at a time; others wait.

## Run locally

From the repository root (port 8765 is the desktop engine's; use another one):

```powershell
.venv\Scripts\python.exe -m uvicorn server.app:app --port 8790
```

```bash
curl http://127.0.0.1:8790/health
curl -X POST http://127.0.0.1:8790/stress -H "Content-Type: application/json" \
     -d '{"start": [2200, 1400], "goal": [1700, 2600], "n": 500}'
```

Measured on the team laptop (warm kernels): n = 500 about 1.1 s, n = 2000 about 1.4 s, n = 20 000 about 3.3 s per
request, single candidate route. Start-up (site load and kernel warm-up from the numba cache) about 1.5 s.

## Docker

The build context is the repository root; `server/Dockerfile.dockerignore` keeps the context small.

```bash
docker build -f server/Dockerfile -t solway-server .
docker run --rm -p 7860:7860 solway-server
```

The image holds only what the server reads: `engine/`, `rl/planner.py`, `rl/terrain.py`, four files of `data/site/`,
`data/scenario/`, `unreal_import/import_values.json` and `server/`. No torch. The numba kernels are compiled during
the build. `PORT` overrides the listening port (default 7860).

## Deploy to Hugging Face Spaces (Docker Space)

The team needs a Hugging Face account first (free tier, CPU basic is enough).

1. On huggingface.co: New Space, SDK **Docker**, blank template, hardware CPU basic, public.
2. Assemble the Space folder (Dockerfile at its root, same layout as the repository), from the repository root:

   ```powershell
   $d = "..\solway-space"
   New-Item -ItemType Directory -Force $d\rl, $d\data\site, $d\unreal_import | Out-Null
   Copy-Item -Recurse engine, server, $d
   Copy-Item -Recurse data\scenario $d\data
   Copy-Item rl\planner.py, rl\terrain.py $d\rl
   Copy-Item data\site\meta.json, data\site\core_h.bin.gz, data\site\core_layers.bin.gz, data\site\reg_h.bin.gz $d\data\site
   Copy-Item unreal_import\import_values.json $d\unreal_import
   Copy-Item server\Dockerfile $d\Dockerfile
   Get-ChildItem -Recurse -Directory -Filter __pycache__ $d | Remove-Item -Recurse -Force
   ```

3. Give the Space folder a `README.md` with the Space header (Hugging Face reads `sdk` and `app_port` from it):

   ```yaml
   ---
   title: Solway heavy jobs
   sdk: docker
   app_port: 7860
   ---
   ```

4. Upload with the Hugging Face CLI (`pip install -U huggingface_hub`, then `hf auth login` with a write token).
   It handles the binary `.bin.gz` files, which a plain `git push` to a Space rejects:

   ```bash
   hf upload <team>/<space> ../solway-space . --repo-type space
   ```

5. The Space builds and starts on its own. Its URL is `https://<team>-<space>.hf.space`:

   ```bash
   curl https://<team>-<space>.hf.space/health
   ```

A free Space sleeps after a period without requests and takes a minute or so to wake; the web app must treat the
server as optional and fall back to its in-browser results.
