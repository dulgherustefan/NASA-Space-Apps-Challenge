# Simulation window (Unreal Engine 5.8)

`MelasSim/` is the Unreal project. It shows the real terrain of the demo site and plays what the engine sends over OSC
(`docs/CONTRACT.md`). Blueprint only, no C++, so it opens without a compile step.

## What is already in the project

| Path | What |
|---|---|
| `/Game/Maps/Melas` | Empty level: Mars sun, atmosphere, sky light, haze, exposure, start camera. Opens by default. |
| `/Game/Terrain/Textures` | Orthoimage and luminance drapes for both terrain tiers |
| `/Game/Terrain/Ground` | Three tiling ground materials (Poly Haven, CC0): diffuse, normal, AO/rough/metal |
| `/Game/Props/Astronaut` | Rigged astronaut with 24 animations (Quaternius, CC0) |
| `/Game/Props/Habitat`, `/Game/Props/Rover` | NASA Habitat Demonstration Unit and Space Exploration Vehicle (credit NASA) |
| `/Game/Props/Rocks` | Six scanned rocks (Poly Haven, CC0) |

Rebuild any of it with the scripts in `unreal/scripts/` (editor closed):

```
"<UE>/Engine/Binaries/Mac/UnrealEditor-Cmd" <repo>/unreal/MelasSim/MelasSim.uproject -run=pythonscript -script=<repo>/unreal/scripts/import_assets.py -unattended -nosplash
```

On Windows the binary is `<UE>\Engine\Binaries\Win64\UnrealEditor-Cmd.exe`. `import_assets.py` needs `assets_src/` and
`unreal_import/` (run `uv run python tools/make_unreal_terrain.py` for the second). `build_level.py` never overwrites an existing level.

## The one manual step: import the two Landscapes

Unreal 5.8 has no scripting call that creates a Landscape, so this is done once by hand, in the `Melas` level.
Files are in `unreal_import/`, all values also in `unreal_import/import_values.json`.

For each row: **Landscape Mode (Shift+2) → Manage → New → Import from File**, pick the heightmap, set the fields, press **Import**.
Do not press *Fit To Data*. Leave *Flip Y Axis* off and the material empty.

| Field | Core (4 × 4 km, HiRISE) | Region (9 × 28 km, HiRISE + CTX) |
|---|---|---|
| Heightmap file | `core_height_2017.png` | `region_height_568x1765.png` |
| Location (panel, = centre) | 365000, 860000, 0 | 360000, 212000, 225754.83 |
| Scale | 198.4127, 198.4127, 207.425 | 1600, 1600, 1444.358 |
| Section size | 63 × 63 quads | 63 × 63 quads |
| Sections per component | 2 × 2 | 1 × 1 |
| Number of components | 16 × 16 | 9 × 28 |
| Overall resolution (check) | 2017 × 2017 | 568 × 1765 |

After each import select the new Landscape actor and check **Details → Transform → Location**. It must read:

| | Core | Region |
|---|---|---|
| Actor location | 165000, 660000, 0 | −93600, −1199200, 225754.83 |

If it does not, type these values there (the actor's location is its first vertex, the panel's is the centre).
Rename the actors `Landscape_Core` and `Landscape_Region`, then save the level.

The region is sunk 40 m under the core box on purpose, so the two tiers never fight for the same pixels.

## Coordinates

`X = east × 100`, `Y = south × 100`, `Z = (elevation − Z_REF) × 100`, with `Z_REF = −3148.992 m`. Images and heightmaps
have east to the right and south down, so nothing is flipped. North is −Y.

## Editor automation

Plugins `ModelContextProtocol` and `AllToolsets` (both ship with the engine) expose the editor on `http://127.0.0.1:8000/mcp`
for scripted scene edits. The server is off unless the editor is started with `-ModelContextProtocolStartServer`.

## Look

Dynamic lighting only: Lumen for global illumination and reflections, Virtual Shadow Maps, no baked light.
The sky values in `build_level.py` are a starting point chosen from dust optical depth and albedo, not a measurement; tune by eye.
Surface colour comes from a greyscale orthoimage and a tint. It is approximate colour, and the app says so.
