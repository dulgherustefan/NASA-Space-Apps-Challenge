# Assets and data credits

Everything in this repository that we did not make ourselves. Raw downloads live in `assets_src/` (not in git).
Each folder there has a `SOURCE.txt` that records the URL, the author line and the terms as shown on the source page.
All files were fetched on 14 Nov 2026, except the Universal Animation Library, the terrain colour data, the rover
reference photographs and the extra ground textures (15 Nov 2026). Licence and author text below is taken from those `SOURCE.txt` files, from
`data/site/meta.json` and from the pipeline code.

This project is not affiliated with or endorsed by NASA. No NASA insignia or logos are shown: the insignia, emblems
and agency or programme logos on the textures of the NASA models in the scene (suit, habitat, lander, helicopter) are painted
out by `tools/make_suit_texture.py` and `tools/make_prop_textures.py`.

The project's own code is under Apache 2.0 (`LICENSE`).

## Terrain and imagery (NASA and USGS data)

| What | Product | Credit | Source | Licence |
|---|---|---|---|---|
| Elevation, 1 m, 4 × 4 km core | HiRISE DTM `DTEEC_028857_1700_028923_1700_A01` | NASA/JPL/University of Arizona/USGS | [USGS Astrogeology STAC item](https://stac.astrogeology.usgs.gov/api/collections/mro_hirise_socet_dtms/items/DTEEC_028857_1700_028923_1700_A01), collection `mro_hirise_socet_dtms` | CC0 |
| Orthoimage, 1 m | HiRISE `ESP_028857_1700_RED_C_01_ORTHO` | NASA/JPL/University of Arizona | [USGS Astrogeology folder](https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mro/hirise/controlled/dtm/ESP_028857_1700_ESP_028923_1700/) | Public domain |
| Elevation, regional strip | CTX DTM `D04_028857_1684_XN_11S069W` / `D04_028923_1684_XN_11S069W` | NASA/JPL/MSSS/USGS | [USGS Astrogeology folder](https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mro/ctx/controlled/usgs/D04_028857_1684_XN_11S069W__D04_028923_1684_XN_11S069W/), collection `mro_ctx_controlled_usgs_dtms` | CC0 |

| Colour pattern (dust and sand), strip about 1.2 km wide | HiRISE merged colour product `ESP_028857_1700_MRGB` | NASA/JPL/University of Arizona | [HiRISE PDS folder](https://hirise-pds.lpl.arizona.edu/PDS/EXTRAS/RDR/ESP/ORB_028800_028899/ESP_028857_1700/), [image page](https://www.uahirise.org/ESP_028857_1700) | Public domain (HiRISE image usage policy) |
| Broad hue variation, about 232 m per pixel | Viking MDIM 2.1 colourised global mosaic | USGS Astrogeology Science Center / NASA Ames | [USGS Astrogeology](https://astrogeology.usgs.gov/search/map/mars_viking_colorized_global_mosaic_232m) | Public domain |

Processed copies are in `data/site/` (grids described in `data/site/meta.json`) and, for Unreal, in `unreal_import/`.
The HiRISE orthoimage is greyscale. In the dashboard the surface colour is a tint. In the Unreal scene the terrain uses
`unreal_import/*_ortho_colour_*.png`, made by `tools/make_ortho_colour.py`: the brightness is the HiRISE orthoimage, the
dust and sand pattern comes from the HiRISE colour strip, a broad hue variation comes from the Viking mosaic, and the
colours themselves are set to soil colours measured on the rover photographs below. This is an approximate colour, not a
measurement of the site.

## Weather reference, Sun position and space weather

| What | Product | Credit | Source | Licence |
|---|---|---|---|---|
| Ground and air temperature range, pressure and UV index for the season, shown as an analogue from Gale crater | Curiosity REMS daily weather reports, the 71 sols at Ls 20 to 24 (sols 391 to 4412) | NASA/JPL-Caltech/CAB (CSIC-INTA) | [mars.nasa.gov weather feed](https://mars.nasa.gov/rss/api/?feed=weather&category=msl&feedtype=json), fetched 15 Nov 2026 | NASA mission data, public |
| Sun azimuth and elevation at the site, Earth to Mars distance | JPL Horizons, 15 and 16 Nov 2026 | NASA/JPL Solar System Dynamics | [ssd.jpl.nasa.gov/horizons](https://ssd.jpl.nasa.gov/horizons/) | Public |
| Local time, season and Sun position outside the Horizons table; daylight left | Mars24 algorithm (Allison and McEwen 2000) | NASA Goddard Institute for Space Studies | [giss.nasa.gov/tools/mars24](https://www.giss.nasa.gov/tools/mars24/help/algorithm.html) | Published algorithm |

| Earth-side record of the solar event of 20 May 2024: coronal mass ejection `2024-05-20T05:36:00-CME-001`, its analyses and WSA-ENLIL runs, the notifications sent for it, solar energetic particle records of 19 to 25 May 2024 | NASA CCMC DONKI (Space Weather Database Of Notifications, Knowledge, Information) | NASA Community Coordinated Modeling Center (CCMC), Moon to Mars Space Weather Analysis Office | [ccmc.gsfc.nasa.gov/tools/DONKI](https://ccmc.gsfc.nasa.gov/tools/DONKI/), through `api.nasa.gov/DONKI`, fetched 15 Nov 2026 | NASA data, public |

`tools/fetch_donki.py` saves that record as `data/space_weather/donki_2024-05-20.json` (values unchanged, unused fields
dropped). The engine reads the file and never calls the service.

`tools/make_weather_analogue.py` turns the saved feed into `data/site/weather_analogue.json` (medians and 10th to 90th
percentiles). The feed itself is not in git. The dust optical depth in `engine/params.py` (0.39) is a single value read
from the Mars Climate Database v6.2 (LMD/OU/IAA/ESA/CNES) for the site and season and is cited there; no MCD file is
stored in this repository.

Rover photographs used only as colour reference (not shown in the app, not in git):

| Image | Rover and camera | Credit | Source |
|---|---|---|---|
| PIA16769, PIA25176, PIA26367 | Curiosity, Mastcam | NASA/JPL-Caltech/MSSS | `photojournal.jpl.nasa.gov/catalog/<id>`, files from the NASA Image and Video Library |
| PIA23727, PIA24765, PIA25736 | Perseverance, Mastcam-Z | NASA/JPL-Caltech/ASU/MSSS | same |

NASA media usage guidelines apply to these images, as for the NASA models below.

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
| Habitat Demonstration Unit, parts 1 and 2 | `/Game/Props/Habitat` | NASA (individual modeller not verified) | NASA-3D-Resources, `3D Models/Habitat Demonstration Unit/` | In scene. Modified: insignia, programme logos and unit patches painted out of the texture |
| Space Exploration Vehicle | `/Game/Props/Rover` | NASA (individual modeller not verified) | NASA-3D-Resources, `3D Models/Space Exploration Vehicle/` | In scene |
| Z-2 planetary surface spacesuit prototype | `/Game/Props/Suit` | NASA/LaRC/Advanced Concepts Lab | [science.nasa.gov/3d-resources/z2-spacesuit](https://science.nasa.gov/3d-resources/z2-spacesuit/) | In scene (crew figure). Modified: given a skeleton and animation clips by `tools/make_crew_rig.py` (`/Game/Props/CrewRig`), insignia and mission emblem painted out of the textures, normal map made from the model's bump image |
| InSight lander (deployed) | `/Game/Props/InSight` | NASA/JPL-Caltech | [science.nasa.gov/resource/insight-lander-3d-model](https://science.nasa.gov/resource/insight-lander-3d-model/) | In scene (seismic station). Modified: agency logos painted out of the calibration target texture |
| Ingenuity Mars Helicopter | `/Game/Props/Ingenuity` | NASA/JPL-Caltech | [science.nasa.gov/resource/mars-ingenuity-helicopter-3d-model](https://science.nasa.gov/resource/mars-ingenuity-helicopter-3d-model/) | In scene (helicopter). Modified: agency logos painted out of the textures |

The same terms apply to each row: NASA / US government, no copyright claimed, credit NASA, no endorsement implied.

### Other models

| Asset | Where in Unreal | Author | Source | Licence | Status |
|---|---|---|---|---|---|
| Astronaut, rigged, 24 animations | `/Game/Props/Astronaut` (copy in `/Game/Props/Crew`) | Quaternius | [poly.pizza/m/3hC2i0CTuO](https://poly.pizza/m/3hC2i0CTuO) | CC0 1.0 | In project |
| Universal Animation Library [Standard] v3.0 (skeleton and the idle, walk, stumble, collapse, kneel, crouch and work clips) | `/Game/Props/CrewRig` (retargeted to the Z-2 suit) | Quaternius | [quaternius.itch.io/universal-animation-library](https://quaternius.itch.io/universal-animation-library) | CC0 1.0 | In scene (crew animation) |
| namaqualand_boulder_03 | `/Game/Props/Rocks` | Jenelle van Heerden (modelling), Dario Barresi (photography), Poly Haven | [polyhaven.com/a/namaqualand_boulder_03](https://polyhaven.com/a/namaqualand_boulder_03) | CC0 1.0 | In scene (boulders, rockfall) |
| namaqualand_boulder_05 | `/Game/Props/Rocks` | Jenelle van Heerden (modelling), Dario Barresi (photography), Poly Haven | [polyhaven.com/a/namaqualand_boulder_05](https://polyhaven.com/a/namaqualand_boulder_05) | CC0 1.0 | In scene (boulders, stones) |
| namaqualand_boulder_06 | `/Game/Props/Rocks` | Greg Zaal (photography), Jenelle van Heerden (modelling), Poly Haven | [polyhaven.com/a/namaqualand_boulder_06](https://polyhaven.com/a/namaqualand_boulder_06) | CC0 1.0 | In scene (boulders, stones) |
| rock_07 | `/Game/Props/Rocks` | Jenelle van Heerden, Poly Haven | [polyhaven.com/a/rock_07](https://polyhaven.com/a/rock_07) | CC0 1.0 | In scene (small stones) |
| moon_rock_01 | `/Game/Props/Rocks` | Greg Zaal, Rico Cilliers (photography); Jenelle van Heerden, Dario Barresi (processing); Poly Haven | [polyhaven.com/a/moon_rock_01](https://polyhaven.com/a/moon_rock_01) | CC0 1.0 | In project |
| moon_rock_02 | `/Game/Props/Rocks` | Rico Cilliers, Greg Zaal (photography); Jenelle van Heerden (processing); Poly Haven | [polyhaven.com/a/moon_rock_02](https://polyhaven.com/a/moon_rock_02) | CC0 1.0 | In project |
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

Close-up ground detail is blended from these Earth textures. The terrain shape and the large-scale brightness are the NASA data above. The height maps of
red_laterite_soil_stones and dry_ground_rocks also lift the surface by a few centimetres next to the camera (set dressing, not elevation data).

## Made in this repository

The dust sprite atlas (`unreal_import/fx/dust_atlas.png`) is procedural, made by `tools/make_fx_textures.py`.
The terrain meshes, heightmaps and drape textures in `unreal_import/` are processed copies of the NASA and USGS data above.
Boulder positions in the rockfall band are illustrative (seeded, `tools/make_scene_layout.py`), not mapped boulders.

## Fonts and software shown in the dashboard

| Component | Author | Licence |
|---|---|---|
| Instrument Sans (npm `@fontsource-variable/instrument-sans` 5.3.0) | © 2022 The Instrument Sans Project Authors | SIL Open Font License 1.1 |
| Solway mark (`docs/img/logo.svg`, `dashboard/public/favicon.svg`) | Team artwork, drawn as vector for this repository | Apache-2.0 |
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
| Astronaut (generic) | DigitalSpace Corporation, distributed by NASA 3D Resources | [science.nasa.gov/3d-resources/astronaut](https://science.nasa.gov/3d-resources/astronaut/) | same |
| RASSOR excavator | NASA/Dewey L. Smith; NASA/Jason M. Schuler | [science.nasa.gov/3d-resources/regolith-advanced-surface-systems-operations-robot-rassor](https://science.nasa.gov/3d-resources/regolith-advanced-surface-systems-operations-robot-rassor/) | same |
| Tall Dish antenna (3 parts) | NASA/Ames Research Center | [science.nasa.gov/3d-resources/tall-dish](https://science.nasa.gov/3d-resources/tall-dish/) | same |
| Viking 1 lander | NASA/Michael D. Carbajal | [science.nasa.gov/3d-resources/viking-lander](https://science.nasa.gov/3d-resources/viking-lander/) | same |
| Curiosity rover | NASA/JPL-Caltech | [science.nasa.gov/resource/curiosity-rover-3d-model](https://science.nasa.gov/resource/curiosity-rover-3d-model/) | same |
| Perseverance rover (two files) | NASA/JPL-Caltech; NASA/Jet Propulsion Laboratory | [science.nasa.gov/resource/mars-perseverance-rover-3d-model](https://science.nasa.gov/resource/mars-perseverance-rover-3d-model/), [science.nasa.gov/3d-resources/mars-2020-perseverance-rover](https://science.nasa.gov/3d-resources/mars-2020-perseverance-rover/) | same |
| InSight cruise lander, arm deployed | NASA/Brian E. Kumanchik; NASA/JPL-Caltech | [science.nasa.gov/3d-resources/insight-cruise-lander](https://science.nasa.gov/3d-resources/insight-cruise-lander/) | same |
| Quaternius Ultimate Space Kit props (rovers, base, domes, houses, rocks, panels) | Quaternius | [Ultimate Space Kit bundle on Poly Pizza](https://poly.pizza/bundle/Ultimate-Space-Kit-YWh743lqGX) | CC0 1.0 |
| Quaternius animal astronauts (3 models) | Quaternius | [poly.pizza/m/0D54W8yfrA](https://poly.pizza/m/0D54W8yfrA), [zbtPq4dOJL](https://poly.pizza/m/zbtPq4dOJL), [OgeSH89Nmx](https://poly.pizza/m/OgeSH89Nmx) | CC0 1.0 |
| Character Hazmat | Quaternius | [poly.pizza/m/z3TSQYx1Kn](https://poly.pizza/m/z3TSQYx1Kn) | CC0 1.0 |
| Polygonal Mind astronaut avatars (3 models) | Polygonal Mind (100Avatars) | [poly.pizza/m/UeBrldDxE9](https://poly.pizza/m/UeBrldDxE9), [4orkFqR9c9](https://poly.pizza/m/4orkFqR9c9), [WVliq38EJz](https://poly.pizza/m/WVliq38EJz) | CC0 1.0 |
| Poly Haven models: namaqualand_boulder_02, 04; namaqualand_cliff_01, 02; stone_01 | Poly Haven artists as listed in each `SOURCE.txt` (Greg Zaal, Rico Cilliers, Jenelle van Heerden, Dario Barresi) | `polyhaven.com/a/<name>` | CC0 1.0 |
| Poly Haven ground textures: rocks_ground_09, rocky_trail_02 | Rob Tuytel; Amal Kumar (Poly Haven) | `polyhaven.com/a/<name>` | CC0 1.0 |
| ambientCG materials: Ground098, Rock029, Rock062 | ambientCG | `ambientcg.com/a/<name>` | CC0 1.0 |
| Sci Fi Character | Quaternius, via Poly Pizza | [poly.pizza/m/4pUXv5V8kq](https://poly.pizza/m/4pUXv5V8kq) | CC-BY 3.0 (label on the Poly Pizza page). Attribution: "Sci Fi Character by Quaternius [CC-BY] via Poly Pizza" |
| Hazmat Man | Charlie, via Poly Pizza | [poly.pizza/m/y2ygMH3VYx](https://poly.pizza/m/y2ygMH3VYx) | CC-BY 3.0. Attribution: "Hazmat Man by Charlie [CC-BY] via Poly Pizza" |
| Rigged astronaut | J-Toastie | [poly.pizza/m/0oBRDJ9Zl9](https://poly.pizza/m/0oBRDJ9Zl9) | CC-BY 3.0 |
| Astronaut | Poly by Google | [poly.pizza/m/dLHpzNdygsg](https://poly.pizza/m/dLHpzNdygsg) | CC-BY 3.0 |
| Astronaut | PW Wu | [poly.pizza/m/erlAEWfFKH3](https://poly.pizza/m/erlAEWfFKH3) | CC-BY 3.0 |

## Live mode (web, added 15 Nov 2026)

| What | Product | Credit | Source | Licence |
|---|---|---|---|---|
| Elevation anywhere a HiRISE DTM exists (read live) | HiRISE DTMs, collection `mro_hirise_socet_dtms` | NASA/JPL/University of Arizona/USGS | [USGS Astrogeology STAC](https://stac.astrogeology.usgs.gov/api/collections/mro_hirise_socet_dtms), COGs on `astrogeo-ard` S3 | CC0 |
| Elevation anywhere a CTX DTM exists (read live) | CTX DTMs, collection `mro_ctx_controlled_usgs_dtms` | NASA/JPL/MSSS/USGS | [USGS Astrogeology STAC](https://stac.astrogeology.usgs.gov/api/collections/mro_ctx_controlled_usgs_dtms) | CC0 |
| Global fallback elevation, 200 m | Mars MOLA/HRSC blended DEM v2 | NASA/MOLA, ESA/DLR/FU Berlin HRSC, USGS | NASA Mars Trek ImageServer (`trek.nasa.gov`) | Public domain |
| Global map for picking a place | Viking MDIM 2.1 mosaic | NASA/JPL/USGS | NASA Mars Trek WMTS tiles | Public domain |
| Astronaut model (helmet and rover views) | `public/models/astronaut.glb` | "Astronaut" by Javi_DaviYT (Sketchfab); same model also published by LasquetiSpice; original creator not established | [sketchfab.com/3d-models/astronaut-287589e324b942b8be57dbd6c539b2ab](https://sketchfab.com/3d-models/astronaut-287589e324b942b8be57dbd6c539b2ab) | CC-BY 4.0, modified (compressed, textures resized) |
| Pressurized rover model | `public/models/rover_sev.glb`, Space Exploration Vehicle (MMSEV) | NASA | [NASA-3D-Resources](https://github.com/nasa/NASA-3D-Resources/tree/master/3D%20Models/Space%20Exploration%20Vehicle) | NASA media guidelines (free, no copyright; no endorsement implied) |
| Ground detail texture | `public/models/tex/sandy_gravel_02_diff.webp` | Dario Barresi / Poly Haven | [polyhaven.com/a/sandy_gravel_02](https://polyhaven.com/a/sandy_gravel_02) | CC0 1.0 |
| Radio beep | `public/audio/radio_beep.mp3` | Solway team (synthesised by script, 2525 Hz) | own work | Apache 2.0 |
| Voice prompts in the helmet display | 23 lines in `public/audio/voice/` (text in `manifest.json`) | Generated with ElevenLabs text-to-speech, premade voice "Sarah", 15 Nov 2026 | AI-generated speech | Used under the ElevenLabs terms of the team's subscription |
| Index of all HiRISE and CTX DTM footprints | `public/stac/hirise_dtms.json`, `public/stac/ctx_dtms.json` (id, centre, size) | NASA/JPL/University of Arizona/USGS; NASA/JPL/MSSS/USGS | USGS Astrogeology STAC API, fetched 15 Nov 2026 | CC0 |
| Walking policy | `public/policy/policy.json` | Solway team (PPO, `rl/train_ppo.py`) | this repository | Apache 2.0 |
