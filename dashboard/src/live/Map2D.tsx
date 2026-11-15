// Top-down map of the planning box: orthoimage (or a hillshade built from the DEM), rockfall band, shelters,
// candidate routes, failed virtual crews and the crew. Drag to pan, wheel / pinch to zoom, click to place the crew.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SiteData } from './engine/site'
import type { LiveRoute, Shelter, SiteDescriptor } from './types'

interface Props {
  site: SiteData
  desc: SiteDescriptor
  routes: LiveRoute[]
  crew: { x: number; y: number } | null
  shelters: Shelter[]
  bandOn: boolean
  alphaDeg: number
  onPick: (x: number, y: number) => void
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#fff'

function hillshade(site: SiteData): HTMLCanvasElement {
  const n = site.meta.core.na, z = site.z, cell = site.meta.core.cell
  const cv = document.createElement('canvas'); cv.width = n; cv.height = n
  const ctx = cv.getContext('2d')!
  const img = ctx.createImageData(n, n)
  const lx = -0.6, ly = -0.6, lz = 0.53
  // auto-contrast: gentle terrain (coarse global data) is shaded with an exaggerated gradient so its relief shows
  let g95 = 0
  { const gs: number[] = []
    for (let i = 1; i < n - 1; i += 7) for (let j = 1; j < n - 1; j += 7) gs.push(Math.hypot(z[i * n + j + 1] - z[i * n + j - 1], z[(i + 1) * n + j] - z[(i - 1) * n + j]) / (2 * cell))
    gs.sort((a, b) => a - b); g95 = gs[Math.floor(gs.length * 0.95)] || 0 }
  const ex = g95 > 0 ? Math.min(40, Math.max(1, 0.35 / g95)) : 1
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const k = i * n + j
    const gx = ex * (z[i * n + Math.min(n - 1, j + 1)] - z[i * n + Math.max(0, j - 1)]) / (2 * cell)
    const gy = ex * (z[Math.min(n - 1, i + 1) * n + j] - z[Math.max(0, i - 1) * n + j]) / (2 * cell)
    const len = Math.hypot(gx, gy, 1)
    const s = Math.max(0, (-gx * lx - gy * ly + lz) / len)
    const v = 40 + 170 * s
    img.data[k * 4] = v * 1.05; img.data[k * 4 + 1] = v * 0.86; img.data[k * 4 + 2] = v * 0.7; img.data[k * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return cv
}

function bandLayer(site: SiteData, alpha: number): HTMLCanvasElement {
  const n = site.meta.core.na
  const cv = document.createElement('canvas'); cv.width = n; cv.height = n
  const ctx = cv.getContext('2d')!
  const img = ctx.createImageData(n, n)
  for (let k = 0; k < n * n; k++) if (site.beta[k] >= alpha) {
    img.data[k * 4] = 255; img.data[k * 4 + 1] = 95; img.data[k * 4 + 2] = 87; img.data[k * 4 + 3] = 70
  }
  ctx.putImageData(img, 0, 0)
  return cv
}

export default function Map2D({ site, desc, routes, crew, shelters, bandOn, alphaDeg, onPick }: Props) {
  const wrap = useRef<HTMLDivElement>(null)
  const cvs = useRef<HTMLCanvasElement>(null)
  const [img, setImg] = useState<CanvasImageSource | null>(null)
  const [size, setSize] = useState({ w: 600, h: 600 })
  const view = useRef({ s: 1, ox: 0, oy: 0 })          // screen = (core * fit * s) + o
  const [, force] = useState(0)
  const L = site.meta.core.size
  const band = useMemo(() => bandLayer(site, alphaDeg), [site, alphaDeg])

  useEffect(() => {
    let alive = true
    if (desc.orthoUrl) {
      const im = new Image()
      im.crossOrigin = 'anonymous'
      im.onload = () => alive && setImg(im)
      im.onerror = () => alive && setImg(hillshade(site))
      im.src = desc.orthoUrl
    } else setImg(hillshade(site))
    return () => { alive = false }
  }, [site, desc.orthoUrl])

  useEffect(() => {
    const el = wrap.current!
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // reset the view when the site changes
  useEffect(() => { view.current = { s: 1, ox: 0, oy: 0 }; force(x => x + 1) }, [site])

  const fit = Math.min(size.w, size.h) / L
  const base = { x: (size.w - L * fit) / 2, y: (size.h - L * fit) / 2 }
  const toScreen = (x: number, y: number) => {
    const v = view.current
    return [base.x + v.ox + x * fit * v.s, base.y + v.oy + y * fit * v.s] as const
  }
  const toCore = (sx: number, sy: number) => {
    const v = view.current
    return [(sx - base.x - v.ox) / (fit * v.s), (sy - base.y - v.oy) / (fit * v.s)] as const
  }

  useEffect(() => {
    const cv = cvs.current!
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    cv.width = size.w * dpr; cv.height = size.h * dpr
    const g = cv.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.fillStyle = css('--color-bg'); g.fillRect(0, 0, size.w, size.h)
    const [x0, y0] = toScreen(0, 0), [x1, y1] = toScreen(L, L)
    if (img) { g.imageSmoothingEnabled = true; g.drawImage(img, x0, y0, x1 - x0, y1 - y0) }
    if (bandOn) g.drawImage(band, x0, y0, x1 - x0, y1 - y0)
    g.strokeStyle = css('--color-rule2'); g.lineWidth = 1; g.strokeRect(x0, y0, x1 - x0, y1 - y0)
    const safe = css('--color-safe'), data = css('--color-data'), hazard = css('--color-hazard'), accent = css('--color-accent')
    // failed virtual crews of the chosen route
    const ch = routes.find(r => r.chosen)
    if (ch?.failXY) {
      g.fillStyle = hazard
      for (let k = 0; k < ch.failXY.length; k += 2) { const [sx, sy] = toScreen(ch.failXY[k], ch.failXY[k + 1]); g.fillRect(sx - 1.5, sy - 1.5, 3, 3) }
    }
    // routes: others first, chosen on top
    for (const r of [...routes].sort((a, b) => Number(a.chosen) - Number(b.chosen))) {
      if (r.samples.length < 2) continue
      g.beginPath()
      r.samples.forEach((s, k) => { const [sx, sy] = toScreen(s.x, s.y); if (k) g.lineTo(sx, sy); else g.moveTo(sx, sy) })
      if (r.chosen) {
        g.setLineDash([]); g.strokeStyle = 'rgba(0,0,0,.65)'; g.lineWidth = 7; g.stroke()
        g.strokeStyle = safe; g.lineWidth = 3.5; g.stroke()
      } else {
        g.setLineDash(r.admissible ? [] : [6, 5]); g.strokeStyle = r.admissible ? data : hazard; g.globalAlpha = 0.75; g.lineWidth = 2; g.stroke(); g.globalAlpha = 1
      }
    }
    g.setLineDash([])
    // turn markers on the chosen route
    if (ch) for (const t of ch.turns) {
      const s = ch.samples[t.i]; const [sx, sy] = toScreen(s.x, s.y)
      g.fillStyle = safe; g.beginPath(); g.arc(sx, sy, 3, 0, Math.PI * 2); g.fill()
    }
    // shelters
    g.font = '600 12px "Instrument Sans Variable", sans-serif'
    const drawn = new Map<string, Shelter>()
    for (const sh of shelters) drawn.set(sh.id, sh)
    for (const r of routes) if (!drawn.has(r.destId)) drawn.set(r.destId, { id: r.destId, kind: r.destKind, name: r.destName, x: r.destX, y: r.destY, shield: r.shield, open: r.admissible })
    for (const sh of drawn.values()) {
      const [sx, sy] = toScreen(sh.x, sh.y)
      const chosen = ch?.destId === sh.id
      g.fillStyle = 'rgba(0,0,0,.6)'; g.strokeStyle = !sh.open ? hazard : chosen ? safe : '#efebe4'; g.lineWidth = 2
      g.beginPath()
      if (sh.kind === 'habitat') g.rect(sx - 7, sy - 7, 14, 14)
      else if (sh.kind === 'rover') { g.moveTo(sx, sy - 8); g.lineTo(sx + 8, sy + 6); g.lineTo(sx - 8, sy + 6); g.closePath() }
      else g.arc(sx, sy, 6, 0, Math.PI * 2)
      g.fill(); g.stroke()
      if (!sh.open) { g.beginPath(); g.moveTo(sx - 6, sy - 6); g.lineTo(sx + 6, sy + 6); g.moveTo(sx + 6, sy - 6); g.lineTo(sx - 6, sy + 6); g.stroke() }
      const label = sh.name.replace('Pressurized ', '').replace(' (assumed parked here)', '') + (sh.open ? '' : ' · closed')
      g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.8)'; g.strokeText(label, sx + 10, sy + 4)
      g.fillStyle = !sh.open ? hazard : chosen ? safe : '#efebe4'; g.fillText(label, sx + 10, sy + 4)
    }
    if (crew) {
      const [sx, sy] = toScreen(crew.x, crew.y)
      g.fillStyle = accent; g.strokeStyle = '#1c1407'; g.lineWidth = 2
      g.beginPath(); g.arc(sx, sy, 7, 0, Math.PI * 2); g.fill(); g.stroke()
      g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.8)'; g.strokeText('Crew', sx + 10, sy - 8)
      g.fillStyle = accent; g.fillText('Crew', sx + 10, sy - 8)
    }
    // scale bar
    const m = 500, [a] = toScreen(0, 0), [b] = toScreen(m, 0)
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(10, size.h - 30, b - a + 50, 20)
    g.fillStyle = '#efebe4'; g.fillRect(16, size.h - 18, b - a, 3); g.fillText('500 m', 22 + b - a, size.h - 14)
  })

  // ---- interaction
  const drag = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean; id: number } | null>(null)
  const pts = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ d: number; s: number } | null>(null)
  const zoomAt = (sx: number, sy: number, k: number) => {
    const v = view.current
    const s2 = Math.min(12, Math.max(1, v.s * k))
    const kk = s2 / v.s
    v.ox = sx - base.x - (sx - base.x - v.ox) * kk; v.oy = sy - base.y - (sy - base.y - v.oy) * kk; v.s = s2
    if (s2 === 1) { v.ox = 0; v.oy = 0 }
    force(x => x + 1)
  }
  useEffect(() => {
    const el = cvs.current!
    const wheel = (e: WheelEvent) => { e.preventDefault(); const r = el.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.2 : 1 / 1.2) }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  })

  return (
    <div ref={wrap} className="relative h-full w-full touch-none select-none overflow-hidden">
      <canvas
        ref={cvs}
        style={{ width: size.w, height: size.h, cursor: 'crosshair' }}
        aria-label="Map of the planning box. Click to place the crew."
        onPointerDown={e => {
          const r = e.currentTarget.getBoundingClientRect()
          pts.current.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top })
          if (pts.current.size === 2) {
            const [p1, p2] = [...pts.current.values()]
            pinch.current = { d: Math.hypot(p1.x - p2.x, p1.y - p2.y), s: view.current.s }
            drag.current = null
          } else {
            drag.current = { x: e.clientX, y: e.clientY, ox: view.current.ox, oy: view.current.oy, moved: false, id: e.pointerId }
          }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={e => {
          const r = e.currentTarget.getBoundingClientRect()
          if (pts.current.has(e.pointerId)) pts.current.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top })
          if (pinch.current && pts.current.size === 2) {
            const [p1, p2] = [...pts.current.values()]
            const d = Math.hypot(p1.x - p2.x, p1.y - p2.y)
            zoomAt((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, (pinch.current.s * d / pinch.current.d) / view.current.s)
            return
          }
          const d = drag.current
          if (!d || d.id !== e.pointerId) return
          const dx = e.clientX - d.x, dy = e.clientY - d.y
          if (Math.hypot(dx, dy) > 4) d.moved = true
          if (d.moved && view.current.s > 1) { view.current.ox = d.ox + dx; view.current.oy = d.oy + dy; force(x => x + 1) }
        }}
        onPointerUp={e => {
          pts.current.delete(e.pointerId)
          if (pts.current.size < 2) pinch.current = null
          const d = drag.current
          drag.current = null
          if (!d || d.moved || d.id !== e.pointerId) return
          const r = e.currentTarget.getBoundingClientRect()
          const [x, y] = toCore(e.clientX - r.left, e.clientY - r.top)
          if (x >= 0 && y >= 0 && x <= L && y <= L) onPick(x, y)
        }}
        onPointerCancel={e => { pts.current.delete(e.pointerId); drag.current = null; pinch.current = null }}
      />
      <div className="pointer-events-none absolute right-2 top-2 flex flex-col gap-1">
        <span className="rounded bg-black/60 px-2 py-0.5 text-[11px] text-ink2">N ↑ · {(L / 1000).toFixed(0)} km box</span>
      </div>
      {routes.length > 0 && (
        <div className="pointer-events-none absolute bottom-10 left-2 flex max-w-[calc(100%-1rem)] flex-wrap gap-x-3 gap-y-0.5 rounded bg-black/65 px-2 py-1 text-[11px] text-ink2">
          <span className="flex items-center gap-1"><i className="inline-block h-[3px] w-4 bg-safe" />Chosen route</span>
          <span className="flex items-center gap-1"><i className="inline-block h-[2px] w-4 bg-data" />Other routes</span>
          <span className="flex items-center gap-1"><i className="inline-block h-0 w-4 border-t-2 border-dashed border-hazard" />Closed</span>
          <span className="flex items-center gap-1"><i className="inline-block h-2 w-2 bg-hazard" />Where virtual crews failed</span>
          {bandOn && <span className="flex items-center gap-1"><i className="inline-block h-2.5 w-3 bg-hazard/30" />Rockfall runout band</span>}
        </div>
      )}
      <div className="absolute bottom-2 right-2 flex gap-1">
        <button className="h-8 w-8 rounded bg-black/60 text-ink" aria-label="Zoom in" onClick={() => zoomAt(size.w / 2, size.h / 2, 1.5)}>+</button>
        <button className="h-8 w-8 rounded bg-black/60 text-ink" aria-label="Zoom out" onClick={() => zoomAt(size.w / 2, size.h / 2, 1 / 1.5)}>−</button>
      </div>
    </div>
  )
}
