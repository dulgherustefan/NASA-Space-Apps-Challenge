# Assets and data credits

Everything shipped in this repository that we did not make ourselves. Raw downloads live in `assets_src/` (not in git),
each folder with a `SOURCE.txt` that records the exact URL and the date fetched (14 Nov 2026).

This project is not affiliated with or endorsed by NASA. No NASA insignia or logos are used.

## Terrain (NASA data)

| What | Product | Credit | Terms |
|---|---|---|---|
| Elevation, 1 m, 4 × 4 km core | HiRISE DTM `DTEEC_028857_1700_028923_1700_A01` | NASA/JPL/University of Arizona/USGS | USGS Astrogeology STAC `mro_hirise_socet_dtms`, CC0 |
| Orthoimage, 1 m | HiRISE `ESP_028857_1700_RED_C_01_ORTHO` | NASA/JPL/University of Arizona | public domain |
| Elevation, regional strip | CTX DTM `D04_028857_1684_XN_11S069W` / `D04_028923_1684_XN_11S069W` | NASA/JPL/MSSS/USGS | USGS Astrogeology STAC `mro_ctx_controlled_usgs_dtms`, CC0 |

Processed copies are in `data/site/` (grids described in `data/site/meta.json`) and, for Unreal, in `unreal_import/`.
The orthoimage is greyscale. Surface colour in the app is a tint, shown as approximate colour.

## 3D models

| Asset | Where in Unreal | Author | Terms |
|---|---|---|---|
| Habitat Demonstration Unit (parts 1 and 2) | `/Game/Props/Habitat` | NASA, from [NASA-3D-Resources](https://github.com/nasa/NASA-3D-Resources) | "free and without copyright"; [NASA media guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media) |
| Space Exploration Vehicle | `/Game/Props/Rover` | NASA, same repository | same |
| Astronaut, rigged, 24 animations | `/Game/Props/Astronaut` | Quaternius, [poly.pizza/m/3hC2i0CTuO](https://poly.pizza/m/3hC2i0CTuO) | CC0 1.0 |
| moon_rock_01 to 04 | `/Game/Props/Rocks` | Greg Zaal, Rico Cilliers, Jenelle van Heerden, Dario Barresi ([Poly Haven](https://polyhaven.com)) | CC0 1.0 |
| rock_09 | `/Game/Props/Rocks` | Jenelle van Heerden (Poly Haven) | CC0 1.0 |
| namaqualand_boulder_03 | `/Game/Props/Rocks` | Jenelle van Heerden, Dario Barresi (Poly Haven) | CC0 1.0 |

The rocks are Earth and studio scans used as set dressing. They are not Mars data.

## Ground textures

| Asset | Where in Unreal | Author | Terms |
|---|---|---|---|
| red_laterite_soil_stones | `/Game/Terrain/Ground` | Amal Kumar (Poly Haven) | CC0 1.0 |
| sandy_gravel_02 | `/Game/Terrain/Ground` | Dario Barresi (Poly Haven) | CC0 1.0 |
| dry_ground_rocks | `/Game/Terrain/Ground` | Rob Tuytel (Poly Haven) | CC0 1.0 |

Close-up ground detail is blended from these Earth textures. The terrain shape and the large-scale brightness are the NASA data above.
