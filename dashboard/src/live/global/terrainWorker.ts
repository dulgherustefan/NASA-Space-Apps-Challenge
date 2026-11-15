/// <reference lib="webworker" />
// Terrain worker for "any location on Mars": reads only the needed window of a USGS DTM COG
// (HTTP range requests, COG overviews), fills gaps and the wide context from the global MOLA/HRSC
// 200 m blend DEM (NASA Trek ImageServer), resamples everything onto the planner grids and computes
// the derived hazard layers the live engine expects.
//
// Local frame: equirectangular about the box centre, e = R cos(lat0) (lon - lonW), s = R (latN - lat)
// (metres east / south of the box corner). Over a 4-25 km box on a sphere this differs from a true
// local tangent plane by well under 0.1 %, far below the DTM errors.
import { fromUrl, fromArrayBuffer } from 'geotiff'
import {
  CORE, REG, FAR, REG_E0, FAR_E0, R_MARS,
  type CogSource, type TerrainJob, type TerrainReply, type TerrainResult, type TerrainStats,
} from './terrainTypes'

const D2R = Math.PI / 180
const post = (m: TerrainReply, t?: Transferable[]) => (self as unknown as Worker).postMessage(m, t ?? [])
const progress = (label: string, frac: number) => post({ type: 'progress', label, frac })

// Count transferred bytes (Content-Length is CORS-safelisted, so it is visible for S3 and Trek).
let BYTES = 0, REQS = 0
const nativeFetch = self.fetch.bind(self)
// cache: 'no-store' matters: Chrome's HTTP cache serialises concurrent range requests to one URL
// (cache lock), which made a 13 MB COG window take ~30 s instead of ~4 s.
self.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const r = await nativeFetch(input, { ...init, cache: 'no-store' })
  REQS++
  BYTES += Number(r.headers.get('content-length') ?? 0)
  return r
}

// ----------------------------------------------------------------------------- frame + samplers

interface Frame { lonW: number; latN: number; Rc: number }
const lonAt = (f: Frame, e: number) => f.lonW + e / f.Rc / D2R
const latAt = (f: Frame, s: number) => f.latN - s / R_MARS / D2R
const wrap180 = (d: number) => ((d + 540) % 360) - 180

type Sampler = (lon: number, lat: number) => number   // NaN where there is no data

/** Bilinear sampler over a raster; corners without data are dropped and the weights renormalised. */
function rasterSampler(a: Float32Array, w: number, h: number, toPix: (lon: number, lat: number) => [number, number]): Sampler {
  return (lon, lat) => {
    const [fx0, fy0] = toPix(lon, lat)
    const fx = fx0 - 0.5, fy = fy0 - 0.5                 // pixel-is-area: centre of pixel j at j + 0.5
    if (fx < -0.5 || fy < -0.5 || fx > w - 0.5 || fy > h - 0.5) return NaN
    const j = Math.min(Math.max(Math.floor(fx), 0), w - 2), i = Math.min(Math.max(Math.floor(fy), 0), h - 2)
    const tx = Math.min(Math.max(fx - j, 0), 1), ty = Math.min(Math.max(fy - i, 0), 1)
    const k = i * w + j
    const v00 = a[k], v01 = a[k + 1], v10 = a[k + w], v11 = a[k + w + 1]
    let s = 0, ws = 0
    const add = (v: number, ww: number) => { if (v === v && ww > 0) { s += v * ww; ws += ww } }
    add(v00, (1 - tx) * (1 - ty)); add(v01, tx * (1 - ty)); add(v10, (1 - tx) * ty); add(v11, tx * ty)
    return ws > 1e-6 ? s / ws : NaN
  }
}

function cleanNoData(a: ArrayLike<number>, nodata: number | null): Float32Array {
  const out = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) {
    const v = a[i]
    out[i] = (!Number.isFinite(v) || v < -1e20 || (nodata !== null && Math.abs(v - nodata) < 1e-3) || v < -20000 || v > 30000) ? NaN : v
  }
  return out
}

// ----------------------------------------------------------------------------- sources

/** Global MOLA/HRSC blend DEM (~200 m) over a lon/lat box via ArcGIS exportImage (float32 TIFF). */
async function readGlobal(base: string, W: number, S: number, E: number, N: number, resM: number, lat0: number): Promise<Sampler> {
  const wM = (E - W) * D2R * R_MARS * Math.cos(lat0 * D2R), hM = (N - S) * D2R * R_MARS
  const w = Math.max(8, Math.min(1200, Math.ceil(wM / resM))), h = Math.max(8, Math.min(1200, Math.ceil(hM / resM)))
  const q = `bbox=${W},${S},${E},${N}&bboxSR=104905&imageSR=104905&size=${w},${h}&format=tiff&pixelType=F32` +
    `&interpolation=RSP_BilinearInterpolation&f=image`
  const res = await fetch(`${base}/exportImage?${q}`)
  if (!res.ok) throw new Error(`global DEM HTTP ${res.status}`)
  const buf = await res.arrayBuffer()
  const tif = await fromArrayBuffer(buf)
  const im = await tif.getImage()
  const ras = await im.readRasters({ samples: [0] })
  const a = cleanNoData(ras[0] as ArrayLike<number>, im.getGDALNoData())
  const iw = im.getWidth(), ih = im.getHeight()
  let bW = W, bS = S, bE = E, bN = N
  try { const bb = im.getBoundingBox(); if (bb.every(Number.isFinite) && Math.abs(bb[0] - W) < 1) [bW, bS, bE, bN] = bb } catch { /* use the requested box */ }
  return rasterSampler(a, iw, ih, (lon, lat) => [(lon - bW) / (bE - bW) * iw, (bN - lat) / (bN - bS) * ih])
}

interface CogWindow { sampler: Sampler; resM: number; valid: number }

/** Reads the window of a DTM COG that covers a lon/lat box at the coarsest overview finer than targetRes. */
async function readCog(src: CogSource, W: number, S: number, E: number, N: number, targetRes: number, url = src.url): Promise<CogWindow | null> {
  const tif = await fromUrl(url, { allowFullFile: false })
  const count = await tif.getImageCount()
  const im0 = await tif.getImage(0)
  const W0 = im0.getWidth(), H0 = im0.getHeight()
  const nodata = im0.getGDALNoData()
  let [x0, dx0, , y0, , dy0] = src.transform
  try { const o = im0.getOrigin(), r = im0.getResolution(); if (Number.isFinite(o[0]) && r[0]) { x0 = o[0]; y0 = o[1]; dx0 = r[0]; dy0 = r[1] } } catch { /* STAC transform */ }
  // pick overview
  let level = 0, scale = 1
  for (let k = 1; k < count; k++) {
    const imk = await tif.getImage(k)
    const sk = W0 / imk.getWidth()
    if (Math.abs(dx0) * sk <= targetRes * 1.06) { level = k; scale = sk } else break
  }
  const im = level === 0 ? im0 : await tif.getImage(level)
  const w = im.getWidth(), h = im.getHeight()
  const sy = H0 / h
  const dx = dx0 * scale, dy = dy0 * sy
  const { R, clonDeg, latTsDeg } = src.proj
  const kx = R * Math.cos(latTsDeg * D2R) * D2R, ky = R * D2R
  // longitude offset from the central meridian, unwrapped towards the image centre (DTMs near 180 deg E
  // can carry X beyond +-180 deg)
  const dlMid = (x0 + dx0 * W0 / 2) / kx
  const toPix = (lon: number, lat: number): [number, number] => {
    let dl = wrap180(lon - clonDeg)
    if (dl - dlMid > 180) dl -= 360; else if (dlMid - dl > 180) dl += 360
    return [(kx * dl - x0) / dx, (ky * lat - y0) / dy]
  }
  const [c0, r0] = toPix(W, N), [c1, r1] = toPix(E, S)
  const cA = Math.max(0, Math.floor(Math.min(c0, c1)) - 2), cB = Math.min(w, Math.ceil(Math.max(c0, c1)) + 2)
  const rA = Math.max(0, Math.floor(Math.min(r0, r1)) - 2), rB = Math.min(h, Math.ceil(Math.max(r0, r1)) + 2)
  if (cB - cA < 2 || rB - rA < 2) return null
  const ras = await im.readRasters({ window: [cA, rA, cB, rB], samples: [0] })
  const a = cleanNoData(ras[0] as ArrayLike<number>, nodata)
  let valid = 0
  for (let i = 0; i < a.length; i++) if (a[i] === a[i]) valid++
  const ww = cB - cA, hh = rB - rA
  const sampler = rasterSampler(a, ww, hh, (lon, lat) => { const [c, r] = toPix(lon, lat); return [c - cA, r - rA] })
  return { sampler, resM: Math.abs(dx0) * scale, valid: valid / a.length }
}

// ----------------------------------------------------------------------------- derived layers

function minMax(a: Float32Array): [number, number] {
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < a.length; i++) { const v = a[i]; if (v < lo) lo = v; if (v > hi) hi = v }
  return [Math.floor(lo), Math.ceil(hi)]
}

/** Central-difference slope (deg) of a cell-centred grid. */
function slopeOf(z: Float32Array, nx: number, ny: number, cell: number): Float32Array {
  const out = new Float32Array(nx * ny)
  for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(ny - 1, i + 1)
    const j0 = Math.max(0, j - 1), j1 = Math.min(nx - 1, j + 1)
    const gy = (z[i1 * nx + j] - z[i0 * nx + j]) / ((i1 - i0) * cell)
    const gx = (z[i * nx + j1] - z[i * nx + j0]) / ((j1 - j0) * cell)
    out[i * nx + j] = Math.atan(Math.hypot(gx, gy)) / D2R
  }
  return out
}

function fillNaN(a: Float32Array, fallback: number) {
  for (let i = 0; i < a.length; i++) if (a[i] !== a[i]) a[i] = fallback
}

// ----------------------------------------------------------------------------- main job

async function run(job: TerrainJob): Promise<TerrainResult> {
  const T: Record<string, number> = {}
  const t0 = performance.now()
  let tl = t0
  const lap = (k: string) => { const t = performance.now(); T[k] = Math.round(t - tl); tl = t }
  const lat0 = job.lat0
  const Rc = R_MARS * Math.cos(lat0 * D2R)
  const f: Frame = { lonW: job.lon0 - CORE.size / 2 / Rc / D2R, latN: lat0 + CORE.size / 2 / R_MARS / D2R, Rc }
  const box = (e0: number, size: number, marginM: number): [number, number, number, number] =>
    [lonAt(f, e0 - marginM), latAt(f, e0 + size + marginM), lonAt(f, e0 + size + marginM), latAt(f, e0 - marginM)]
  const coreBox = box(0, CORE.size, 60)
  const regBox = box(REG_E0, REG.cell * REG.nx, 60)
  const farBox = box(FAR_E0, FAR.cell * FAR.nx, 400)

  // 1. fetch: global DEM (always: wide context + gap fill) and the DTM windows, in parallel
  progress(job.primary ? `Reading ${job.primary.kind === 'hirise' ? 'HiRISE' : 'CTX'} DTM window (range requests)` : 'Reading global MOLA/HRSC DEM', 0.12)
  const globalP = readGlobal(job.globalUrl, ...farBox, 200, lat0).catch((e: unknown) => { throw new Error(`the global DEM request failed: ${(e as Error).message ?? e}`) })
  const p = job.primary
  const coreP = p ? readCog(p, ...coreBox, p.kind === 'hirise' ? 2.5 : 20) : Promise.resolve(null)
  const regP = p ? readCog(p, ...regBox, 16) : Promise.resolve(null)
  const orthoP = p?.orthoUrl ? readCog(p, ...coreBox, p.kind === 'hirise' ? 4.2 : 20, p.orthoUrl).catch(() => null) : Promise.resolve(null)
  let glob: Sampler | null = null
  let globalErr = ''
  const timed = <X,>(k: string, pr: Promise<X>) => pr.then(v => { T[k] = Math.round(performance.now() - t0); return v })
  const [g, cw, rw] = await Promise.all([
    timed('fetchGlobal', globalP.catch((e: Error) => { globalErr = e.message; return null })),
    timed('fetchCore', coreP), timed('fetchReg', regP),
  ])
  glob = g
  lap('fetch')
  if (!p && !glob) throw new Error(`No DTM here and ${globalErr}`)
  if (p && !cw) throw new Error(`The ${p.id} DTM has no data over this box`)
  progress('Resampling to the 5 m planner grid', 0.55)

  // 2. offset global DEM onto the DTM datum (median difference over the core box)
  let offset = 0
  if (cw && glob) {
    const d: number[] = []
    for (let i = 0; i <= 40; i++) for (let j = 0; j <= 40; j++) {
      const lon = lonAt(f, j * 100), lat = latAt(f, i * 100)
      const a = cw.sampler(lon, lat), b = glob(lon, lat)
      if (a === a && b === b) d.push(a - b)
    }
    if (d.length) { d.sort((x, y) => x - y); offset = d[d.length >> 1] }
  }
  const G: Sampler = glob ? (lon, lat) => glob!(lon, lat) + offset : () => NaN
  const layered = (fine: Sampler | null): Sampler => fine ? (lon, lat) => { const v = fine(lon, lat); return v === v ? v : G(lon, lat) } : G

  // 3. core render heights: 1601^2 vertices at 2.5 m
  const n = CORE.n, rc = CORE.renderCell
  const coreH = new Float32Array(n * n)
  let filled = 0
  const lons = new Float64Array(n)
  for (let c = 0; c < n; c++) lons[c] = lonAt(f, c * rc)
  for (let r = 0; r < n; r++) {
    const lat = latAt(f, r * rc)
    for (let c = 0; c < n; c++) {
      let v = cw ? cw.sampler(lons[c], lat) : NaN
      if (v !== v) { v = G(lons[c], lat); filled++ }
      coreH[r * n + c] = v
    }
  }
  const fillFrac = cw ? filled / (n * n) : 1
  { let s = 0, k = 0; for (const v of coreH) if (v === v) { s += v; k++ } fillNaN(coreH, k ? s / k : 0) }
  lap('core')

  // 4. 5 m analysis grid (same reduction and slope formula as engine/site.ts)
  const na = CORE.na, N = na * na, cell = CORE.cell
  const z = new Float32Array(N)
  for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) {
    const r = 2 * i + 1, c = 2 * j + 1
    let s = 0, w = 0
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const ww = (dr === 0 ? 2 : 1) * (dc === 0 ? 2 : 1)
      s += coreH[(r + dr) * n + (c + dc)] * ww; w += ww
    }
    z[i * na + j] = s / w
  }
  const slope = slopeOf(z, na, na, cell)
  const fine = !!cw && cw.resM <= 3
  let slopeFine: Float32Array, rough: Float32Array
  if (fine) {
    // slopeFine: steepest of the four 2.5 m sub-quads of the cell (stands in for the p90 of 1 m slope)
    // rough: RMS residual of the 2.5 m heights about their 3x3 mean (~7.5 m), around the cell centre
    slopeFine = new Float32Array(N); rough = new Float32Array(N)
    for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) {
      let mx = 0
      for (let qi = 0; qi < 2; qi++) for (let qj = 0; qj < 2; qj++) {
        const r = 2 * i + qi, c = 2 * j + qj, k = r * n + c
        const gx = (coreH[k + 1] - coreH[k] + coreH[k + n + 1] - coreH[k + n]) / (2 * rc)
        const gy = (coreH[k + n] - coreH[k] + coreH[k + n + 1] - coreH[k + 1]) / (2 * rc)
        const sdeg = Math.atan(Math.hypot(gx, gy)) / D2R
        if (sdeg > mx) mx = sdeg
      }
      slopeFine[i * na + j] = Math.max(mx, slope[i * na + j])
      let ss = 0, cnt = 0
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const r = 2 * i + 1 + dr, c = 2 * j + 1 + dc
        let m = 0, mm = 0
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
          const rr = Math.min(n - 1, Math.max(0, r + a)), cc = Math.min(n - 1, Math.max(0, c + b))
          m += coreH[rr * n + cc]; mm++
        }
        const res = coreH[r * n + c] - m / mm
        ss += res * res; cnt++
      }
      rough[i * na + j] = Math.sqrt(ss / cnt)
    }
  } else {
    slopeFine = slope.slice()
    rough = new Float32Array(N).fill(0.05)            // not resolvable at 20-200 m posts: neutral constant
  }
  lap('layers5m')

  // 5. regional 16 m grid (9.2 km) and far 80 m grid (25.6 km), cell-centred
  progress('Building the regional and far context grids', 0.68)
  const regS = layered(rw ? rw.sampler : null)
  const regH = new Float32Array(REG.nx * REG.ny)
  for (let i = 0; i < REG.ny; i++) {
    const lat = latAt(f, REG_E0 + (i + 0.5) * REG.cell)
    for (let j = 0; j < REG.nx; j++) regH[i * REG.nx + j] = regS(lonAt(f, REG_E0 + (j + 0.5) * REG.cell), lat)
  }
  const farH = new Float32Array(FAR.nx * FAR.ny)
  for (let i = 0; i < FAR.ny; i++) {
    const lat = latAt(f, FAR_E0 + (i + 0.5) * FAR.cell)
    for (let j = 0; j < FAR.nx; j++) farH[i * FAR.nx + j] = regS(lonAt(f, FAR_E0 + (j + 0.5) * FAR.cell), lat)
  }
  const zMean = z.reduce((a, b) => a + b, 0) / N
  fillNaN(regH, zMean); fillNaN(farH, zMean)
  const regSlopeF = slopeOf(regH, REG.nx, REG.ny, REG.cell)
  lap('context')

  // 6. rockfall reach angle (approximate): 24 m grid over the regional box; sources are cells with
  // slope >= 32 deg (5 m core slope inside the core, 16 m slope outside); for each target cell
  // beta = max over sources within 1.2 km of atan(dz_up / horizontal distance); source cells get 40 deg.
  progress('Rockfall reach angles (approximate)', 0.76)
  const BG = 24, bn = Math.round(REG.cell * REG.nx / BG)              // 384
  const srcZ = new Float32Array(bn * bn).fill(-Infinity)
  const tz = new Float32Array(bn * bn)
  const regToB = REG.cell / BG
  for (let i = 0; i < REG.ny; i++) for (let j = 0; j < REG.nx; j++) {
    const k = i * REG.nx + j
    const bi = Math.min(bn - 1, Math.floor((i + 0.5) * regToB)), bj = Math.min(bn - 1, Math.floor((j + 0.5) * regToB))
    const e = REG_E0 + (j + 0.5) * REG.cell, s = REG_E0 + (i + 0.5) * REG.cell
    const inCore = e > 0 && e < CORE.size && s > 0 && s < CORE.size
    if (!inCore && regSlopeF[k] >= 32 && regH[k] > srcZ[bi * bn + bj]) srcZ[bi * bn + bj] = regH[k]
  }
  for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) {
    const k = i * na + j
    if (slope[k] < 32) continue
    const bi = Math.floor(((i + 0.5) * cell - REG_E0) / BG), bj = Math.floor(((j + 0.5) * cell - REG_E0) / BG)
    if (z[k] > srcZ[bi * bn + bj]) srcZ[bi * bn + bj] = z[k]
  }
  for (let i = 0; i < bn; i++) for (let j = 0; j < bn; j++) {
    const fx = ((j + 0.5) * BG) / REG.cell - 0.5, fy = ((i + 0.5) * BG) / REG.cell - 0.5
    const jj = Math.min(REG.nx - 2, Math.max(0, Math.floor(fx))), ii = Math.min(REG.ny - 2, Math.max(0, Math.floor(fy)))
    const ax = Math.min(1, Math.max(0, fx - jj)), ay = Math.min(1, Math.max(0, fy - ii))
    const k = ii * REG.nx + jj
    tz[i * bn + j] = (regH[k] * (1 - ax) + regH[k + 1] * ax) * (1 - ay) + (regH[k + REG.nx] * (1 - ax) + regH[k + REG.nx + 1] * ax) * ay
  }
  const betaB = new Float32Array(bn * bn)
  const RAD = Math.ceil(1200 / BG)   // the brief said ~600 m; 1.2 km matches the bundled Melas band better
  let nSrc = 0
  for (let si = 0; si < bn; si++) for (let sj = 0; sj < bn; sj++) {
    const zs = srcZ[si * bn + sj]
    if (zs === -Infinity) continue
    nSrc++
    betaB[si * bn + sj] = 40
    for (let di = -RAD; di <= RAD; di++) {
      const ti = si + di
      if (ti < 0 || ti >= bn) continue
      for (let dj = -RAD; dj <= RAD; dj++) {
        const tj = sj + dj
        if (tj < 0 || tj >= bn || (di === 0 && dj === 0)) continue
        const d2 = di * di + dj * dj
        if (d2 > RAD * RAD) continue
        const t = ti * bn + tj
        const dz = zs - tz[t]
        if (dz <= 0) continue
        const ang = Math.atan(dz / (BG * Math.sqrt(d2))) / D2R
        if (ang > betaB[t]) betaB[t] = ang
      }
    }
  }
  const sampleB = (e: number, s: number) => {
    const fx = (e - REG_E0) / BG - 0.5, fy = (s - REG_E0) / BG - 0.5
    const j = Math.min(bn - 2, Math.max(0, Math.floor(fx))), i = Math.min(bn - 2, Math.max(0, Math.floor(fy)))
    const ax = Math.min(1, Math.max(0, fx - j)), ay = Math.min(1, Math.max(0, fy - i))
    const k = i * bn + j
    return (betaB[k] * (1 - ax) + betaB[k + 1] * ax) * (1 - ay) + (betaB[k + bn] * (1 - ax) + betaB[k + bn + 1] * ax) * ay
  }
  const beta = new Float32Array(N)
  for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) {
    const k = i * na + j
    beta[k] = slope[k] >= 32 ? 40 : sampleB((j + 0.5) * cell, (i + 0.5) * cell)
  }
  const regSlope = new Uint8Array(REG.nx * REG.ny), regBeta = new Uint8Array(REG.nx * REG.ny)
  for (let i = 0; i < REG.ny; i++) for (let j = 0; j < REG.nx; j++) {
    const k = i * REG.nx + j
    regSlope[k] = Math.min(255, Math.round(regSlopeF[k] * 3))
    regBeta[k] = Math.min(255, Math.round(sampleB(REG_E0 + (j + 0.5) * REG.cell, REG_E0 + (i + 0.5) * REG.cell) * 6))
  }
  lap('beta')

  // 7. blocked-sky fraction (approximate): horizon angle in 8 directions on a 40 m grid, marching out
  // to 2.5 km through core -> regional -> far heights; blocked share of the sky dome = mean sin(h).
  progress('Sky view (approximate)', 0.86)
  const height = (e: number, s: number): number => {
    if (e >= 0 && e <= CORE.size && s >= 0 && s <= CORE.size) {
      const fx = Math.min(e / rc, n - 1.001), fy = Math.min(s / rc, n - 1.001)
      const j = fx | 0, i = fy | 0, ax = fx - j, ay = fy - i, k = i * n + j
      return (coreH[k] * (1 - ax) + coreH[k + 1] * ax) * (1 - ay) + (coreH[k + n] * (1 - ax) + coreH[k + n + 1] * ax) * ay
    }
    const gr = (a: Float32Array, nx: number, ny: number, e0: number, c: number) => {
      const fx = Math.min(Math.max((e - e0) / c - 0.5, 0), nx - 1.001), fy = Math.min(Math.max((s - e0) / c - 0.5, 0), ny - 1.001)
      const j = fx | 0, i = fy | 0, ax = fx - j, ay = fy - i, k = i * nx + j
      return (a[k] * (1 - ax) + a[k + 1] * ax) * (1 - ay) + (a[k + nx] * (1 - ax) + a[k + nx + 1] * ax) * ay
    }
    const regW = REG.cell * REG.nx
    if (e >= REG_E0 && e <= REG_E0 + regW && s >= REG_E0 && s <= REG_E0 + regW) return gr(regH, REG.nx, REG.ny, REG_E0, REG.cell)
    return gr(farH, FAR.nx, FAR.ny, FAR_E0, FAR.cell)
  }
  const SG = 40, sn = CORE.size / SG + 1                              // 101 x 101 points
  const skyG = new Float32Array(sn * sn)
  const dists: number[] = []
  for (let d = 8; d < 2500; d *= 1.14) dists.push(d)
  const dirs = Array.from({ length: 8 }, (_, k) => [Math.cos(k * Math.PI / 4), Math.sin(k * Math.PI / 4)])
  for (let i = 0; i < sn; i++) for (let j = 0; j < sn; j++) {
    const e = j * SG, s = i * SG
    const h0 = height(e, s) + 1.0
    let acc = 0
    for (const [ux, uy] of dirs) {
      let best = 0
      for (const d of dists) {
        const t = (height(e + ux * d, s + uy * d) - h0) / d
        if (t > best) best = t
      }
      acc += Math.sin(Math.atan(best))
    }
    skyG[i * sn + j] = acc / 8
  }
  const sky = new Float32Array(N)
  for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) {
    const fx = Math.min(((j + 0.5) * cell) / SG, sn - 1.001), fy = Math.min(((i + 0.5) * cell) / SG, sn - 1.001)
    const jj = fx | 0, ii = fy | 0, ax = fx - jj, ay = fy - ii, k = ii * sn + jj
    sky[i * na + j] = (skyG[k] * (1 - ax) + skyG[k + 1] * ax) * (1 - ay) + (skyG[k + sn] * (1 - ax) + skyG[k + sn + 1] * ax) * ay
  }
  lap('sky')

  // 8. image of the box: co-registered orthoimage COG if there is one, else shaded relief of coreH
  progress('Image of the box', 0.92)
  let ortho: TerrainResult['ortho'] = null
  if (p?.orthoUrl) {
    try {
      const ow = await orthoP
      if (ow) {
        const px = p.kind === 'hirise' ? 1024 : 512, step = CORE.size / px
        const v = new Float32Array(px * px)
        for (let i = 0; i < px; i++) { const lat = latAt(f, (i + 0.5) * step); for (let j = 0; j < px; j++) v[i * px + j] = ow.sampler(lonAt(f, (j + 0.5) * step), lat) }
        const ok = Array.from(v).filter(x => x === x && x > 0).sort((a, b) => a - b)
        if (ok.length > v.length * 0.5) {
          const lo = ok[Math.floor(ok.length * 0.01)], hi = ok[Math.floor(ok.length * 0.995)]
          const rgba = new Uint8ClampedArray(px * px * 4)
          for (let k = 0; k < v.length; k++) {
            const g = v[k] === v[k] && v[k] > 0 ? Math.round(255 * Math.pow(Math.min(1, Math.max(0, (v[k] - lo) / (hi - lo || 1))), 0.9)) : 0
            rgba[k * 4] = Math.min(255, g * 1.06); rgba[k * 4 + 1] = g; rgba[k * 4 + 2] = g * 0.9; rgba[k * 4 + 3] = 255
          }
          ortho = { px, rgba, note: p.kind === 'hirise'
            ? `HiRISE orthoimage ${p.orthoUrl.split('/').pop()?.replace('.tif', '')} read at ${ow.resM.toFixed(1)} m, contrast-stretched; credit NASA/JPL/University of Arizona`
            : `CTX orthoimage (DRG) of ${p.id}, ${ow.resM.toFixed(0)} m; credit NASA/JPL/MSSS/USGS` }
        }
      }
    } catch { /* fall through to shaded relief */ }
  }
  if (!ortho) {
    const px = 800, rgba = new Uint8ClampedArray(px * px * 4)
    const az = 315 * D2R, alt = 40 * D2R, lx = Math.sin(az) * Math.cos(alt), ly = -Math.cos(az) * Math.cos(alt), lz = Math.sin(alt)
    for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(na - 1, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(na - 1, j + 1)
      const gx = (z[i * na + j1] - z[i * na + j0]) / ((j1 - j0) * cell), gy = (z[i1 * na + j] - z[i0 * na + j]) / ((i1 - i0) * cell)
      // normal of z(e, s): (-gx, +gy, 1) with y pointing north
      const nl = Math.hypot(gx, gy, 1), sh = Math.max(0, (-gx * lx + gy * ly + lz) / nl)
      const g = 40 + 200 * sh, k = (i * na + j) * 4
      rgba[k] = g * 1.08; rgba[k + 1] = g * 0.9; rgba[k + 2] = g * 0.75; rgba[k + 3] = 255
    }
    ortho = { px, rgba, note: `Shaded relief computed from the ${p ? p.kind.toUpperCase() + ' DTM' : '200 m global DEM'} (no photo available)` }
  }
  lap('ortho')

  const pit = new Float32Array(N)                       // closed depressions not modelled for live sites
  const sand = new Float32Array(N)                      // loose-sand likelihood unknown: 0 everywhere
  T.total = Math.round(performance.now() - t0)
  const stats: TerrainStats = {
    bytes: BYTES, requests: REQS, primaryReadResM: cw ? Math.round(cw.resM * 100) / 100 : 0,
    fillFrac, globalOffsetM: Math.round(offset * 10) / 10, sourceCells: nSrc, ms: T,
  }
  return {
    coreH, regH, farH, z, slope, slopeFine, rough, beta, sky, pit, sand, regSlope, regBeta, ortho,
    zr: { core: minMax(coreH), reg: minMax(regH), far: minMax(farH) }, stats,
  }
}

self.onmessage = async (ev: MessageEvent<TerrainJob>) => {
  try {
    const r = await run(ev.data)
    const bufs = [r.coreH, r.regH, r.farH, r.z, r.slope, r.slopeFine, r.rough, r.beta, r.sky, r.pit, r.sand, r.regSlope, r.regBeta].map(a => a.buffer as ArrayBuffer)
    if (r.ortho) bufs.push(r.ortho.rgba.buffer as ArrayBuffer)
    post({ type: 'done', result: r }, bufs)
  } catch (e) {
    post({ type: 'error', message: (e as Error)?.message ?? String(e) })
  }
}
