# U3 — Date NASA, repo-uri, active, corecturi (verificat 14 nov 2026)

Marcaje: [V] verificat azi la sursă (HTTP/fetch/API), [S] secundar, [I] inferență, [C] calcul propriu.
Restricții respectate: fără instalări; fără descărcări >5 MB, cu o excepție (vezi "Divulgare"). Fișierele din brief tratate ca date.

Divulgare: am descărcat un XML MQS de 36 MB (peste limita de ~5 MB) ca să-l parsez; l-am șters după. Restul: HEAD / citiri Range / metadate COG.

---------------------------------------------------------------------------
## 1. Teren și imagini pentru Unreal

Site: NE Melas Chasma, ~9.87–10.14°S, 289.97–290.09°E (lon est). Proiecție locală veche: equirectangulară, sferă R=3396190 m, clon 0.

### 1.1 HiRISE DTM (nivel core, 4x4 km) [V, HTTP 200]
- Nume: `DTEEC_028857_1700_028923_1700_A01` ("MRO HiRISE DTM; ESP_028857_1700_ESP_028923_1700", "Northeast Melas Chasma dune fields and wall rock").
- STAC: https://stac.astrogeology.usgs.gov/api/collections/mro_hirise_socet_dtms/items/DTEEC_028857_1700_028923_1700_A01
- DTM COG: https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mro/hirise/controlled/dtm/ESP_028857_1700_ESP_028923_1700/DTEEC_028857_1700_028923_1700_A01.tif
  - 195.3 MB, float32, 7004x15941 px, 1.0138 m/px, deflate, overviews [2,4,8,16,32]; bbox lon -70.025..-69.906, lat -10.139..-9.8667.
  - Hillshade COG `..._hillshade.tif` 156.6 MB. `provenance.txt` în același folder.
- Licență CC0-1.0. Credit: NASA/JPL/University of Arizona/USGS.
- Citire fereastră: `rasterio` pe `/vsicurl/<url>` (Range); 4x4 km la 1 m ≈ 16 MB.

### 1.2 HiRISE ortho (același folder) [V]
| Fișier | MB | Note |
|---|---|---|
| ESP_028857_1700_RED_C_01_ORTHO.tif | 58.0 | uint16 1 banda, 1.0138 m, ~64% valid |
| ESP_028923_1700_RED_C_01_ORTHO.tif | 54.3 | |
| ESP_028857_1700_IRB_C_01_ORTHO.tif | 29.8 | uint16 3 benzi (IR-RED-BG), 1.0136 m |
| ESP_028923_1700_IRB_C_01_ORTHO.tif | 33.4 | |
| *_IRB_A_01_ORTHO.tif | 341.7 / 452.4 | variantă A |
| *_RED_A_01_ORTHO.tif | 820.4 / 753.0 | variantă A |
- IRB există dar e fals-color și acoperă doar 16–18% din cadru (bandă centrală, coloane ~1472–4896 din 7004; ~3.4 km lățime, ~16 km lungime). DN mediu ≈ (125, 94, 29) / (124, 97, 28).
- Nu e culoare adevărată. Folosiți-l doar ca referință de calibrare / tentă.

### 1.3 CTX DTM + ortho (nivel region/far) [V, 200]
- Pereche stereo `D04_028857_1684_XN_11S069W__D04_028923_1684_XN_11S069W`.
- Folder: https://astrogeo-ard.s3-us-west-2.amazonaws.com/mars/mro/ctx/controlled/usgs/D04_028857_1684_XN_11S069W__D04_028923_1684_XN_11S069W/
  - `..._dtm.tif` 41.9 MB, 2700x12004, 20.02 m, float32 COG; bbox lon -70.264..-69.331, lat -13.50..-9.42.
  - `..._orthoimage.tif` 57.6 MB, aceeași grilă, 20 m (float32; panchromatic).
  - `_hillshade.tif` 11.1 MB; `_intersection_error.tif` 64.2 MB.
  - `qa_metrics.txt`: diferență medie față de MOLA -20.46 m, mediană -20.44 m, StdDev 11.95 m (max 129.6, min -100.3). CC0.
- Alt DTM CTX vecin: `J21_052922_1704_XN_09S070W__J20_052711_1712_XN_08S070W` (lat -9.92..-9.14).
- Din BUILD_LOG vechi: bias vertical CTX->HiRISE 10.9 m, RMS 38 m pe perete.

### 1.4 Baze de culoare [V dacă nu se spune altfel]
| Sursă | URL | Mărime | Rezoluție | Observații |
|---|---|---|---|---|
| Murray Lab Global CTX Mosaic V01 | https://murray-lab.caltech.edu/CTX/V01/tiles/ (tile `MurrayLab_GlobalCTXMosaic_V01_E-072_N-12.zip`) | 1.73 GB/tile (zip deflate, nu se poate ferestrui) | 5 m, 4°x4°, 88S–88N | Pancromatic [I]. Citare: doi 10.1029/2024EA003555 |
| MOLA-HRSC Blend DEM v2 | https://planetarymaps.usgs.gov/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif | 11.38 GB, int16, 106694x53347, fără tiling/overview | 200 m | Fereastră 56x68 km ≈ 70 MB Range (213 KB/rând). Licență MOLA CC0 / HRSC CC BY-SA 3.0 IGO [S]. Cit. Fergason, Hare & Laura 2018 |
| Viking MDIM 2.1 colour | https://planetarymaps.usgs.gov/mosaic/Mars_Viking_MDIM21_ClrMosaic_global_232m.tif | 12.74 GB, uint8 RGB, 92160x46080, nu e tiled | 231.5 m | Citire 10x10 px la (col 28160, row 25600): RGB mediu ≈ (76, 50, 45), R 60–104, G 33–77, B 25–72. Singura culoare reală |
| THEMIS Day IR MC-18 Coprates | https://astrogeo-ard.s3.us-west-2.amazonaws.com/mars/mo/themis/controlled_mosaics/mc18_coprates_dir/mc18_coprates_dir.tif | 410 MB, uint8 26674x17783, COG cu overviews | 100 m | CC0. Night IR `..._nir` 447 MB |
| HRSC culoare | — | — | — | Nu există pe Trek pentru Melas (HRSC_Martian_east lon -0.27..16.7; MC11E_HRMOSCO_COL lon -22.5..0). Produs ESA PSA pentru Melas: neverificat |

### 1.5 Recomandare culoare [I]
Nu există culoare reală la rezoluție mare. Un singur cel mai bun mod pentru toate nivelurile: luminanță din imagine pancromatică, cromă din Viking MDIM21 (site ≈ RGB 76/50/45).
- 4x4 km: luminanță HiRISE RED (ortho C) + croma Viking; opțional fuzionați banda reală IRB ca referință de tentă (declarați în credite că e fals-color).
- 9x28 km: luminanță CTX ortho 20 m (sau Murray 5 m dacă puteți lua tile-ul de 1.7 GB) + croma Viking.
- 56x68 km: luminanță CTX/Murray (sau THEMIS Day IR 100 m, mai simplu de ferestruit) + croma Viking; relief din MOLA-HRSC 200 m.
- Avertisment pentru pitch: paleta din versiunea veche era "Mars aproximativ", inventată pe banda RED; nu o numiți culoare adevărată.

### 1.6 Mars Trek WMTS [V]
- Template: `https://trek.nasa.gov/tiles/Mars/EQ/<LAYER>/1.0.0/default/default028mm/{z}/{row}/{col}.png`, grilă geografică 2x1 la z0; row = floor((90-lat)/180*2^z), col = floor((lon+180)/360*2^(z+1)). Capabilities incoerente pentru unele straturi.
- Strat pantă care acoperă site-ul (bbox lon -70.77..-69.79, lat -14.95..-9.91, z0–11, 24 m): `CTX_ClrSlope_8bit_12S290E_24mp_D18_034250_1676_D21_035450_1674`.
  - ATENȚIE: tile-ul cu site-ul HiRISE (z8, row 142, col 156) = PNG gol de 334 B. Row 143 col 156: 14 KB; row 142 col 155: 81 KB. Nu vă bazați pe el pentru validare.
- Alte straturi pantă: `CTX_ClrSlope_8bit_10S291E_24mp_P22_009684_1699_B02_010396_1699` (lon -69.52..-68.94, la est), `..._11S289E_24mp_F23_044971_1685_F21_043995_1685` (lat -11.8..-11.03), `..._11S291E_24mp_B19_017187_1685_B19_016976_1685` (lon -69.65..-68.72), `..._12S291E_24mp_F21_043850_1684_F21_043916_1685` (lat -11.9..-11.14).
- Hillshade `CTX_Shade_East_Melas` (lon -71.95..-68.54, lat -18.13..-9.29): tile-uri z8–z11 lângă site goale/mici, excepție row 142 col 155 = 28.6 KB.
- Ortho CTX Trek (`CTX_Ortho_12S290E_6mp_D18_034250_1676`) = 404/gol la toate zoom-urile sondate: folosiți COG-urile USGS.
- Fundal: `Mars_MOLA_blend200ppx_HRSC_ClrShade_clon0dd_200mpp_lzw` (jpg, până la z8; tentă de elevație, nu culoare reală); `THEMIS_DayIR_ControlledMosaics_100m_v2_oct2018` (png, până la z9).

---------------------------------------------------------------------------
## 2. Date de incident (JSON mic, cache-abil)

### 2.1 Solar
- Löwe et al., "Nowcasting Solar Energetic Particle Events for Mars Missions", arXiv 2502.02469 (trimis la Space Weather). Autori: Löwe, Khaksarighiri, Wimmer-Schweingruber, Hassler, Ehresmann, Guo, Reitz, Berger, Matthiä, Zeitlin, Löffner. [V]
  - Nowcast dă "cel puțin 30 de minute" pentru a evita vârful și cea mai mare parte a dozei cumulate. Alertă la rata dozei ≥25% peste fond. 5 evenimente SEP în croazieră, 16 pe suprafață de la aterizare (6 aug 2012).
  - Tabel 1 (adăpost, timp la vârf, avans, doză SEP totală):
    - 2024-05-20: 1d17h55m, 0h53m, 0h57m, 1730.55 µGy. Textul: cel mai mare SEP măsurat pe suprafață; "puțin peste 50 min" pentru a evita vârful și 90% din doză (~1.56 mGy evitate).
    - 2017-09-10: 1d08h01m, 6h49m, 3h44m, 261.79 µGy.
    - Altele: 2021-10-28, 2022-02-15, 2023-03-12, 2024-07-22, 2024-09-02, 2024-09-05.
    - Timp mediu la vârf: 3h37m (suprafață), 10h21m (spațiu adânc).
    - Textul spune când "19 mai 2024", când "20 mai": incoerență în sursă.
- JPL "NASA Watches Mars Light Up During Epic Solar Storm" (10 iun 2024): https://www.jpl.nasa.gov/news/nasa-watches-mars-light-up-during-epic-solar-storm/ [V]
  - Flare 20 mai 2024 estimat X12 (Solar Orbiter). Curiosity RAD: 8,100 µGy pentru un astronaut ipotetic (~30 radiografii), cel mai mare salt de la aterizare. (Altă mărime decât 1730 µGy din Löwe.) MAVEN: cel mai mare SEP văzut vreodată; aurore nocturne 14–20 mai 2024. "Cliffsides or lava tubes would provide additional shielding." Nu declară timp de avans.
- DONKI [V] (api.nasa.gov/DONKI/..., cheie `api_key`; DEMO_KEY are limită; host kauai.ccmc.gsfc.nasa.gov expiră):
  - 20 mai 2024: CME `2024-05-20T05:36:00-CME-001`, 2678 km/s (R) / 1927 km/s (O), semi-unghi 45°, lon 172 (față ascunsă), lat 2; nu ajunge pe Pământ. Nu există flare X pe DONKI Pământ pentru ziua aceea (flare pe partea ascunsă).
  - Rulări WSA-ENLIL cu Marte în impactList (câmp `arrivalTime`):
    - `WSA-ENLIL/30963/1`: finalizat 2024-05-17T13:08Z; CME 2024-05-16T13:38Z, 1452 km/s, lon 120; sosire Marte 2024-05-19T09:15Z (~44 h avans).
    - `30976/1`: sosire 2024-05-20T09:35Z. `30979/1`: 2024-05-20T07:52Z. `31014/1`: 2024-05-21T18:00Z (tangențial).
  - 10 sep 2017: flare X8.2 `2017-09-10T15:35:00-FLR-001` (vârf 16:06Z, AR 12673, S08W88); CME 16:09Z; SEP la 16:25Z (>100 MeV GOES13), 16:45Z, 20:00Z. X9.3 pe 2017-09-06T11:53Z.
  - `/FLR` cu interval într-o singură zi dă 404: folosiți interval mai larg sau tool-ul MCP.
  - 14 oct–14 nov 2026 (din RESEARCH.md): 57 rulări WSA-ENLIL, ~9 CME spre Marte.
- Afirmație corectă despre timpul de avertizare: CME ajunge la Marte în zile (DONKI ~44 h); pe suprafață SEP vin în minute-ore după flare, iar nowcast-ul RAD dă >=30 min (medie vârf 3h37m; cazul extrem 53 min). Regula "30 min" = presupunere de design susținută de Löwe.
- MSL RAD 2017 (Zeitlin 2018 GRL 45, 5845): doze din RESEARCH.md; nu am reverificat azi cifrele GRL [S].
- MAVEN SEP: PDS PPI https://pds-ppi.igpp.ucla.edu/ (landing); căutare directă a colecției nu făcută.

### 2.2 Cutremure de Marte
- MQS V14 (lansare 2023-04-01; 2019-01-12 .. 2022-12-31) [V]. DOI 10.12686/a21, pagină https://www.insight.ethz.ch/seismicity/catalog/v14.
  - QuakeML 1.2 + extensii Marte: https://www.seis-insight.eu/static/mqs-catalogs/v14/events_mars_extended_multiorigin_v14_2023-01-01.xml (36.3 MB); `events_extended_multiorigin_v14_2023-01-01.xml` (23.8 MB). PDF format: `.../mars_seismic_catalogue_insight_v14_end_2023-01-01_release_2023-04-01.pdf` (224 KB).
  - 2715 evenimente parsate. Cele mai mari:
    - S1222a: MbS 5.4 / MbP 4.9, lat -7.63, lon 170.67, "Aeolis Northeast" (Mw ~4.7 [S, neverificat azi]).
    - S1000a: MbS 4.7 / MbP 4.5, lat 23.59, lon -88.93.
    - S0976a: MbS 4.4 / MbP 4.2, lat -9.84, lon -77.98, "Coprates Northwest"; ~465 km vest de demo [C: 7.95° x 59.27 km/° x cos10°].
    - S0235b Mw 3.21 (Elysium SE); S0173a Mw 3.21; S0183a Mw 3.3; S0409d MbS 3.0.
  - Niciun eveniment localizat în Melas. 1422 în "Elysium Southwest", 1269 fără regiune.
- Forme de undă: IPGP FDSN `https://ws.ipgp.fr/fdsnws/dataselect/1/query?net=XB&sta=ELYSE&loc=02&cha=BHU&start=2022-05-04T23:10:00&end=2022-05-04T23:50:00` -> 396 KB miniSEED (fereastra S1222a) [V]. Metadate: `https://ws.ipgp.fr/fdsnws/station/1/query?net=XB&level=channel&format=text`. IRIS dataselect = 301.
- Zenodo 11995107 "InSight denoised seismic event waveforms" (Dahmen et al. 2024), cc-by-4.0, waveforms.zip 94.7 MB [V].
- Prăbușiri de roci: Bickel 2024 GRL 51(24), doi 10.1029/2024GL110674, 1,383 situri; articol CC BY-NC-ND (Crossref); locația setului de date NEGĂSITĂ (Wiley 403; Zenodo/BORIS/Crossref fără rezultat). Sokołowska 2025: Zenodo 15058575 cc-by-4.0 (csv 11 KB) doar Oxia [V]. Vijayan 2022/2026: date negăsite. Verificare "în Melas": nefăcută.
- Song et al. 2026, "Active crustal straining and fault reactivation at Valles Marineris", Nature Communications 17, 15 oct 2026, doi 10.1038/s41467-026-78193-6 (pagina nature.com nefetchabilă). Imperial: https://www.imperial.ac.uk/news/articles/engineering/earth-science/2026/giant-canyon-on-mars-is-still-tectonically-active-today/ — S0976a, 25 aug 2021, adâncime 20–40 km sub partea VESTICĂ a Valles Marineris. Melas nemenționat. Presa secundară: un singur eveniment, probabil strike-slip [S].

### 2.3 Praf
- MDAD (Battalio & Wang 2021, Icarus 354, 114059): 14,974 instanțe, 228 secvențe, 43 majore; prag >100,000 km² și >1 sol; MY24–32. Zenodo v1.1 rec. 7480334 (doi 10.5281/zenodo.7480334, cc-by-4.0): tar.gz per MY, 15–28 MB (MY28–32) + `MDAD_read_masks.ipynb` [V].
- MARCI rapoarte săptămânale: https://www.msss.com/msss_images/2018/06/13/ (4–10 iun 2018, MSSS-534) și /2018/04/18/ (MSSS-526) [V 200].
- REMS în furtuna 2018: tau vârf ≈ 8.5 (Guzewich et al., GRL), ~97% UV atenuat; UV zilnic maxim -90% între sol 2075 (tau ~1) și 2085 (tau ~8.5); Navcam tau >9 [S]. MEDA tau 2018: N/A (Perseverance nu aterizase).
- MCD: https://www-mars.lmd.jussieu.fr/mcd_python/ și https://www-mars.lmd.jussieu.fr/mars/access.html [V 200]. PyPI `pymcd` 0.2.1 (MIT).
- REMS JSON: https://mars.nasa.gov/rss/api/?feed=weather&category=msl&feedtype=json (1.73 MB) [V]. MEDA PDS: https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda/ [V]. MSL RAD PDS PPI: https://pds-ppi.igpp.ucla.edu/data/MSL-M-RAD-3-RDR-V1.0/ [V].
- MCS (opacitate praf gridată, Montabone): neverificat.

### 2.4 Horizons (https://ssd.jpl.nasa.gov/api/horizons.api) [V]
- Corp 499 e pozitiv-vest. Interogare Soare Az/El la site: `COMMAND='10'`, `CENTER='coord@499'`, `COORD_TYPE='GEODETIC'`, `SITE_COORD='-290.03,-10.0,-3.0'` (est negativ la input; afișat W-lon 69.97), `EPHEM_TYPE='OBSERVER'`, `QUANTITIES='4'`, `ANG_FORMAT='DEG'`, `CSV_FORMAT='YES'`.
- Rezultate 2026-11-15 UT (Az, El): 06:00 312.56/+61.90; 07:00 297.68/+50.05; 08:00 289.65/+36.85; 09:00 284.65/+23.09; 10:00 281.18/+9.07; 11:00 278.55/-5.10; 12:00 276.42/-19.36.
- Lumină unidirecțională Pământ–Marte: `CENTER='500@499'`, `COMMAND='399'`, `QUANTITIES='20'`: delta 1.31605362 AU (2026-11-15 00:00), 1.30752318 AU (11-16). t = delta x 499.00478 s = 656.7 s = 10.945 min (RESEARCH spunea 11.0).

---------------------------------------------------------------------------
## 3. Repo-uri și biblioteci (gh api, 14 nov 2026) [V]

| Repo | Licență | Stare | Folosire |
|---|---|---|---|
| nasa/openmct | Apache-2.0 (LICENSE.md; GitHub arată NOASSERTION) | v4.3.1 (2026-08-31), push 2026-11-12, 13.2k stele | Dashboard telemetrie; referință pentru UI |
| NASA-AMMOS/MMGIS | Apache-2.0 | 5.2.24, push 2026-11-14, 240 stele (+ MMGIS-Plugins Apache-2.0) | Hartă web pentru misiuni; model de straturi |
| NASA-AMMOS/3DTilesRendererJS | Apache-2.0 | v0.5.4, push 2026-11-11, 2.5k stele | Încărcare 3D Tiles în web |
| CesiumGS/cesium-unreal | Apache-2.0 | v2.31.0, push 2026-11-10 | Streaming 3D Tiles în Unreal (relevant pentru UE) |
| nasa/NASA-3D-Resources | fără fișier de licență (README: "free and without copyright") | 3.9k stele, push 2025-06-03 | Modele habitat/costum/rover; vezi secțiunea 4 |
| nasa-jpl/SPOC | fără licență | învechit (2020-05) | Nu |
| AI4Mars / ENav / MLNav | negăsite sub nasa / nasa-jpl / NASA-AMMOS (doar fork-uri comunitare AI4Mars; setul de date găzduit în altă parte, neverificat) | — | Nu pe ore |
| SUITS-Techteam/TSS2026 | fără licență, push 2026-09-01 | `data/EVA.json` 2.6 KB | Numai model de nume de câmpuri (nu copiați) |
| ordinatum/walkback-envelope | MIT | 0 stele, push 2026-11-14 | Reverse Dijkstra din habitat, 4 canale de consumabile, rezervă 25%, Pandolf la 0.38 g, RAD 0.64 mSv/zi, MOLA+HRSC 200 m |
| crazymage05/marswalk-space-apps-2026 | — | 404 azi (gh api și curl); contul are 3 repo-uri publice fără legătură | Concurent: repo șters/redenumit/privat. Afirmația din RESEARCH că README-ul a fost verificat pe 14 nov nu mai e reproductibilă |
| DOI-USGS/ale, DOI-USGS/ISIS3 | Apache / NOASSERTION | active | Instrumente USGS (nu necesare) |

Corecție la RESEARCH: README-ul walkback-envelope spune acum că adaptarea Pandolf e euristică, comparată doar "în scară" cu Apollo (780–1200 BTU/h), "not validated for suited walking on Mars". NU e "calibrat pe Apollo".

Câmpuri telemetrie EVA (TSS2026 `data/EVA.json`; doar nume): primary_battery_level, secondary_battery_level, oxy_pri_storage, oxy_sec_storage, oxy_pri_pressure, oxy_sec_pressure, suit_pressure_oxy/co2/other/total, helmet_pressure_co2, fan_pri_rpm, fan_sec_rpm, scrubber_a_co2_storage, scrubber_b_co2_storage, temperature, coolant_storage, coolant_gas_pressure, coolant_liquid_pressure, heart_rate, oxy_consumption, co2_production, eva_elapsed_time; plus blocuri `dcu`, `error` (fan/oxy/power/scrubber_error), `imu` (posx, posy, heading), `uia`. Server port 14141 (HTTP + UDP).

### Biblioteci Python (PyPI azi) [V]
Deja în toolkit/uv.lock: rasterio 1.5.2, numpy 2.5.4, pyproj 3.8.0, shapely 2.2.0, pystac-client 0.9.1, geopandas 1.2.0, xarray 2026.9.0, astroquery 0.4.11, earthaccess 0.19.0.
- rasterio 1.5.2 (BSD-3): citiri fereastră COG prin /vsicurl/.
- numba 0.68.1 (BSD): bucle A*, orizont, viewshed rapide (nu există bibliotecă gata de viewshed/orizont; scrieți baleiaj numba).
- scipy 1.18.1; scikit-image 0.26.0; networkx 3.7.
- scikit-fmm 2025.6.23 (fast marching / Eikonal; licență GitHub NOASSERTION, stil BSD [S]).
- pyastar2d 1.1.4 (MIT, 2026-02-22): A* pe grilă 2D.
- whitebox 2.3.6 (MIT, învelitoare peste WhiteboxTools MIT): pantă/orizont/viewshed.
- richdem 0.3.4: GPL-3.0, ultima versiune 2018. EVITAȚI (incompatibil cu Apache-2.0).
- spiceypy 8.4.0 (MIT) / skyfield 1.55 (MIT): efemeride locale.
- astroquery 0.4.11 (BSD): Horizons.
- rio-tiler 9.4.13, rio-cogeo 7.0.4; xdem 0.2.3 (Apache-2.0): comparare DEM; obspy 1.5.1 (LGPL): miniSEED; pymcd 0.2.1 (MIT).
- Pachetul PyPI "horizon" nu are legătură.

---------------------------------------------------------------------------
## 4. Active (SOURCE.txt de pe disc) — licențe și credite

Locație: `.../scratchpad/zip_extract/assets_src/<folder>/SOURCE.txt`. Neauzite/neinspectate vizual de agent.

### Modele
| Folder | Conținut | Licență / credit | Probleme |
|---|---|---|---|
| astronaut_sketchfab_ccby_jpeg / _specgloss_png | "Astronaut" 58,312 fețe, 4 animații (Sketchfab, Javi_DaviYT) | CC-BY-4.0 (din extras GLB; API Sketchfab confirmă) | Proveniență dubioasă: descrierea uploaderului "Cool astronaut I found!"; același model apare la LasquetiSpice. Descărcat din mirror GitHub fără licență. Risc de atribuire; nu-l folosiți ca erou |
| modelviewer_astronaut | Poly by Google, 1.6k tri, static | CC-BY (dedus, nu verificat byte cu byte) | Nu e rigged |
| modelviewer_robotexpressive | Robot cu 43 de oase, 14 animații (Walking, Running...) | CC0 (Tomas Laulhe/Quaternius; mod. Don McCurdy) | Robot, nu astronaut |
| nasa_astronaut | static, ~6.4k tri, Draco+webp | NASA-3D-Resources: "free and without copyright"; credit NASA, fără a sugera aprobare, fără insignă | Nu e rigged. Repo-ul nu are fișier de licență |
| nasa_eva_suit | EMU Shuttle, 6.4k tri, 19 materiale | idem | static |
| nasa_habitat_demonstration_unit | HDU part1 2.3k + part2 4.3k tri | idem | static, scară mare |
| nasa_mark3_spacesuit | 69k tri | idem | static |
| nasa_z2_spacesuit | 31k tri, 16.9 MB | idem | static |
| nasa_space_exploration_vehicle | MMSEV rover presurizat, 413k tri, 22.4 MB | idem | decimați |
| nasa_perseverance | ~200k tri, 1 skin 15 oase, 23 clipuri | NASA/JPL-Caltech, ghid media NASA | Draco |
| smithsonian_neil_armstrong_suit | foto-scan 43.6k tri, static | CC0 Smithsonian Open Access, NEVERIFICAT, fără credit în GLB | verificați pe https://3d.si.edu înainte de livrare |
| polypizza_astronauts/quaternius_astronaut_3hC2i0CTuO.glb | astronaut în costum, 10.6k tri, 62 oase, 24 animații incl. Idle, Walk, Run, Interact, Wave | **CC0 1.0 (Quaternius)** | RECOMANDAT; stilizat low-poly, culori plate. Pistol/sword în unele clipuri: folosiți doar Idle/Walk/Run/Interact |
| polypizza_astronauts alți | Quaternius animale-astronaut (CC0, 18 anim), Polygonal Mind (CC0, static), J-Toastie (CC-BY 3.0, schelet Mixamo, 0 animații, steag SUA), Poly by Google/PW Wu (CC-BY 3.0, static) | vezi licențele | J-Toastie are nevoie de atribuire și clipuri retargetate (netestat) |
| quaternius_space_kit_props | rover_a/b, round_rover, base_large, geodesic_dome, house_*, connector, solar_panel_ground, roof_radar, rock_* | CC0 (Quaternius, Ultimate Space Kit) | stilizat, static |
| polyhaven_ground_textures | red_laterite_soil_stones (Amal Kumar), sandy_gravel_02 (Dario Barresi), dry_ground_rocks (Rob Tuytel) | CC0 Poly Haven | neinspectate vizual |
| polyhaven_rocks | moon_rock_01..04, rock_09, namaqualand_boulder_03 | CC0 Poly Haven (Greg Zaal, Rico Cilliers, Jenelle van Heerden, Dario Barresi) | |
| threejs_soldier / threejs_xbot | Mixamo Vanguard / X Bot, rigged | Termeni Mixamo; licență neclară pentru redistribuire | doar fallback dev / sursă animații; nu livrați |

### Audio
- kenney_audio: CC0 (Kenney; sci-fi-sounds, interface-sounds, digital-audio, impact-sounds), neauzite.
- opengameart_sfx: CC0 pe fiecare pagină (wind1/2 Luke.RUSTLTD, rumble cinameng, shake.flac mieki256, deep_rumble gmason, alarm yd/qubodup), neauzite; WAV/FLAC de convertit.
- openverse_audio: CC0 1.0 pe Freesound (alarm chungus43A, quake_short TheMinkman etc.), preview-uri MP3 HQ.
- voice/ (certificate, dust, intro, opportunity, quake, replan, sep): fără SOURCE.txt. AI_USE.md/BUILD_LOG vechi spun: 7 replici sintetizate cu ElevenLabs (voce "River"), aprobate de user, declarate în AI_USE.md. **Încalcă regula "fără active generate de AI" din brief**: marcați și treceți în SI-LOG.md sau înlocuiți cu TTS local declarat / înregistrare reală.

### Concluzie active [I]
Hero astronaut: Quaternius `3hC2i0CTuO` (CC0, Walk/Idle/Run). Habitat/rover/costume realiste: NASA-3D-Resources (static; credit NASA; repo fără licență explicită, deci atribuție obligatorie, risc mic). Props stilizate: Quaternius Space Kit (CC0). Texturi/roci: Poly Haven CC0. Nu am găsit azi un astronaut realist rigged + animat cu licență CC0/CC-BY (nu am căutat exhaustiv pe Sketchfab dincolo de SOURCE.txt) [I].

---------------------------------------------------------------------------
## 5. Cifre de validare (fiecare <1 oră)

1. Teren: comparați pantă/elevație din DTM HiRISE (agregat la 20 m) cu DTM-ul CTX din aceeași pereche stereo (USGS STAC) și cu MOLA-HRSC 200 m. Așteptat: offset CTX față de MOLA -20.46 m (qa_metrics), bias CTX->HiRISE 10.9 m / RMS 38 m pe perete (BUILD_LOG). Raportați RMSE și bias pe nucleu. NU folosiți stratul pantă Trek (gol la site).
2. SEP: reproduceți din profil doză-rată de tip RAD timpul la vârf, avansul și doza din Löwe Tabel 1: 2024-05-20 (53 min / 57 min / 1730.55 µGy) și 2017-09-10 (6h49m / 3h44m / 261.79 µGy). Dacă ieșirea motorului se abate >5%, declarați-o.
3. Efemeride: lumină 10.945 min (Horizons, 1.31605 AU, 2026-11-15) și Az/El Soare (tabelul 2.4) versus calcul independent SPICE/skyfield; diferență așteptată <1 s și <0.1°.
- Neutilizabil fără sursă: consumabile vs Apollo 14 EVA-2 "31.7% O2 rămas" — nesursat azi; walkback-envelope declară doar concordanță de scară. Nu spuneți "calibrat".

---------------------------------------------------------------------------
## 6. Corecții pentru pitch

| Afirmație | Verdict | Sursă / formulare |
|---|---|---|
| (a) "Cea mai puternică furtună solară măsurată la suprafață a atins vârful la 53 min" | CONFIRMAT [V] | Löwe et al., Tabel 1: eveniment 2024-05-20, timp la vârf 0h53m, avans 57 min. Formulare: "cel mai mare eveniment SEP măsurat de MSL/RAD pe suprafața lui Marte (20 mai 2024) a atins vârful la 53 min după debut; nowcast-ul dădea ~57 min avans". Nu amestecați cu 8,100 µGy (JPL) |
| (b) "Melas Chasma, locul de aterizare cel mai votat al NASA" | NU așa cum e formulat [V] | Planetary Society, 22 ian 2016 (https://www.planetary.org/articles/20160122-nasa-h2m-landing-site-selection): Melas a fost favorit cu nouă voturi între primele trei (Melas, Jezero, Gale) în feedback informal din atelier, 47 zone propuse; nu clasament oficial, fără selecție imediată. Spuneți: "unul dintre cele trei favorite în feedback-ul informal al atelierului H2M 2015" |
| (c) "Sistem de canioane arătat în 2026 ca fiind activ tectonic" | CONFIRMAT pentru Valles Marineris, NU pentru Melas [V/S] | Song et al. 2026, Nat Commun 17, doi 10.1038/s41467-026-78193-6; Imperial: S0976a (25 aug 2021) sub vestul VM. Bazat pe un singur eveniment [S] |
| (d) "Civil Space Shortfalls, 2026" | CONFIRMAT [V] | "2026 Civil Space Shortfalls", publicat 12 ian 2026: https://www.nasa.gov/wp-content/uploads/2026/03/2026-civil-space-shortfalls.pdf (299 KB). Shortfall 8.0 "Perform safe, Earth-independent EVAs on the Martian surface"; Need 8.06 "Provide in-situ decision support tools to address identified EVA hazards and risks on the Martian surface". FY26 Prioritization (https://www.nasa.gov/wp-content/uploads/2026/05/fy26-civil-space-shortfall-prioritization.pdf, 638 KB) plasează SF08 pe locul 24 din 32: nu spuneți "prioritate maximă" |

---------------------------------------------------------------------------
## 7. De făcut de om
1. Descărcare manuală / citire COG: HiRISE DTM + RED/IRB C ortho (≈195+58+30 MB), opțional CTX DTM/ortho (~100 MB). Ferestre COG prin rasterio sunt posibile.
2. Murray tile (1.7 GB zip), MOLA-HRSC DEM (11.4 GB; fereastră ≈70 MB), Viking (12.7 GB; fereastră mică): de făcut pe conexiune bună; pot fi ferestruite prin Range.
3. VPN sau DoH pentru `*.wustl.edu` (Vodafone RO blochează DNS-ul).
4. Token Earthdata deja în `toolkit/.env` (valabil până 13 ian 2027). DONKI: cheie NASA proprie (DEMO_KEY are limită); host kauai nesigur.
5. Bickel 2024: de luat manual din "Data availability" a articolului (nu am găsit setul).
6. SI-LOG.md: intrare pentru vocea ElevenLabs și orice alt activ generat AI; verificați https://3d.si.edu pentru costumul Armstrong dacă îl folosiți.
7. Citări obligatorii: lista din secțiunile de mai sus (USGS Astrogeology CC0, Murray Lab doi 10.1029/2024EA003555, Fergason 2018, Löwe 2025, Song 2026, Battalio & Wang 2021, Dahmen 2024).

## Nerezolvat
Date Bickel/Vijayan; verificare prăbușiri în Melas; MCS; repo-uri AI4Mars/ENav/MLNav; HRSC color Melas pe ESA PSA; cifra Apollo 14 31.7% O2; Mw 4.7 S1222a (secundar); cifre exacte RAD 2017 reverificate la sursă.
