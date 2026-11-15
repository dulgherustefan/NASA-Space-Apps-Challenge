// "Any location on Mars": find the best elevation model that covers a 4 km box around a clicked point,
// grade it, and turn it into the same SiteData the live engine and 3D view use for the bundled site.
//
// Sources (all public, CORS-enabled, verified from a browser on 2026-11-15; see docs/research/live/terrain_access.md):
//   1. USGS Astrogeology STAC  mro_hirise_socet_dtms        HiRISE DTMs, ~1 m   -> 'eva'
//   2. USGS Astrogeology STAC  mro_ctx_controlled_usgs_dtms CTX DTMs, 20 m      -> 'planning'
//   3. NASA Trek ImageServer   MOLA/HRSC blend DEM, 200 m (global)              -> 'unsuitable'
// The DTMs are cloud-optimised GeoTIFFs on S3, read with range requests (only the window, at a COG
// overview close to the 2.5 m render spacing). Heavy work runs in terrainWorker.ts.
import type { LoadedSite, SiteDescriptor, Grade } from '../types'
import type { SiteData, SiteMeta } from '../engine/site'
import {
  CORE, REG, FAR, REG_E0, FAR_E0, R_MARS,
  type CogSource, type EqcProj, type TerrainJob, type TerrainReply, type TerrainResult,
} from './terrainTypes'

const STAC = 'https://stac.astrogeology.usgs.gov/api/collections'
const GLOBAL_DEM = 'https://trek.nasa.gov/mars/trekarcgis/rest/services/Mars_MOLA_blend200ppx_HRSC_DEM_clon0dd_200mpp_lzw/ImageServer'
const D2R = Math.PI / 180
const MAX_SHIFT_M = 2500

export const CREDIT = {
  hirise: 'NASA/JPL/University of Arizona/USGS',
  ctx: 'NASA/JPL/MSSS/USGS',
  global: 'NASA/MOLA, ESA/DLR/FU Berlin HRSC, USGS',
}

/** Last load's timings and sizes, for the dev harness and the write-up. */
export let lastLoadStats: (TerrainResult['stats'] & { stacMs: number; totalMs: number }) | null = null

type Progress = (label: string, frac: number) => void

// ----------------------------------------------------------------------------- STAC search

interface Candidate { src: CogSource; rings: number[][][] }

function parseProj(wkt: string): EqcProj | null {
  if (!/Equirectangular|Equidistant_Cylindrical|Plate_Carree/i.test(wkt)) return null
  const num = (re: RegExp, d: number) => { const m = wkt.match(re); return m ? Number(m[1]) : d }
  const R = num(/SPHEROID\[\\*"[^"\\]*\\*",\s*([\d.]+)/i, R_MARS)
  return {
    R: R > 3e6 ? R : R_MARS,
    clonDeg: num(/central_meridian\\*",\s*(-?[\d.]+)/i, 0),
    latTsDeg: num(/standard_parallel_1\\*",\s*(-?[\d.]+)/i, 0),
  }
}

interface StacFeature {
  id: string
  geometry: { type: string; coordinates: unknown }
  properties: Record<string, unknown>
  assets: Record<string, { href: string }>
}

async function stacSearch(collection: string, kind: 'hirise' | 'ctx', bbox: number[], signal?: AbortSignal): Promise<Candidate[]> {
  const url = `${STAC}/${collection}/items?bbox=${bbox.map(v => v.toFixed(4)).join(',')}&limit=100`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`STAC ${collection}: HTTP ${res.status}`)
  const fc = await res.json() as { features?: StacFeature[] }
  const out: Candidate[] = []
  for (const ft of fc.features ?? []) {
    const p = ft.properties
    const proj = parseProj(String(p['proj:wkt2'] ?? ''))
    const asset = kind === 'hirise' ? ft.assets.dtm : (ft.assets.geoid_adjusted_dem ?? ft.assets.dem)
    const tr = p['proj:transform'] as number[] | undefined, shape = p['proj:shape'] as [number, number] | undefined
    if (!proj || !asset || !tr || !shape) continue
    const g = ft.geometry
    const rings = g.type === 'Polygon' ? [(g.coordinates as number[][][])[0]]
      : g.type === 'MultiPolygon' ? (g.coordinates as number[][][][]).map(pp => pp[0]) : []
    if (!rings.length) continue
    const orthoKey = kind === 'hirise'
      ? Object.keys(ft.assets).filter(k => /^ortho_\d+$/.test(k)).sort((a, b) => Number(!/RED_C/.test(ft.assets[a].href)) - Number(!/RED_C/.test(ft.assets[b].href)))[0]
      : 'orthoimage'
    const orthoUrl = orthoKey && ft.assets[orthoKey] ? ft.assets[orthoKey].href : null
    out.push({ rings, src: { kind, id: ft.id, url: asset.href, gsd: Number(p.gsd ?? Math.abs(tr[1])), proj, transform: tr, shape, orthoUrl } })
  }
  return out
}

function inRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

const wrap180 = (d: number) => ((d + 540) % 360) - 180

/** Share of the 4 km box (7x7 sample points) that lies inside the DTM footprint polygon. The STAC
 *  footprints are coarse outlines (HiRISE strips are slanted), so the real coverage is checked again
 *  after reading and any gap is filled from the global DEM. */
function boxCover(c: Candidate, lon: number, lat: number): number {
  const Rc = R_MARS * Math.cos(lat * D2R)
  const h = CORE.size / 2
  let k = 0
  for (let a = 0; a <= 6; a++) for (let b = 0; b <= 6; b++) {
    const e = -h + a * h / 3, s = -h + b * h / 3
    const lo = wrap180(lon + e / Rc / D2R), la = lat - s / R_MARS / D2R
    if (c.rings.some(r => inRing(lo, la, r))) k++
  }
  return k / 49
}

/** Best box centre within MAX_SHIFT_M of the click: most footprint cover, small shifts preferred. */
function fitBox(c: Candidate, lon: number, lat: number): { lon: number; lat: number; shiftM: number; cover: number } | null {
  const c0 = boxCover(c, lon, lat)
  if (c0 >= 0.85) return { lon, lat, shiftM: 0, cover: c0 }
  const Rc = R_MARS * Math.cos(lat * D2R)
  let best = { lon, lat, shiftM: 0, cover: c0 }, bestScore = c0
  for (let r = 500; r <= MAX_SHIFT_M; r += 500) {
    for (let i = 0; i < 12; i++) {
      const a = 2 * Math.PI * i / 12
      const lo = wrap180(lon + r * Math.cos(a) / Rc / D2R), la = lat + r * Math.sin(a) / R_MARS / D2R
      const cv = boxCover(c, lo, la), score = cv - r / 20000
      if (score > bestScore + 1e-9) { best = { lon: lo, lat: la, shiftM: r, cover: cv }; bestScore = score }
    }
  }
  return best.cover >= 0.8 ? best : null
}

// ----------------------------------------------------------------------------- ortho image

/** RGBA pixels from the worker -> same-origin blob URL (usable as an <img> and a WebGL texture). */
async function orthoBlobUrl(o: NonNullable<TerrainResult['ortho']>): Promise<string | null> {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = o.px
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.putImageData(new ImageData(new Uint8ClampedArray(o.rgba), o.px, o.px), 0, 0)
  const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', 0.9))
  return blob ? URL.createObjectURL(blob) : null
}

// ----------------------------------------------------------------------------- worker

function runWorker(job: TerrainJob, onProgress?: Progress, signal?: AbortSignal): Promise<TerrainResult> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./terrainWorker.ts', import.meta.url), { type: 'module' })
    const stop = () => { w.terminate(); reject(new DOMException('Terrain load aborted', 'AbortError')) }
    signal?.addEventListener('abort', stop, { once: true })
    w.onmessage = (ev: MessageEvent<TerrainReply>) => {
      const m = ev.data
      if (m.type === 'progress') { onProgress?.(m.label, m.frac); return }
      signal?.removeEventListener('abort', stop)
      w.terminate()
      if (m.type === 'done') resolve(m.result)
      else reject(new Error(m.message))
    }
    w.onerror = (e) => { signal?.removeEventListener('abort', stop); w.terminate(); reject(new Error(`terrain worker failed: ${e.message}`)) }
    w.postMessage(job)
  })
}

// ----------------------------------------------------------------------------- public API

const fmtLon = (lonE: number) => `${lonE.toFixed(3)}°E`
const fmtLat = (lat: number) => `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'}`

/**
 * Loads a 4 km planner box centred near (lon, lat) from the best available elevation model.
 * lon: planetocentric deg E (-180..360), lat: deg N.
 */
export async function loadAnywhere(lon: number, lat: number, onProgress?: Progress, signal?: AbortSignal): Promise<LoadedSite> {
  const t0 = performance.now()
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 85) throw new Error('Pick a point between 85°S and 85°N')
  const lonE0 = ((lon % 360) + 360) % 360
  const lon180 = lonE0 > 180 ? lonE0 - 360 : lonE0

  // 1. what covers it?
  onProgress?.('Searching USGS DTM catalog', 0.02)
  const Rc = R_MARS * Math.cos(lat * D2R)
  const span = CORE.size / 2 + MAX_SHIFT_M
  const bbox = [lon180 - span / Rc / D2R, lat - span / R_MARS / D2R, lon180 + span / Rc / D2R, lat + span / R_MARS / D2R]
  const [hi, ctx] = await Promise.all([
    stacSearch('mro_hirise_socet_dtms', 'hirise', bbox, signal).catch(() => [] as Candidate[]),
    stacSearch('mro_ctx_controlled_usgs_dtms', 'ctx', bbox, signal).catch(() => [] as Candidate[]),
  ])
  const stacMs = performance.now() - t0
  signal?.throwIfAborted()
  const pick = (cs: Candidate[]) => {
    let best: { c: Candidate; lon: number; lat: number; shiftM: number; cover: number } | null = null
    const score = (b: { shiftM: number; cover: number }, gsd: number) => b.cover - b.shiftM / 20000 - gsd / 1000
    for (const c of cs) {
      const fit = fitBox(c, lon180, lat)
      if (fit && (!best || score(fit, c.src.gsd) > score(best, best.c.src.gsd))) best = { c, ...fit }
      if (best && best.shiftM === 0 && best.cover >= 0.999 && c.src.kind === 'ctx') break
    }
    return best
  }
  const chosen = pick(hi) ?? pick(ctx)
  const lon0 = chosen ? chosen.lon : lon180, lat0 = chosen ? chosen.lat : lat
  const src = chosen?.c.src ?? null

  // 2. terrain + image of the box (worker)
  onProgress?.(src ? `Found ${src.kind === 'hirise' ? 'HiRISE' : 'CTX'} DTM ${src.id}` : 'No DTM here: using the global 200 m DEM', 0.08)
  const res = await runWorker({ lon0, lat0, primary: src, globalUrl: GLOBAL_DEM }, onProgress, signal)
  const orthoUrl = res.ortho ? await orthoBlobUrl(res.ortho).catch(() => null) : null
  signal?.throwIfAborted()

  // 3. grade + descriptor
  const lonE = ((lon0 % 360) + 360) % 360
  const shiftM = chosen?.shiftM ?? 0
  const shiftNote = shiftM > 0 ? ` The box was moved ${(shiftM / 1000).toFixed(1)} km from the clicked point so it lies on the DTM footprint.` : ''
  const fillNote = res.stats.fillFrac > 0.01 ? ` ${(res.stats.fillFrac * 100).toFixed(0)} % of the box had no DTM data and was filled from the 200 m global DEM.` : ''
  let grade: Grade, gradeReason: string, source: string, sourceResM: number
  if (src?.kind === 'hirise') {
    grade = 'eva'
    gradeReason = `HiRISE stereo DTM (~${src.gsd.toFixed(1)} m posts, read at ${res.stats.primaryReadResM} m): resolves slopes, steps and scarps at walking scale; single boulders under ~2 m are not resolved.`
    source = `USGS STAC mro_hirise_socet_dtms ${src.id} (CC0); credit ${CREDIT.hirise}`
    sourceResM = src.gsd
  } else if (src?.kind === 'ctx') {
    grade = 'planning'
    gradeReason = `CTX stereo DTM (~${src.gsd.toFixed(0)} m posts): good enough to plan a route corridor, but steps, boulders and short steep pitches under ~40 m are invisible. Check with HiRISE before walking it.`
    source = `USGS STAC mro_ctx_controlled_usgs_dtms ${src.id} (CC0); credit ${CREDIT.ctx}`
    sourceResM = src.gsd
  } else {
    grade = 'unsuitable'
    gradeReason = 'No HiRISE or CTX DTM covers this point. ~200 m posts cannot resolve boulders, steps or slopes at walking scale.'
    source = `Mars_MOLA_blend200ppx_HRSC_DEM (NASA Trek ImageServer, MOLA/HRSC blend DEM v2); credit ${CREDIT.global}`
    sourceResM = 200
  }
  // the grade describes the data actually under the box, not the catalog match
  const fill = res.stats.fillFrac
  if (src && fill > 0.5) {
    grade = 'unsuitable'
    gradeReason = `The ${src.kind === 'hirise' ? 'HiRISE' : 'CTX'} DTM ${src.id} covers only ${((1 - fill) * 100).toFixed(0)} % of the box; the rest comes from the 200 m global DEM. ~200 m posts cannot resolve boulders, steps or slopes at walking scale.`
  } else if (src?.kind === 'hirise' && fill > 0.15) {
    grade = 'planning'
    gradeReason = `HiRISE DTM ${src.id} covers ${((1 - fill) * 100).toFixed(0)} % of the box; the rest is the 200 m global DEM, so only the HiRISE part is EVA-grade.`
  }
  gradeReason += shiftNote + (fill > 0.5 ? '' : fillNote)
  const id = `live_${lonE.toFixed(4)}_${lat0.toFixed(4)}`
  const desc: SiteDescriptor = {
    id, name: `${fmtLat(lat0)} ${fmtLon(lonE)}`, lon: lonE, lat: lat0,
    sizeM: CORE.size, cellM: CORE.cell, n: CORE.na,
    source, sourceResM, grade, gradeReason, bundled: false,
    orthoUrl,
    orthoNote: orthoUrl && res.ortho ? res.ortho.note : 'No image of the box',
  }

  // 4. SiteData (SiteMeta-compatible; local frame corner = core corner, so core.e0 = s0 = 0)
  const half = CORE.size / 2
  const lonW = lon0 - half / (R_MARS * Math.cos(lat0 * D2R)) / D2R, latN = lat0 + half / R_MARS / D2R
  const meta: SiteMeta = {
    site: desc.name, lat0, radius: R_MARS,
    origin: { projX: R_MARS * lonW * D2R, projY: R_MARS * latN * D2R, lon: lonW, lat: latN },
    core: {
      e0: 0, s0: 0, size: CORE.size, renderCell: CORE.renderCell, n: CORE.n, cell: CORE.cell, na: CORE.na,
      zMin: res.zr.core[0], zMax: res.zr.core[1],
      layers: ['slope', 'slope_mean', 'rough', 'beta', 'sky', 'pit', 'albedo', 'sand'],
      scale: { slope: 3, slope_mean: 3, rough: 100, beta: 6, sky: 255, pit: 10, albedo: 255, sand: 255 },
      ortho: '', orthoPx: res.ortho?.px ?? 0, centerLon: lon0, centerLat: lat0,
    },
    reg: { e0: REG_E0, s0: REG_E0, w: REG.cell * REG.nx, h: REG.cell * REG.ny, cell: REG.cell, nx: REG.nx, ny: REG.ny,
      zMin: res.zr.reg[0], zMax: res.zr.reg[1], ortho: '', orthoCell: 0, layers: ['slope', 'beta'] },
    far: { e0: FAR_E0, s0: FAR_E0, w: FAR.cell * FAR.nx, h: FAR.cell * FAR.ny, cell: FAR.cell, nx: FAR.nx, ny: FAR.ny,
      zMin: res.zr.far[0], zMax: res.zr.far[1], ortho: '', orthoCell: 0 },
    rockfall: { sourceSlopeDeg: 32, alphas: [12, 14, 16.2, 18.4, 20, 21.8, 24, 26, 27.8, 29.5, 31.4, 33, 34.8, 37],
      method: 'approximate: max atan(dz/d) to steep (>= 32 deg) source cells within 1.2 km, 24 m grid (live loader)' },
    ctxOffsetM: res.stats.globalOffsetM, ctxResidualRmsM: 0,
    sources: {
      dem: source,
      global_dem: `Mars_MOLA_blend200ppx_HRSC_DEM (gap fill / wide context); credit ${CREDIT.global}`,
      ortho: desc.orthoNote,
      layers: 'slope 10 m baseline; rough and slopeFine from 2.5 m heights (HiRISE) or constant/equal to slope (CTX, global); beta and sky approximate; sand and pit unknown (0)',
    },
  }
  const { core } = meta
  const Z0 = Math.round((core.zMin + core.zMax) / 2 / 10) * 10
  const site: SiteData = {
    meta, Z0, coreH: res.coreH, regH: res.regH, farH: res.farH,
    z: res.z, slope: res.slope, slopeFine: res.slopeFine, rough: res.rough, beta: res.beta, sky: res.sky,
    pit: res.pit, sand: res.sand, regSlope: res.regSlope, regBeta: res.regBeta,
    raw: { coreLayers: new Uint8Array(0), regLayers: new Uint8Array(0) },
  }
  const totalMs = performance.now() - t0
  lastLoadStats = { ...res.stats, stacMs: Math.round(stacMs), totalMs: Math.round(totalMs) }
  onProgress?.('Terrain ready', 1)
  return { site, desc }
}
