# Simulation window (Unreal Engine 5.8)

`MelasSim/` is the Unreal project. It shows the real terrain of the demo site and plays what the Solway engine sends over
OSC. The engine is the authority; this window only displays. Interfaces are in `../docs/CONTRACT.md`.

The project has no C++ source, so it opens without a compile step. The scene is built and driven by Python scripts in
`scripts/`. The 3D window is the Unreal editor in Play mode with the director script running; no packaged build is included.

## Requirements

- Unreal Engine 5.8 (`EngineAssociation` is `5.8` in `MelasSim/MelasSim.uproject`).
- Plugins enabled by the project: `PythonScriptPlugin`, `EditorScriptingUtilities`, `OSC`, `Niagara`, `GeometryScripting`, `PCG`,
  `JsonBlueprintUtilities`, `HttpBlueprint`, `ModelContextProtocol`, `AllToolsets`.
- Developed on macOS (Metal SM6) and checked on Windows 11 with DirectX 12 SM6 (`Config/DefaultEngine.ini`): on a laptop
  RTX 5070 Ti the Play window holds about 60 frames a second at 1920 × 1080 with the GPU close to fully used.
- For the full rebuild: `uv` and the repository's Python environment (the `tools/` scripts), and `assets_src/` (raw models and
  textures, not in git).

## Open the project

Open `unreal/MelasSim/MelasSim.uproject` with Unreal Engine 5.8 (double-click it, or choose it in the Epic Games Launcher / Unreal
Project Browser). The default and startup map is `/Game/Maps/Melas`. The first open compiles shaders and can take a while.

## What is in the project

| Path | What |
|---|---|
| `/Game/Maps/Melas` | The level: Mars sun, atmosphere, sky light, haze, exposure, terrain, markers, props, crew, cameras |
| `/Game/Terrain/Meshes` | Nanite terrain meshes: `SM_Core_00` to `SM_Core_33`, `SM_Region_0` to `3`, `SM_Far_0` |
| `/Game/Terrain/Textures` | Orthoimage (tinted, and the colour version the material uses) and luminance drapes for the core and region tiers |
| `/Game/Terrain/Ground` | Three tiling ground textures (Poly Haven, CC0): diffuse, normal, AO/rough/metal, and the height maps of two of them |
| `/Game/Terrain` | `M_Terrain` and one instance per tier (`MI_Terrain_Core`, `MI_Terrain_Region`, `MI_Terrain_Far`) |
| `/Game/Markers`, `/Game/FX` | Marker and beam materials, dust sprite material and texture, rotor material |
| `/Game/Props/Habitat`, `Rover` | NASA Habitat Demonstration Unit and Space Exploration Vehicle |
| `/Game/Props/Suit`, `InSight`, `Ingenuity` | NASA Z-2 suit (static model and the suit material), InSight lander (seismic station), Ingenuity (scout helicopter) |
| `/Game/Props/CrewRig` | The Z-2 suit as a skeletal mesh with eight animation clips (idle, idle talk, walk, stumble, collapse, kneel, crouch, work): the crew |
| `/Game/Props/Astronaut`, `Crew` | Rigged astronaut (Quaternius, CC0) and a copy. `build_scene.py` does not place them. |
| `/Game/Props/Rocks` | Nine scanned rocks (Poly Haven, CC0) |
| `Content/Python/init_unreal.py` | Start-up hook: starts the director by itself when `SOLWAY_AUTOSTART=1` is set, otherwise does nothing |

Authors, sources and licences are in `../ASSETS.md`.

## Scripts and the order to run them

Run from the repository root unless noted. `<UE>` is the Unreal Engine install folder and `<repo>` the repository.
The Unreal project already contains the imported assets, so these steps are only needed to rebuild it.

**1. Make the input files** (Python, no editor):

| Command | Writes |
|---|---|
| `uv run python tools/make_unreal_terrain.py` | `unreal_import/`: 16-bit heightmaps, orthoimage and luminance drapes, `import_values.json` (including `Z_REF`) |
| `uv run python tools/make_terrain_meshes.py` | `unreal_import/meshes/*.glb` (not in git) and `terrain_meshes.json`: core 4 × 4 km at 2.5 m, region 9 × 28 km at 16 m (pushed 40 m down under the core), far 56 × 68 km at 80 m |
| `uv run python tools/make_scene_layout.py` | `unreal_import/scene_layout.json`: positions of places, props, boulders, rockfall tracks and cameras, in Unreal centimetres |
| `uv run python tools/make_fx_textures.py` | `unreal_import/fx/dust_atlas.png`: procedural dust sprites |
| `uv run --no-project --with numpy --with pillow --with scipy --with rasterio python -I tools/make_ortho_colour.py` | `unreal_import/core_ortho_colour_4096.png`, `region_ortho_colour_2048x8192.png`: the orthoimages with colour (needs the HiRISE colour product and the Viking mosaic in `data_raw/colour/`, see the script header) |
| `uv run --no-project --with numpy --with scipy --with DracoPy python -I tools/make_crew_rig.py` | `unreal_import/crew/z2_suit_rigged.glb` and `.json`: the Z-2 suit bound to a skeleton, with its animation clips |
| `uv run --no-project --with numpy --with pillow --with scipy python -I tools/make_suit_texture.py` | `unreal_import/crew/z2_Color_s.jpg`, `z2_spec_color_s.jpg`, `z2_Bump_s.jpg`: suit textures without the insignia and the mission emblem, and a normal map made from the model's bump image |
| `uv run --no-project --with numpy --with pillow --with scipy python -I tools/make_prop_textures.py` | `unreal_import/props/*.png`: habitat, lander and helicopter textures without logos |

**2. Run the editor scripts** (in this order):

| # | Script | How | Produces |
|---|---|---|---|
| 1 | `scripts/import_assets.py` | headless | Drape textures in `/Game/Terrain/Textures`, ground textures in `/Game/Terrain/Ground`, models in `/Game/Props/Astronaut`, `Habitat`, `Rover`, `Rocks`. Replaces existing assets. Report: `Saved/import_report.json`. |
| 2 | `scripts/import_crew.py` | in the open editor | The rigged suit and its clips in `/Game/Props/CrewRig`, the suit textures (no insignia, a real normal map) over the ones in `/Game/Props/Suit`, the suit material made usable on skinned meshes. Needs the static suit in `/Game/Props/Suit`. Report: `Saved/import_crew_report.json`. |
| 3 | `scripts/import_prop_textures.py` | in the open editor | The habitat, lander and helicopter textures without logos, over the ones of the models in `/Game/Props/Habitat`, `InSight` and `Ingenuity`. Report: `Saved/import_prop_textures_report.json`. |
| 4 | `scripts/build_level.py` | headless | The empty `/Game/Maps/Melas` level with sun, atmosphere, sky light, fog, exposure and a start camera (values from `scripts/look.py`). Does nothing if the level exists. Report: `Saved/build_level_report.json`. |
| 5 | `scripts/import_terrain.py` | headless or in the editor | The terrain meshes in `/Game/Terrain/Meshes` as Nanite static meshes. Keeps existing meshes. Report: `Saved/import_terrain_report.json`. |
| 6 | `scripts/build_scene.py` | in the open editor, `Melas` loaded | The terrain material and instances, terrain actors, markers, dust effects, props, crew, boulders, rockfall rocks, agent markers and cameras. Safe to re-run. Report: `Saved/build_scene_report.json`. |
| 7 | `scripts/director.py` | in the open editor, `Melas` loaded | The live director. See below. |

Two more scripts run in the open editor with `Melas` loaded, at any time after step 6:

| Script | Produces |
|---|---|
| `scripts/look.py` | Sets the Sun, sky, haze, sky light, exposure and grade of the level again from the values in the script and saves the level. `LOOK_SAVE=0` applies them without saving. Report: `Saved/look_report.json`. |
| `scripts/capture_pov.py` | `data/site/pov/<id>.jpg` and `pov.json`: a still for each destination (shelters A and C, rover, habitat, fresh boulder) from crew eye height 40 to 60 m before arrival, for the dashboard. Play must be stopped. Takes about a minute. Run it again after a change of look. |

Headless command (editor closed):

```
"<UE>/Engine/Binaries/Mac/UnrealEditor-Cmd" <repo>/unreal/MelasSim/MelasSim.uproject -run=pythonscript -script=<repo>/unreal/scripts/import_assets.py -unattended -nosplash
```

On Windows the binary is `<UE>\Engine\Binaries\Win64\UnrealEditor-Cmd.exe`. Replace the script name for `build_level.py` and `import_terrain.py`.

In the open editor, type in the Output Log's Cmd box:

```
py "<repo>/unreal/scripts/build_scene.py"
```

The Z-2 suit, InSight and Ingenuity models that `build_scene.py` loads are already in `Content/`, but no script in the repository
imports them. To rebuild `Content/` from nothing, import them by hand from `assets_src/` (`nasa_z2_spacesuit`, `nasa_insight_lander`
`insight_deployed_mars_team.glb`, `nasa_ingenuity_helicopter`) under the names `z2_spacesuit`, `insight_deployed_mars_team` and
`ingenuity_v3_mars_team` in the folders listed above, then run `import_crew.py` and `import_prop_textures.py` again so the textures
without logos replace the ones of the models. `build_scene.py` lists anything it cannot load under `props_failed` in its report.

## Environment variables

Set them in the environment of the editor process before it starts. All are optional.

| Variable | Read by | Effect |
|---|---|---|
| `TERRAIN_FORCE=1` | `import_terrain.py` | Import meshes again even if they exist |
| `TERRAIN_ONLY` | `import_terrain.py` | Comma-separated mesh names (for example `SM_Core_00,SM_Far_0`); import only those |
| `SCENE_STAGES` | `build_scene.py` | Comma-separated list of `terrain` and `props` (default both); limits what is rebuilt |
| `SOLWAY_OSC_PORT` | `director.py` | UDP port to listen on (default 9000) |
| `SOLWAY_PLAY=1` | `director.py` | Start Play In Editor as soon as the director starts |
| `SOLWAY_EDITOR_WORLD=1` | `director.py` | Also drive the editor world when Play is not running (for look checks; do not save the level afterwards) |
| `SOLWAY_SCREEN_PERCENT` | `director.py` | Render resolution of the Play window in percent of its size (default 100). Lower it, for example to 75, on a 4K screen or a weaker GPU |
| `SOLWAY_WINDOW` | `director.py` | Size of the window that **New Editor Window (PIE)** opens (default `1920x1080`) |
| `SOLWAY_AUTOSTART=1` | `Content/Python/init_unreal.py` | Start the director by itself when the editor has opened the level |
| `LOOK_SAVE=0` | `look.py` | Apply the look without saving the level |

The engine always sends to `127.0.0.1:9000` (set in `engine/osc.py`). If you change `SOLWAY_OSC_PORT`, change the engine too.

## Start the director

On Windows, `unreal\start_sim.bat` does steps 2 and 3 in one go: it opens the editor with `SOLWAY_AUTOSTART=1` and `SOLWAY_PLAY=1`, so the
director starts and Play begins in the level viewport (press F11 for the viewport alone). Set `UE_ROOT` if the engine is not in
`C:\Program Files\Epic Games\UE_5.8`. Keep the editor window visible: a minimised editor does not render.

1. Start the engine (`uv run python -m engine` in the repository root). OSC is fire and forget, so the order does not matter, but the director only reacts to what arrives after it starts.
2. Open `MelasSim.uproject`, make sure `/Game/Maps/Melas` is loaded.
3. In the Cmd box run `py "<repo>/unreal/scripts/director.py"`, then press Play (or set `SOLWAY_PLAY=1`).
   For a demo, pick **New Editor Window (PIE)** in the menu next to the Play button: the scene then runs in a window of its own, without the editor around it.
4. Start the demo from the dashboard (**Run demo**) or start the engine with `--demo`.

Running the script again replaces the previous director. To stop it, run in the Cmd box:

```
py import builtins; builtins.solway_director.stop()
```

OSC messages and their arguments are defined in `../docs/CONTRACT.md`, section 3 (port 9000; addresses `/clock`, `/crew`, `/agent`,
`/incident`, `/overlay`, `/reload`, `/route`, `/cue`). The director also reads `runtime/` (routes, trajectories, overlay images),
`data/site/` and `unreal_import/scene_layout.json`. It writes its state once a second to `MelasSim/Saved/director_state.json`.

What the director does for each message:

| Message | Effect in the scene |
|---|---|
| `/crew` | Moves the crew actors (tag `crew:<id>`); heights come from the 2.5 m render grid so feet stay on the mesh. The suit is posed from its clips: the walk cycle advances with the ground covered (at most 1.7 cycles a second, so at high mission speed the feet slide), and the status picks kneel (stumbled), collapse (incapacitated) or crouch (heat, oxygen, arrived) |
| `/agent` | Moves a pool of markers during stress-test replays, coloured by status |
| `/clock` | Turns the sun |
| `/incident` | Marsquake: epicentre beam, falling rocks along the tracks in `scene_layout.json`, camera shake |
| `/overlay` | Shows `runtime/overlay_<layer>.png` on the core terrain, two layers at a time |
| `/reload` | Reads `routes`, `overlay` or `trajectories` again |
| `/route` | Draws the candidate routes on the terrain, coloured by state |
| `/cue` | Camera: `overview`, `follow`, `wall`, `shelter`, `failure` |

Camera notes. `follow` stays behind the crew; when the mission clock runs fast it pulls back and up and keeps pace, and it cuts
instead of flying when the previous shot was more than 150 m away. `shelter` looks at the end of the chosen route: a close shot of
the rover or the habitat when the route ends there, otherwise a low shot of the terrain shelter from the direction where the ground
hides it least.

## Set dressing, not simulation output

On its own the director keeps the scene moving: the cameras swing slowly around their subject, dust rises from the crew's steps
and from falling rocks, wind-blown dust and a dust devil drift across the view, the scout helicopter circles the crew, and loose
stones lie on the ground around what the camera looks at (a pool of stones the director lays out, always the same stone in the
same place). The dust, the dust devil, the helicopter and the stones are set dressing, not simulation output. The same holds for the
seismic station model, the Earth rock scans and ground textures, the few centimetres of relief the ground textures add next to the
camera, and the boulders in the rockfall band, whose positions are seeded and illustrative.
What does come from the engine: crew and agent positions, the clock and Sun direction, incidents, overlays and routes.

## Coordinates

`X = east × 100`, `Y = south × 100`, `Z = (elevation − Z_REF) × 100`, in centimetres, with `Z_REF = −3148.992 m`
(`unreal_import/import_values.json`). Images have east to the right and south down, so nothing is flipped. North is −Y.

## Terrain as Landscape (not used by the current scene)

`tools/make_unreal_terrain.py` still writes Landscape heightmaps (`core_height_2017.png`, `region_height_568x1765.png`) and the import
values for the Landscape dialog in `unreal_import/import_values.json`. UE 5.8 has no scripting call that creates a Landscape, so
that route needs manual import. `build_scene.py` places the Nanite meshes instead and does not use these files.

## Editor automation

Plugins `ModelContextProtocol` and `AllToolsets` (both ship with the engine) expose the editor on `http://127.0.0.1:8000/mcp`
for scripted scene edits (`MelasSim/.mcp.json`). The server is off unless the editor is started with `-ModelContextProtocolStartServer`.

## Look

Dynamic lighting only: Lumen for global illumination and reflections (software tracing; hardware ray tracing is off), Virtual
Shadow Maps, no baked light (`Config/DefaultEngine.ini`). The sky, haze, exposure and grade values are in `scripts/look.py`: they
start from a dusty Mars atmosphere (dust optical depth about 0.5, dust that absorbs blue) and are then tuned by eye, so they are a
look, not a measurement. Exposure is held in a narrow band so cuts between wide and close shots do not pump. The terrain material
uses Nanite tessellation to lift the two close ground textures by their height maps (a few centimetres, set dressing). The initial Sun direction is the JPL Horizons value for the site on 2026-11-15 07:00 UT (azimuth 297.68°,
elevation 50.05°); the engine overrides it through `/clock`, and the director keeps the Sun above a minimum elevation so the scene stays readable.
Surface colour comes from a greyscale orthoimage and a tint. It is approximate colour, and the app says so.
