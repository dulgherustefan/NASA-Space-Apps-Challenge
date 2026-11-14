# Assets and data credits

Everything in this repository that we did not make ourselves. Raw downloads live in `assets_src/` (not in git).
Each folder there has a `SOURCE.txt` that records the URL, the author line and the terms as shown on the source page.
All files were fetched on 14 Nov 2026, except the Universal Animation Library (15 Nov 2026). Licence and author text below is taken from those `SOURCE.txt` files, from
`data/site/meta.json` and from the pipeline code.

This project is not affiliated with or endorsed by NASA. No NASA insignia or logos are used.

The project's own code is under Apache 2.0 (`LICENSE`).

## Terrain and imagery (NASA and USGS data)

| What | Product | Credit | Source | Licence |
|---|---|---|---|---|
| Elevation, 1 m, 4 × 4 km core | HiRISE DTM `DTEEC_028857_1700_028923_1700_A01` | NASA/JPL/University of Arizona/USGS | [USGS Astrogeology STAC item](https://stac.astrogeology.usgs.gov/api/collections/mro_hirise_socet_dtms/items/DTEEC_028857_1700_028923_1700_A01), collection `mro_hirise_socet_dtms` | CC0 |
| Orthoimage, 1 m | HiRISE `ESP_028857_1700_RED_C_01_ORTHO` | NASA/JPL/University of Arizona | [USGS Astrogeology folder](https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mro/hirise/controlled/dtm/ESP_028857_1700_ESP_028923_1700/) | Public domain |
| Elevation, regional strip | CTX DTM `D04_028857_1684_XN_11S069W` / `D04_028923_1684_XN_11S069W` | NASA/JPL/MSSS/USGS | [USGS Astrogeology folder](https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mro/ctx/controlled/usgs/D04_028857_1684_XN_11S069W__D04_028923_1684_XN_11S069W/), collection `mro_ctx_controlled_usgs_dtms` | CC0 |

Processed copies are in `data/site/` (grids described in `data/site/meta.json`) and, for Unreal, in `unreal_import/`.
The orthoimage is greyscale. Surface colour in the app is a tint, shown as approximate colour.

## 3D models in the Unreal project

"In scene" means a script in `unreal/scripts/` places or loads it. "In project" means the files are in the Unreal
`Content/` folder but no script places them in the current scene.

### NASA models

All come from NASA's 3D resources. The repository README of
[NASA-3D-Resources](https://github.com/nasa/NASA-3D-Resources) describes the models as "free and without copyright" and points to the
[NASA media guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media). The repository's `meta.json` lists
the licence as NASA Open Source Agreement Version 1.3. The guidelines say NASA content is generally not subject to
copyright in the United States, that NASA should be acknowledged as the source, and that use must not imply NASA endorsement.

| Asset | Where in Unreal | Credit | Source | Status |
|---|---|---|---|---|
| Habitat Demonstration Unit, parts 1 and 2 | `/Game/Props/Habitat` | NASA (individual modeller not verified) | NASA-3D-Resources, `3D Models/Habitat Demonstration Unit/` | In scene |
| Space Exploration Vehicle | `/Game/Props/Rover` | NASA (individual modeller not verified) | NASA-3D-Resources, `3D Models/Space Exploration Vehicle/` | In scene |
| Z-2 planetary surface spacesuit prototype | `/Game/Props/Suit` | NASA/LaRC/Advanced Concepts Lab | [science.nasa.gov/3d-resources/z2-spacesuit](https://science.nasa.gov/3d-resources/z2-spacesuit/) | In scene (crew figure) |
| InSight lander (deployed) | `/Game/Props/InSight` | NASA/JPL-Caltech | [science.nasa.gov/resource/insight-lander-3d-model](https://science.nasa.gov/resource/insight-lander-3d-model/) | In scene (seismic station) |
| Ingenuity Mars Helicopter | `/Game/Props/Ingenuity` | NASA/JPL-Caltech | [science.nasa.gov/resource/mars-ingenuity-helicopter-3d-model](https://science.nasa.gov/resource/mars-ingenuity-helicopter-3d-model/) | In scene (helicopter) |
| Astronaut (generic, static) | `/Game/Props/AstronautNasa` | DigitalSpace Corporation, distributed by NASA 3D Resources | [science.nasa.gov/3d-resources/astronaut](https://science.nasa.gov/3d-resources/astronaut/) | In project |

The same terms apply to each row: NASA / US government, no copyright claimed, credit NASA, no endorsement implied.

### Other models

| Asset | Where in Unreal | Author | Source | Licence | Status |
|---|---|---|---|---|---|
| Astronaut, rigged, 24 animations | `/Game/Props/Astronaut` (copy in `/Game/Props/Crew`) | Quaternius | [poly.pizza/m/3hC2i0CTuO](https://poly.pizza/m/3hC2i0CTuO) | CC0 1.0 | In project |
| namaqualand_boulder_03 | `/Game/Props/Rocks` | Jenelle van Heerden (modelling), Dario Barresi (photography), Poly Haven | [polyhaven.com/a/namaqualand_boulder_03](https://polyhaven.com/a/namaqualand_boulder_03) | CC0 1.0 | In scene (boulders) |
| moon_rock_01 | `/Game/Props/Rocks` | Greg Zaal, Rico Cilliers (photography); Jenelle van Heerden, Dario Barresi (processing); Poly Haven | [polyhaven.com/a/moon_rock_01](https://polyhaven.com/a/moon_rock_01) | CC0 1.0 | In scene (boulders, rockfall) |
| moon_rock_02 | `/Game/Props/Rocks` | Rico Cilliers, Greg Zaal (photography); Jenelle van Heerden (processing); Poly Haven | [polyhaven.com/a/moon_rock_02](https://polyhaven.com/a/moon_rock_02) | CC0 1.0 | In scene (boulders) |
| moon_rock_03 | `/Game/Props/Rocks` | Greg Zaal, Rico Cilliers (photography); Jenelle van Heerden (processing); Poly Haven | [polyhaven.com/a/moon_rock_03](https://polyhaven.com/a/moon_rock_03) | CC0 1.0 | In project |
| moon_rock_04 | `/Game/Props/Rocks` | Greg Zaal, Rico Cilliers (photography); Jenelle van Heerden (processing); Poly Haven | [polyhaven.com/a/moon_rock_04](https://polyhaven.com/a/moon_rock_04) | CC0 1.0 | In project |
| rock_09 | `/Game/Props/Rocks` | Jenelle van Heerden, Poly Haven | [polyhaven.com/a/rock_09](https://polyhaven.com/a/rock_09) | CC0 1.0 | In project |

The rocks are Earth and studio scans used as set dressing. They are not Mars data.
The Unreal basic shapes (`/Engine/BasicShapes`: plane, cylinder, sphere) used for markers, beams and the rotor disc are
part of Unreal Engine (Epic Games).

## Ground textures

| Asset | Where in Unreal | Author | Source | Licence |
|---|---|---|---|---|
| red_laterite_soil_stones | `/Game/Terrain/Ground` | Amal Kumar (Poly Haven) | [polyhaven.com/a/red_laterite_soil_stones](https://polyhaven.com/a/red_laterite_soil_stones) | CC0 1.0 |
| sandy_gravel_02 | `/Game/Terrain/Ground` | Dario Barresi (Poly Haven) | [polyhaven.com/a/sandy_gravel_02](https://polyhaven.com/a/sandy_gravel_02) | CC0 1.0 |
| dry_ground_rocks | `/Game/Terrain/Ground` | Rob Tuytel (Poly Haven) | [polyhaven.com/a/dry_ground_rocks](https://polyhaven.com/a/dry_ground_rocks) | CC0 1.0 |

Close-up ground detail is blended from these Earth textures. The terrain shape and the large-scale brightness are the NASA data above.

## Made in this repository

The dust sprite atlas (`unreal_import/fx/dust_atlas.png`) is procedural, made by `tools/make_fx_textures.py`.
The terrain meshes, heightmaps and drape textures in `unreal_import/` are processed copies of the NASA and USGS data above.
Boulder positions in the rockfall band are illustrative (seeded, `tools/make_scene_layout.py`), not mapped boulders.

## Fonts and software shown in the dashboard

| Component | Author | Licence |
|---|---|---|
| Instrument Sans (npm `@fontsource-variable/instrument-sans` 5.3.0) | Instrument | SIL Open Font License 1.1 |
| JetBrains Mono (npm `@fontsource-variable/jetbrains-mono` 5.3.0) | JetBrains | SIL Open Font License 1.1 |
| lucide-react 1.73.0 (icons) | Lucide contributors | ISC |
| React, React DOM, Recharts, Radix UI, clsx, tailwind-merge, Tailwind CSS, Electron | their authors | MIT |
| class-variance-authority | its authors | Apache-2.0 |

Versions and licences are as read from `dashboard/node_modules/*/package.json`. Python dependencies are listed in `pyproject.toml`.

## Downloaded but not used

These files are in `assets_src/` only. They are not in the Unreal project and are not shown anywhere.
They are listed so the credit record matches the folder. If one is ever used, the attribution text is already here.

| Asset | Author | Source | Licence |
|---|---|---|---|
| Apollo Lunar Module | NASA/Michael D. Carbajal | [science.nasa.gov/3d-resources/apollo-lunar-module](https://science.nasa.gov/3d-resources/apollo-lunar-module/) | NASA, as for the NASA models above |
| Extravehicular Mobility Unit | NASA/Michael D. Carbajal | [science.nasa.gov/3d-resources/extravehicular-mobility-unit](https://science.nasa.gov/3d-resources/extravehicular-mobility-unit/) | same |
| Mark III spacesuit | NASA/Michael D. Carbajal | [science.nasa.gov/3d-resources/mark-iii-spacesuit](https://science.nasa.gov/3d-resources/mark-iii-spacesuit/) | same |
| Space Shuttle EVA suit | NASA/Johnson Space Center | [science.nasa.gov/3d-resources/space-shuttle-parts](https://science.nasa.gov/3d-resources/space-shuttle-parts/) | same |
| RASSOR excavator | NASA/Dewey L. Smith; NASA/Jason M. Schuler | [science.nasa.gov/3d-resources/regolith-advanced-surface-systems-operations-robot-rassor](https://science.nasa.gov/3d-resources/regolith-advanced-surface-systems-operations-robot-rassor/) | same |
| Tall Dish antenna (3 parts) | NASA/Ames Research Center | [science.nasa.gov/3d-resources/tall-dish](https://science.nasa.gov/3d-resources/tall-dish/) | same |
| Viking 1 lander | NASA/Michael D. Carbajal | [science.nasa.gov/3d-resources/viking-lander](https://science.nasa.gov/3d-resources/viking-lander/) | same |
| Curiosity rover | NASA/JPL-Caltech | [science.nasa.gov/resource/curiosity-rover-3d-model](https://science.nasa.gov/resource/curiosity-rover-3d-model/) | same |
| Perseverance rover (two files) | NASA/JPL-Caltech; NASA/Jet Propulsion Laboratory | [science.nasa.gov/resource/mars-perseverance-rover-3d-model](https://science.nasa.gov/resource/mars-perseverance-rover-3d-model/), [science.nasa.gov/3d-resources/mars-2020-perseverance-rover](https://science.nasa.gov/3d-resources/mars-2020-perseverance-rover/) | same |
| InSight cruise lander, arm deployed | NASA/Brian E. Kumanchik; NASA/JPL-Caltech | [science.nasa.gov/3d-resources/insight-cruise-lander](https://science.nasa.gov/3d-resources/insight-cruise-lander/) | same |
| Quaternius Ultimate Space Kit props (rovers, base, domes, houses, rocks, panels) | Quaternius | [Ultimate Space Kit bundle on Poly Pizza](https://poly.pizza/bundle/Ultimate-Space-Kit-YWh743lqGX) | CC0 1.0 |
| Quaternius animal astronauts (3 models) | Quaternius | [poly.pizza/m/0D54W8yfrA](https://poly.pizza/m/0D54W8yfrA), [zbtPq4dOJL](https://poly.pizza/m/zbtPq4dOJL), [OgeSH89Nmx](https://poly.pizza/m/OgeSH89Nmx) | CC0 1.0 |
| Character Hazmat | Quaternius | [poly.pizza/m/z3TSQYx1Kn](https://poly.pizza/m/z3TSQYx1Kn) | CC0 1.0 |
| Universal Animation Library [Standard] v3.0 | Quaternius | [quaternius.itch.io/universal-animation-library](https://quaternius.itch.io/universal-animation-library) | CC0 1.0 |
| Polygonal Mind astronaut avatars (3 models) | Polygonal Mind (100Avatars) | [poly.pizza/m/UeBrldDxE9](https://poly.pizza/m/UeBrldDxE9), [4orkFqR9c9](https://poly.pizza/m/4orkFqR9c9), [WVliq38EJz](https://poly.pizza/m/WVliq38EJz) | CC0 1.0 |
| Poly Haven models: namaqualand_boulder_02, 04, 05, 06; namaqualand_cliff_01, 02; rock_07; stone_01 | Poly Haven artists as listed in each `SOURCE.txt` (Greg Zaal, Rico Cilliers, Jenelle van Heerden, Dario Barresi) | `polyhaven.com/a/<name>` | CC0 1.0 |
| Sci Fi Character | Quaternius, via Poly Pizza | [poly.pizza/m/4pUXv5V8kq](https://poly.pizza/m/4pUXv5V8kq) | CC-BY 3.0 (label on the Poly Pizza page). Attribution: "Sci Fi Character by Quaternius [CC-BY] via Poly Pizza" |
| Hazmat Man | Charlie, via Poly Pizza | [poly.pizza/m/y2ygMH3VYx](https://poly.pizza/m/y2ygMH3VYx) | CC-BY 3.0. Attribution: "Hazmat Man by Charlie [CC-BY] via Poly Pizza" |
| Rigged astronaut | J-Toastie | [poly.pizza/m/0oBRDJ9Zl9](https://poly.pizza/m/0oBRDJ9Zl9) | CC-BY 3.0 |
| Astronaut | Poly by Google | [poly.pizza/m/dLHpzNdygsg](https://poly.pizza/m/dLHpzNdygsg) | CC-BY 3.0 |
| Astronaut | PW Wu | [poly.pizza/m/erlAEWfFKH3](https://poly.pizza/m/erlAEWfFKH3) | CC-BY 3.0 |
