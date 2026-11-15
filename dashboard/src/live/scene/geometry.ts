// Terrain building blocks shared by the 3D overview and the helmet / rover views.
// One TerrainKit per SiteData object (WeakMap): geometries and textures are built once and shared by
// every canvas that shows the site, ref-counted and disposed when the last view unmounts.
import * as THREE from 'three'
import { makeGroundY, type SiteData } from '../engine/site'
import type { SiteDescriptor } from '../types'

const BASE = import.meta.env.BASE_URL

export interface Window { c0: number; r0: number; c1: number; r1: number }

/**
 * Regular-grid terrain mesh from a height array.
 * heights[row * nx + col] (absolute metres); vertex (col,row) sits at x = x0 + col * d, z = z0 + row * d, y = h - Z0.
 * `stride` decimates the grid, `win` restricts it to a sub-window (inclusive vertex indices),
 * a downward skirt hides cracks against a coarser level.
 */
export function buildTerrainGeometry(
  heights: Float32Array, nx: number, ny: number,
  x0: number, z0: number, d: number, Z0: number,
  stride = 1, skirt = 40, win?: Window,
): THREE.BufferGeometry {
  const c0 = win ? Math.max(0, win.c0) : 0, r0 = win ? Math.max(0, win.r0) : 0
  const c1 = win ? Math.min(nx - 1, win.c1) : nx - 1, r1 = win ? Math.min(ny - 1, win.r1) : ny - 1
  const cols = Math.floor((c1 - c0) / stride) + 1
  const rows = Math.floor((r1 - r0) / stride) + 1
  const nGrid = cols * rows
  const ring = 2 * cols + 2 * rows
  const nVert = nGrid + (skirt > 0 ? ring : 0)
  const pos = new Float32Array(nVert * 3)
  const nor = new Int8Array(nVert * 3)
  let p = 0
  for (let r = 0; r < rows; r++) {
    const rr = r0 + r * stride
    for (let c = 0; c < cols; c++) {
      const cc = c0 + c * stride
      pos[p] = x0 + cc * d
      pos[p + 1] = heights[rr * nx + cc] - Z0
      pos[p + 2] = z0 + rr * d
      // normals from central differences over the decimated spacing (smoother at coarse strides)
      const s = stride
      const cl = Math.max(0, cc - s), cr = Math.min(nx - 1, cc + s)
      const ru = Math.max(0, rr - s), rd = Math.min(ny - 1, rr + s)
      const gx = (heights[rr * nx + cr] - heights[rr * nx + cl]) / Math.max(1e-6, (cr - cl) * d)
      const gz = (heights[rd * nx + cc] - heights[ru * nx + cc]) / Math.max(1e-6, (rd - ru) * d)
      const inv = 127 / Math.hypot(gx, 1, gz)
      nor[p] = Math.round(-gx * inv); nor[p + 1] = Math.round(inv); nor[p + 2] = Math.round(-gz * inv)
      p += 3
    }
  }
  const quads = (cols - 1) * (rows - 1)
  const idx = new Uint32Array(quads * 6 + (skirt > 0 ? ring * 6 : 0))
  let q = 0
  for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
    const a = r * cols + c, b = a + 1, e = a + cols, f = e + 1
    idx[q++] = a; idx[q++] = e; idx[q++] = b
    idx[q++] = b; idx[q++] = e; idx[q++] = f
  }
  if (skirt > 0) {
    const border: number[] = []
    for (let c = 0; c < cols; c++) border.push(c)
    for (let r = 0; r < rows; r++) border.push(r * cols + cols - 1)
    for (let c = cols - 1; c >= 0; c--) border.push((rows - 1) * cols + c)
    for (let r = rows - 1; r >= 0; r--) border.push(r * cols)
    for (let i = 0; i < border.length; i++) {
      const s = border[i] * 3, t = (nGrid + i) * 3
      pos[t] = pos[s]; pos[t + 1] = pos[s + 1] - skirt; pos[t + 2] = pos[s + 2]
      nor[t] = nor[s]; nor[t + 1] = nor[s + 1]; nor[t + 2] = nor[s + 2]
    }
    for (let i = 0; i < border.length; i++) {
      const j = (i + 1) % border.length
      const a = border[i], b = border[j], a2 = nGrid + i, b2 = nGrid + j
      idx[q++] = a; idx[q++] = b; idx[q++] = a2
      idx[q++] = b; idx[q++] = b2; idx[q++] = a2
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3, true))
  g.setIndex(new THREE.BufferAttribute(idx, 1))
  g.computeBoundingSphere()
  g.computeBoundingBox()
  return g
}

/** Top-down hillshade + slope tint of the analysis grid: fallback ortho for sites without an image, and mini-map. */
export function makeHillshadeCanvas(site: SiteData): HTMLCanvasElement {
  const n = site.meta.core.na
  const cv = document.createElement('canvas')
  cv.width = n; cv.height = n
  const ctx = cv.getContext('2d')!
  const img = ctx.createImageData(n, n)
  const z = site.z, cell = site.meta.core.cell
  const L = [-0.55, 0.62, -0.55]   // light from the north-west, above
  const ll = Math.hypot(L[0], L[1], L[2])
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const k = i * n + j
    const gx = (z[i * n + Math.min(n - 1, j + 1)] - z[i * n + Math.max(0, j - 1)]) / (2 * cell)
    const gz = (z[Math.min(n - 1, i + 1) * n + j] - z[Math.max(0, i - 1) * n + j]) / (2 * cell)
    const nl = Math.hypot(gx, 1, gz)
    const shade = Math.max(0, (-gx * L[0] + L[1] - gz * L[2]) / (nl * ll))
    const s = Math.min(1, (site.slope[k] || 0) / 35)
    const base = 0.45 + 0.75 * shade
    img.data[k * 4] = Math.min(255, (150 + 60 * s) * base)
    img.data[k * 4 + 1] = Math.min(255, (100 - 30 * s) * base)
    img.data[k * 4 + 2] = Math.min(255, (70 - 30 * s) * base)
    img.data[k * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return cv
}

function loadTex(url: string, srgb: boolean, repeat: boolean, onLoad: () => void): THREE.Texture {
  const t = new THREE.TextureLoader().load(url, onLoad, undefined, () => console.warn('texture missing', url))
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping
  t.anisotropy = 8
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.magFilter = THREE.LinearFilter
  t.flipY = false   // raster rows run north -> south = +z
  return t
}

export interface Level {
  geo: THREE.BufferGeometry
  tex: THREE.Texture
  rect: THREE.Vector4   // ortho rectangle in world (x0, z0, 1/w, 1/h)
}

export interface TerrainKit {
  site: SiteData
  desc: SiteDescriptor
  half: number
  size: number
  Z0: number
  /** world ground height (y) at world x/z */
  groundY: (x: number, z: number) => number
  /** core metres -> world position on the ground (+ lift) */
  toWorld: (cx: number, cy: number, lift?: number, out?: THREE.Vector3) => THREE.Vector3
  coreRect: THREE.Vector4
  orthoTex: THREE.Texture
  orthoImageUrl: string | null
  hillshade: HTMLCanvasElement
  detailTex: THREE.Texture
  hTex: THREE.DataTexture       // analysis heights (relative to Z0), for shader shadow marching
  layTex: THREE.DataTexture     // R = rockfall reach angle * 6
  coreGeo: (stride: number) => THREE.BufferGeometry
  reg: Level | null
  far: Level | null
  onLoad: Set<() => void>
  refs: number
  disposed: boolean
  extra: Set<{ dispose: () => void }>
}

const kits = new WeakMap<SiteData, TerrainKit>()

function validGrid(h: Float32Array | undefined, nx: number, ny: number) {
  return !!h && nx > 1 && ny > 1 && h.length === nx * ny
}

export function getKit(site: SiteData, desc: SiteDescriptor): TerrainKit {
  const old = kits.get(site)
  if (old && !old.disposed) return old
  const { core, reg, far } = site.meta
  const half = core.size / 2, Z0 = site.Z0
  const groundY = makeGroundY(site)
  const onLoad = new Set<() => void>()
  const fire = () => onLoad.forEach(f => f())
  const coreRect = new THREE.Vector4(-half, -half, 1 / core.size, 1 / core.size)
  const hillshade = makeHillshadeCanvas(site)
  let orthoTex: THREE.Texture
  if (desc.orthoUrl) orthoTex = loadTex(desc.orthoUrl, true, false, fire)
  else {
    const t = new THREE.CanvasTexture(hillshade)
    t.colorSpace = THREE.SRGBColorSpace; t.flipY = false
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 8
    orthoTex = t
  }
  const detailTex = loadTex(BASE + 'models/tex/sandy_gravel_02_diff.webp', true, true, fire)
  const na = core.na
  const hd = new Float32Array(na * na)
  for (let i = 0; i < hd.length; i++) hd[i] = site.z[i] - Z0
  const hTex = new THREE.DataTexture(hd, na, na, THREE.RedFormat, THREE.FloatType)
  hTex.minFilter = hTex.magFilter = THREE.LinearFilter; hTex.needsUpdate = true
  const ld = new Uint8Array(na * na)
  for (let i = 0; i < ld.length; i++) ld[i] = Math.min(255, Math.round((site.beta[i] || 0) * 6))
  const layTex = new THREE.DataTexture(ld, na, na, THREE.RedFormat, THREE.UnsignedByteType)
  layTex.minFilter = layTex.magFilter = THREE.LinearFilter; layTex.needsUpdate = true

  const coreCache = new Map<number, THREE.BufferGeometry>()
  const coreGeo = (stride: number) => {
    let g = coreCache.get(stride)
    if (!g) { g = buildTerrainGeometry(site.coreH, core.n, core.n, -half, -half, core.renderCell, Z0, stride, 30); coreCache.set(stride, g) }
    return g
  }
  // canyon wall + CTX context levels (images only for the bundled site)
  let regL: Level | null = null, farL: Level | null = null
  // sites fetched in the browser have context heights but no images: plain ochre, shaded by the sun in the shader
  const plain = () => {
    const t = new THREE.DataTexture(new Uint8Array([150, 98, 66, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType)
    t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true
    return t
  }
  void plain
  // shaded relief + elevation tint from the context heights themselves (fetched sites have no context images)
  const reliefTex = (h: Float32Array, nx: number, ny: number, cell: number) => {
    const cv = document.createElement('canvas'); cv.width = nx; cv.height = ny
    const g = cv.getContext('2d')!, img = g.createImageData(nx, ny)
    let lo = Infinity, hi = -Infinity
    for (let i = 0; i < h.length; i++) { const v = h[i]; if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v } }
    const span = Math.max(1, hi - lo)
    for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
      const k = i * nx + j
      const gx = (h[i * nx + Math.min(nx - 1, j + 1)] - h[i * nx + Math.max(0, j - 1)]) / (2 * cell)
      const gy = (h[Math.min(ny - 1, i + 1) * nx + j] - h[Math.max(0, i - 1) * nx + j]) / (2 * cell)
      const shade = Math.max(0, Math.min(1, 0.62 - gx * 1.6 - gy * 1.1))
      const e = (h[k] - lo) / span
      // low ground dark basaltic sand, high ground dusty butterscotch (approximate colour)
      const r = 70 + 120 * e, gg = 48 + 80 * e, b = 36 + 50 * e
      const m = 0.55 + 0.9 * shade
      img.data[k * 4] = Math.min(255, r * m); img.data[k * 4 + 1] = Math.min(255, gg * m); img.data[k * 4 + 2] = Math.min(255, b * m); img.data[k * 4 + 3] = 255
    }
    g.putImageData(img, 0, 0)
    const t = new THREE.CanvasTexture(cv)
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.needsUpdate = true
    return t
  }
  const ctxTex = (name: string, h?: Float32Array, nx = 0, ny = 0, cell = 1) => desc.bundled && name
    ? loadTex(BASE + 'data/site/' + name, true, false, fire)
    : h ? reliefTex(h, nx, ny, cell) : plain()
  if (validGrid(site.regH, reg.nx, reg.ny)) {
    const rx0 = reg.e0 - core.e0 - half, rz0 = reg.s0 - core.s0 - half
    regL = {
      geo: buildTerrainGeometry(site.regH, reg.nx, reg.ny, rx0 + reg.cell / 2, rz0 + reg.cell / 2, reg.cell, Z0, 2, 120),
      tex: ctxTex(reg.ortho, site.regH, reg.nx, reg.ny, reg.cell),
      rect: new THREE.Vector4(rx0, rz0, 1 / reg.w, 1 / reg.h),
    }
    if (validGrid(site.farH, far.nx, far.ny)) {
      const fx0 = far.e0 - core.e0 - half, fz0 = far.s0 - core.s0 - half
      farL = {
        geo: buildTerrainGeometry(site.farH, far.nx, far.ny, fx0 + far.cell / 2, fz0 + far.cell / 2, far.cell, Z0, 2, 0),
        tex: ctxTex(far.ortho, site.farH, far.nx, far.ny, far.cell),
        rect: new THREE.Vector4(fx0, fz0, 1 / far.w, 1 / far.h),
      }
    }
  }
  const kit: TerrainKit = {
    site, desc, half, size: core.size, Z0, groundY,
    toWorld: (cx, cy, lift = 0, out = new THREE.Vector3()) => out.set(cx - half, groundY(cx - half, cy - half) + lift, cy - half),
    coreRect, orthoTex, orthoImageUrl: desc.orthoUrl, hillshade, detailTex, hTex, layTex, coreGeo,
    reg: regL, far: farL, onLoad, refs: 0, disposed: false, extra: new Set(),
  }
  // keep the geometry caches reachable for disposal
  ;(kit as any)._coreCache = coreCache
  kits.set(site, kit)
  return kit
}

function disposeKit(kit: TerrainKit) {
  if (kit.disposed) return
  kit.disposed = true
  const cache: Map<number, THREE.BufferGeometry> = (kit as any)._coreCache
  cache.forEach(g => g.dispose()); cache.clear()
  kit.orthoTex.dispose(); kit.detailTex.dispose(); kit.hTex.dispose(); kit.layTex.dispose()
  for (const l of [kit.reg, kit.far]) if (l) { l.geo.dispose(); l.tex.dispose() }
  kit.extra.forEach(e => e.dispose()); kit.extra.clear()
  kit.onLoad.clear()
  if (kits.get(kit.site) === kit) kits.delete(kit.site)
}

export function retainKit(kit: TerrainKit) { kit.refs++ }
export function releaseKit(kit: TerrainKit) {
  kit.refs--
  // deferred: survives React StrictMode remounts and view swaps without rebuilding
  setTimeout(() => { if (kit.refs <= 0) disposeKit(kit) }, 1500)
}

/** Resampled route polyline (core metres) at a fixed spacing, keeping distance-along and flags. */
export interface Dense { x: Float32Array; y: Float32Array; d: Float32Array; flags: Uint8Array; n: number }

export function densify(samples: { x: number; y: number; d: number; flags: number }[], step = 1): Dense {
  const total = samples.length ? samples[samples.length - 1].d : 0
  const n = Math.max(2, Math.ceil(total / step) + 1)
  const out: Dense = { x: new Float32Array(n), y: new Float32Array(n), d: new Float32Array(n), flags: new Uint8Array(n), n }
  if (samples.length < 2) {
    const s = samples[0] ?? { x: 0, y: 0, d: 0, flags: 0 }
    for (let i = 0; i < n; i++) { out.x[i] = s.x; out.y[i] = s.y; out.d[i] = 0; out.flags[i] = s.flags }
    return out
  }
  let k = 0
  for (let i = 0; i < n; i++) {
    const d = Math.min(total, i * step)
    while (k < samples.length - 2 && samples[k + 1].d < d) k++
    const a = samples[k], b = samples[k + 1]
    const u = b.d > a.d ? Math.min(1, Math.max(0, (d - a.d) / (b.d - a.d))) : 0
    out.x[i] = a.x + (b.x - a.x) * u
    out.y[i] = a.y + (b.y - a.y) * u
    out.d[i] = d
    out.flags[i] = u < 0.5 ? a.flags : b.flags
  }
  return out
}
