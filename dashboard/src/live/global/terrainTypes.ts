// Messages between loadAnywhere (main thread) and terrainWorker (fetch + resample + derived layers).

/** Simple cylindrical (equirectangular) projection on the IAU 2015 Mars sphere, as used by the USGS DTM COGs. */
export interface EqcProj { R: number; clonDeg: number; latTsDeg: number }

/** One DTM cloud-optimised GeoTIFF found through the USGS STAC catalog. */
export interface CogSource {
  kind: 'hirise' | 'ctx'
  id: string
  url: string
  gsd: number                       // native post spacing (m)
  proj: EqcProj
  transform: number[]               // STAC proj:transform [x0, dx, 0, y0, 0, dy] (full-resolution image)
  shape: [number, number]           // [rows, cols] of the full-resolution image
  orthoUrl: string | null           // co-registered orthoimage COG (HiRISE RED ortho / CTX DRG), if any
}

export interface TerrainJob {
  lon0: number; lat0: number        // box centre, deg E (-180..180) / deg N
  primary: CogSource | null         // null: global 200 m DEM only
  globalUrl: string                 // ArcGIS ImageServer base URL of the MOLA/HRSC blend DEM
}

export interface TerrainStats {
  bytes: number                     // bytes received by the worker (Content-Length sum)
  requests: number
  primaryReadResM: number           // post spacing actually read from the COG (overview), 0 if none
  fillFrac: number                  // share of core vertices filled from the global DEM
  globalOffsetM: number             // median (DTM - global DEM) applied to the global fill
  sourceCells: number               // steep (>= 32 deg) rockfall source cells on the 24 m beta grid
  ms: Record<string, number>
}

export interface TerrainResult {
  coreH: Float32Array; regH: Float32Array; farH: Float32Array
  z: Float32Array; slope: Float32Array; slopeFine: Float32Array; rough: Float32Array
  beta: Float32Array; sky: Float32Array; pit: Float32Array; sand: Float32Array
  regSlope: Uint8Array; regBeta: Uint8Array
  ortho: { px: number; rgba: Uint8ClampedArray; note: string } | null   // north-up image of the core box
  zr: { core: [number, number]; reg: [number, number]; far: [number, number] }
  stats: TerrainStats
}

export type TerrainReply =
  | { type: 'progress'; label: string; frac: number }
  | { type: 'done'; result: TerrainResult }
  | { type: 'error'; message: string }

// Grid geometry shared by both sides (metres). Core box: 4 km, corner at local (0, 0).
export const R_MARS = 3396190
export const CORE = { size: 4000, n: 1601, renderCell: 2.5, na: 800, cell: 5 } as const
export const REG = { cell: 16, nx: 576, ny: 576 } as const       // 9216 m box centred on the core
export const FAR = { cell: 80, nx: 320, ny: 320 } as const       // 25.6 km box centred on the core
export const REG_E0 = (CORE.size - REG.cell * REG.nx) / 2         // -2608
export const FAR_E0 = (CORE.size - FAR.cell * FAR.nx) / 2         // -10800
