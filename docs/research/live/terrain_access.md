# Live terrain access: "any location on Mars"

Verified 2026-11-15 from headless Chrome (Playwright, page served by Vite on 127.0.0.1:5182).
Code: `dashboard/src/live/global/` (`loadAnywhere.ts`, `terrainWorker.ts`, `GlobePicker.tsx`, `sites.ts`).
Dev harness: `dashboard/dev-global.html` (`?lon=&lat=`, `?only=pick`, `?random=0`).

## Endpoints (all CORS `*`, no key)

| What | Endpoint | Notes |
|---|---|---|
| DTM catalog | `https://stac.astrogeology.usgs.gov/api/collections/{mro_hirise_socet_dtms,mro_ctx_controlled_usgs_dtms}/items?bbox=W,S,E,N&limit=100` | bbox in deg E −180..180. Items carry `proj:wkt2` (equirectangular, clon 0, sphere R 3 396 190 m), `proj:transform`, `proj:shape`, a coarse footprint polygon and asset URLs. ~0.7–1.8 s per query. The CTX `numberMatched` is large (3 600+ at Gale) because the CTX stereo pairs overlap heavily, but the returned items do intersect the bbox. |
| HiRISE DTM | asset `dtm` → `astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mro/hirise/controlled/dtm/<PAIR>/<ID>.tif` | COG, float32, deflate, 512 px tiles, 5 overviews (2, 4, 8, 16, 32 m), nodata −3.4e38. Range requests return 206. |
| HiRISE ortho | asset `ortho_N` (`*_RED_C_01_ORTHO.tif`, 1 m, uint16, same grid as the DTM) | read at the 4 m overview for the box image. |
| CTX DTM | asset `geoid_adjusted_dem` (`…-DEM-geoid-adj.tif`) | COG float32, 20 m, nodata −32767, 3 overviews. Orthoimage asset `orthoimage` (`…-DRG.tif`, 20 m float32). |
| Global DEM | `https://trek.nasa.gov/mars/trekarcgis/rest/services/Mars_MOLA_blend200ppx_HRSC_DEM_clon0dd_200mpp_lzw/ImageServer/exportImage?bbox=W,S,E,N&bboxSR=104905&imageSR=104905&size=w,h&format=tiff&pixelType=F32&f=image` | MOLA/HRSC blend, 200 m. Returns a float32 GeoTIFF for any box (~66 KB for 100×100 px). Used for the gap fill, the 25.6 km far grid and the "no DTM" fallback. |
| Map tiles | `https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/{z}/{row}/{col}.jpg` | 2×1 tiles at z0, z0–7. GlobePicker only. |

Not usable from the browser:
- The USGS download of the same blend (`planetarymaps.usgs.gov/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif`) is an 11.4 GB striped BigTIFF, not a COG: a 20 km box would need ~40 MB of strips. The Trek ImageServer above serves the same product cut to the box.
- USGS TiTiler `/cog/info` on that blend: fetch failed (no usable response).
- Esri-hosted global CTX mosaic (`astro.arcgis.com/.../OnMars/CTX/MapServer/tile/{z}/{row}/{col}`): tiles that exist send CORS `*`, but missing tiles (common at level 12, some at level 11, e.g. over Melas) answer HTTP 500 without CORS headers, which prints console errors. Dropped. The box image comes from the DTM's own orthoimage instead, or a shaded relief.
- Chrome gotcha: concurrent range requests to one URL are serialised by the HTTP cache lock. With the default cache a 13 MB HiRISE window took ~29 s; with `fetch(..., { cache: 'no-store' })` it takes ~6 s.

## What a load costs (measured, home connection, 2026-11-15)

| Site | Source picked | Grade | Transfer | Requests | Load time |
|---|---|---|---|---|---|
| NE Melas Chasma (290.037E, 10.012S) | HiRISE DTEEC_028857_1700_028923_1700_A01, read at 2.03 m | EVA-grade | 14.7 MB | 128 | 9.4–10.2 s |
| Jezero delta (77.43E, 18.47N) | HiRISE DTEEC_045994_1985_046060_1985_U01 | EVA-grade | 13.4 MB | 128 | 8.5–8.8 s |
| Gale, Mount Sharp (137.395E, 4.728S) | HiRISE DTEEC_009149_1750_009294_1750_U01 | EVA-grade | 12.7 MB | 126 | 9.4–9.7 s |
| Olympus Mons caldera rim (226.2E, 18.4N) | CTX K07_055944_1981_XN_18N133W__P10_004821_2003_XI_20N134W | Route-planning | 5.2 MB | 28 | 4.7–5.5 s |
| Random point, no DTM (e.g. 117.97E, 16.15S) | global blend | Not suitable | 0.26 MB | 1 | 2.0–2.4 s |

Times include the STAC search (~1 s) and the worker compute (~1.2 s: resample, layers, beta, sky, image).
The HiRISE core window at the 2 m overview is ~11 MB of the total; the 4 m overview would cut a HiRISE
load to ~5 MB / ~4 s if needed.

Cross-check against the bundled Melas site (same DTM through the Python pipeline): core zMin/zMax
−3679/−2620 m live vs −3680/−2618 m bundled.

## Processing and approximations

- Frame: equirectangular about the box centre (e = R cos lat0 Δlon, s = −R Δlat). Over 4–25 km this is well under 0.1 % from a local tangent plane.
- Box choice: the 4 km box is centred on the click if ≥ 85 % of it lies in the STAC footprint, otherwise moved (up to 2.5 km) to the position with the best cover; the move is stated in `gradeReason`. STAC footprints are coarse (HiRISE strips are slanted quadrilaterals), so the real cover is measured after reading; gaps are filled from the global DEM shifted by the median DTM − global offset over the box. Grade follows the data actually under the box: > 50 % fill → not suitable, HiRISE with > 15 % fill → route-planning.
- Grids: `coreH` 1601² at 2.5 m (bilinear), `z` 800² at 5 m and `slope` (10 m baseline) exactly as `engine/site.ts`; `reg` 576² at 16 m (9.2 km box) from the DTM's 16 m overview + global fill; `far` 320² at 80 m (25.6 km) from the same.
- `slopeFine`: HiRISE: steepest of the four 2.5 m sub-quads per cell (stands in for the p90 of 1 m slope); CTX/global: = `slope`.
- `rough`: HiRISE: RMS residual of 2.5 m heights about their 3×3 mean; CTX/global: constant 0.05 m (below the engine's 0.15 m threshold, so no penalty: unknown, not "smooth").
- `beta` (approximate): 24 m grid over the regional box; sources = cells with slope ≥ 32° (5 m core, 16 m outside); beta = max over sources within 1.2 km of atan(Δz/d); source cells 40°. The brief said ~600 m; 1.2 km gives 29 % of the Melas box in the 27.8° band vs 52 % in the bundled CONEFALL layer (600 m gave 23 %), so the live layer is still optimistic on tall walls.
- `sky` (approximate): horizon angle in 8 directions on a 40 m grid, marching to 2.5 km through core → reg → far heights; blocked fraction = mean sin(horizon angle).
- `sand` = 0 (unknown), `pit` = 0 (not modelled), `raw` = empty arrays.
- Image of the box: HiRISE RED ortho (4 m overview, contrast-stretched, 1024 px) or CTX DRG (20 m, 512 px), else a shaded relief of the 5 m grid.
- Longitudes near 180° E: COG X is unwrapped towards the image centre. STAC footprints that cross the antimeridian can overstate cover; the measured fill catches this and the grade drops.

## Credits (for ASSETS.md)

- HiRISE DTMs and orthoimages: NASA/JPL/University of Arizona/USGS (USGS Astrogeology STAC, CC0).
- CTX DTMs and orthoimages: NASA/JPL/MSSS/USGS (USGS Astrogeology STAC, CC0).
- Global DEM: MOLA/HRSC blend DEM v2, 200 m: NASA/MOLA, ESA/DLR/FU Berlin HRSC, USGS (served by NASA Mars Trek).
- Map: Viking MDIM 2.1 colour mosaic: NASA/JPL/USGS (NASA Mars Trek WMTS).
