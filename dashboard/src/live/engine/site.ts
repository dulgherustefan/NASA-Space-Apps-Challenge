// Site data: loading of the precomputed NASA terrain + hazard rasters, and samplers.
// Frames:
//   local  (e, s)  metres east / south of the HiRISE DTM corner (see pipeline/10_build_site.py)
//   core   (cx, cy) metres east / south of the EVA-box corner        cx = e - core.e0
//   world  (x, y, z) three.js: x = east, y = up (elevation - Z0), z = south, origin at EVA-box centre

export interface CoreMeta {
  e0: number; s0: number; size: number; renderCell: number; n: number; cell: number; na: number
  zMin: number; zMax: number; layers: string[]; scale: Record<string, number>
  ortho: string; orthoPx: number; centerLon: number; centerLat: number
}
export interface GridMeta {
  e0: number; s0: number; w: number; h: number; cell: number; nx: number; ny: number
  zMin: number; zMax: number; ortho: string; orthoCell: number; layers?: string[]
}
export interface SiteMeta {
  site: string; lat0: number; radius: number
  origin: { projX: number; projY: number; lon: number; lat: number }
  core: CoreMeta; reg: GridMeta; far: GridMeta
  rockfall: { sourceSlopeDeg: number; alphas: number[]; method: string }
  ctxOffsetM: number; ctxResidualRmsM: number
  sources: Record<string, string>
}

export interface SiteData {
  meta: SiteMeta
  Z0: number                    // elevation datum of world y = 0 (m, MOLA-referenced DTM elevation)
  coreH: Float32Array           // n x n render heights (m, absolute), 2.5 m spacing, vertex-centred
  regH: Float32Array            // ny x nx heights, 16 m cells (cell-centred)
  farH: Float32Array            // ny x nx heights, 80 m cells
  // analysis grid (na x na, 5 m cells, cell-centred)
  z: Float32Array
  slope: Float32Array           // deg, 10 m baseline (gradient of 5 m heights)
  slopeFine: Float32Array       // deg, p90 of 1 m-DTM slope inside the cell (surface texture / steps)
  rough: Float32Array           // m RMS (<9 m wavelength)
  beta: Float32Array            // deg, rockfall reach angle (0 = never reached)
  sky: Float32Array             // blocked-sky fraction 0..1
  pit: Float32Array             // m, depth of closed depression
  sand: Float32Array            // 0..1 loose-sand likelihood (proxy)
  regSlope: Uint8Array          // deg*3
  regBeta: Uint8Array           // deg*6
  raw: { coreLayers: Uint8Array; regLayers: Uint8Array }
}

const BASE = import.meta.env.BASE_URL + 'data/site/'

async function fetchGz(url: string, onBytes?: (n: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`fetch ${url}: ${res.status}`)
  // Some hosts transparently decode .gz; detect by magic bytes after download.
  const raw = new Uint8Array(await res.arrayBuffer())
  onBytes?.(raw.byteLength)
  if (raw[0] === 0x1f && raw[1] === 0x8b) {
    const ds = new DecompressionStream('gzip')
    const stream = new Blob([raw]).stream().pipeThrough(ds)
    return await new Response(stream).arrayBuffer()
  }
  return raw.buffer
}

function dequant(q: Uint16Array, lo: number, hi: number): Float32Array {
  const out = new Float32Array(q.length)
  const k = (hi - lo) / 65535
  for (let i = 0; i < q.length; i++) out[i] = lo + q[i] * k
  return out
}

export type Progress = (label: string, frac: number) => void

export async function loadSite(progress?: Progress): Promise<SiteData> {
  progress?.('Reading site metadata', 0.02)
  const meta: SiteMeta = await (await fetch(BASE + 'meta.json')).json()
  const files = ['core_h.bin.gz', 'reg_h.bin.gz', 'far_h.bin.gz', 'core_layers.bin.gz', 'reg_layers.bin.gz']
  const labels = ['HiRISE 1 m elevation model', 'Canyon-wall elevation', 'CTX regional context', 'Hazard layers', 'Rockfall sources']
  let done = 0
  const bufs = await Promise.all(files.map((f, i) => fetchGz(BASE + f).then(b => {
    done++; progress?.(labels[i], 0.05 + 0.6 * done / files.length); return b
  })))
  const { core, reg, far } = meta
  const coreH = dequant(new Uint16Array(bufs[0]), core.zMin, core.zMax)
  const regH = dequant(new Uint16Array(bufs[1]), reg.zMin, reg.zMax)
  const farH = dequant(new Uint16Array(bufs[2]), far.zMin, far.zMax)
  const coreLayers = new Uint8Array(bufs[3])
  const regLayers = new Uint8Array(bufs[4])
  const na = core.na, N = na * na
  const layer = (name: string) => {
    const k = core.layers.indexOf(name)
    const sc = core.scale[name]
    const out = new Float32Array(N)
    const off = k * N
    for (let i = 0; i < N; i++) out[i] = coreLayers[off + i] / sc
    return out
  }
  // 5 m analysis heights: every second render vertex (vertex 2j+1 sits on the cell centre)
  const z = new Float32Array(N)
  const n = core.n
  for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) {
    const r = 2 * i + 1, c = 2 * j + 1
    // 3x3 tent average around the centre vertex ~ 5 m footprint
    let s = 0, w = 0
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const ww = (dr === 0 ? 2 : 1) * (dc === 0 ? 2 : 1)
      s += coreH[(r + dr) * n + (c + dc)] * ww; w += ww
    }
    z[i * na + j] = s / w
  }
  // slope over a 10 m baseline (matches rl/planner.py slope10)
  const slope = new Float32Array(N)
  const cell = core.cell
  for (let i = 0; i < na; i++) for (let j = 0; j < na; j++) {
    const i0 = Math.max(0, i - 1), i1 = Math.min(na - 1, i + 1)
    const j0 = Math.max(0, j - 1), j1 = Math.min(na - 1, j + 1)
    const gy = (z[i1 * na + j] - z[i0 * na + j]) / ((i1 - i0) * cell)
    const gx = (z[i * na + j1] - z[i * na + j0]) / ((j1 - j0) * cell)
    slope[i * na + j] = Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI
  }
  const Z0 = Math.round((core.zMin + core.zMax) / 2 / 10) * 10
  progress?.('Decoding terrain', 0.7)
  const rn = reg.nx * reg.ny
  return {
    meta, Z0, coreH, regH, farH, z, slope,
    slopeFine: layer('slope'), rough: layer('rough'), beta: layer('beta'), sky: layer('sky'),
    pit: layer('pit'), sand: layer('sand'),
    regSlope: regLayers.subarray(0, rn), regBeta: regLayers.subarray(rn, 2 * rn),
    raw: { coreLayers, regLayers },
  }
}

// ----------------------------------------------------------------------------- frames

export class Frames {
  readonly half: number
  constructor(public meta: SiteMeta, public Z0: number) { this.half = meta.core.size / 2 }
  /** core metres (east, south of the EVA-box corner) -> world x/z */
  coreToWorldX(cx: number) { return cx - this.half }
  coreToWorldZ(cy: number) { return cy - this.half }
  worldToCoreX(x: number) { return x + this.half }
  worldToCoreY(z: number) { return z + this.half }
  /** world -> planetocentric lon (deg E) / lat */
  worldToLonLat(x: number, z: number): [number, number] {
    const m = this.meta
    const e = x + this.half + m.core.e0, s = z + this.half + m.core.s0
    const C = Math.cos(m.lat0 * Math.PI / 180)
    const X = m.origin.projX + e / C, Y = m.origin.projY - s
    let lon = X / m.radius * 180 / Math.PI
    if (lon < 0) lon += 360
    return [lon, Y / m.radius * 180 / Math.PI]
  }
}

// ----------------------------------------------------------------------------- samplers

function bilinear(a: Float32Array, nx: number, ny: number, fx: number, fy: number): number {
  if (fx < 0) fx = 0; else if (fx > nx - 1.001) fx = nx - 1.001
  if (fy < 0) fy = 0; else if (fy > ny - 1.001) fy = ny - 1.001
  const j = fx | 0, i = fy | 0, tx = fx - j, ty = fy - i
  const k = i * nx + j
  return (a[k] * (1 - tx) + a[k + 1] * tx) * (1 - ty) + (a[k + nx] * (1 - tx) + a[k + nx + 1] * tx) * ty
}

/** Elevation (absolute metres) at a world position, from the finest level that covers it. */
export function makeHeightSampler(site: SiteData) {
  const { core, reg, far } = site.meta
  const half = core.size / 2
  const rx0 = reg.e0 - core.e0 - half, rz0 = reg.s0 - core.s0 - half
  const fx0 = far.e0 - core.e0 - half, fz0 = far.s0 - core.s0 - half
  const inv = 1 / core.renderCell
  return (x: number, z: number): number => {
    if (x >= -half && x <= half && z >= -half && z <= half) {
      return bilinear(site.coreH, core.n, core.n, (x + half) * inv, (z + half) * inv)
    }
    const rx = (x - rx0) / reg.cell - 0.5, rz = (z - rz0) / reg.cell - 0.5
    if (rx >= 0 && rx <= reg.nx - 1 && rz >= 0 && rz <= reg.ny - 1) return bilinear(site.regH, reg.nx, reg.ny, rx, rz)
    const fx = (x - fx0) / far.cell - 0.5, fz = (z - fz0) / far.cell - 0.5
    return bilinear(site.farH, far.nx, far.ny, fx, fz)
  }
}

/** World-space ground height (y) sampler. */
export function makeGroundY(site: SiteData) {
  const h = makeHeightSampler(site)
  const Z0 = site.Z0
  return (x: number, z: number) => h(x, z) - Z0
}
