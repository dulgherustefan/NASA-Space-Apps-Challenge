import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Box, Compass, Minus, Plus, Route, Scan, X as Close } from 'lucide-react'
import { CORE_DEFAULT, LAYER_LABEL, ORTHO_PATH, fileUrl, type Layer } from '@/lib/config'
import { focusBundle, focusIncidentId, store, useStore } from '@/lib/store'
import { requestPlan } from '@/lib/engine'
import { bearingText, lineTo } from '@/lib/derive'
import { num } from '@/lib/format'
import { MAP, ROUTE_STYLE, OUTCOME_FAIL, FAIL_LABEL } from '@/lib/routeStyle'
import type { RouteStatus } from '@/lib/types'
import { cn } from '@/lib/utils'
import { LayerLegend, LayerMenu } from './console/Layers'
import { KIND_NAME } from './console/Situation'

// 3D map and helmet HUD over the dashboard, loaded on first use (src/live)
const Views3D = lazy(() => import('@/live/Views3D'))
import { Timeline } from './Timeline'
import { PlaceView } from './console/PlaceView'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

interface Img { el: HTMLImageElement; ready: boolean; failed: boolean; at: number }
const imgCache = new Map<string, Img>()
/** Cached image. A failed load is tried again after a few seconds, so the map recovers when the engine comes back. */
function getImg(url: string, online: boolean): Img | null {
  if (!url) return null
  let c = imgCache.get(url)
  if (c && c.failed && online && performance.now() - c.at > 5000) { imgCache.delete(url); c = undefined }
  if (!c) {
    if (!online) return null
    const el = new Image()
    const entry: Img = { el, ready: false, failed: false, at: performance.now() }
    el.onload = () => { entry.ready = true }
    el.onerror = () => { entry.failed = true; entry.at = performance.now() }
    el.src = url
    c = entry
    imgCache.set(url, c)
    if (imgCache.size > 40) {
      const first = imgCache.keys().next().value
      if (first) imgCache.delete(first)
    }
  }
  return c
}

interface View { k: number; ox: number; oy: number; fit: number; w: number; h: number; fitted: boolean }
interface Hit { x: number; y: number; r: number; title: string; lines: string[]; place?: string }
const INK = MAP.ink
const DARK = '#0c0b0a'
const FACE = getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim() || "system-ui, sans-serif"
const LABEL = `400 12px ${FACE}`

/** Distance in pixels from a point to a segment. */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay
  const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

function halo(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color = INK, align: CanvasTextAlign = 'left') {
  ctx.font = LABEL; ctx.textAlign = align; ctx.textBaseline = 'middle'
  ctx.lineWidth = 3; ctx.strokeStyle = MAP.line; ctx.lineJoin = 'round'
  ctx.strokeText(text, x, y); ctx.fillStyle = color; ctx.fillText(text, x, y)
}

function pathLen(pts: [number, number, number][]) {
  let l = 0
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  return l
}

export function MapView() {
  const wrap = useRef<HTMLDivElement>(null)
  const cv = useRef<HTMLCanvasElement>(null)
  const view = useRef<View>({ k: 0.2, ox: 0, oy: 0, fit: 0.2, w: 0, h: 0, fitted: false })
  const hoverRef = useRef<{ x: number; y: number } | null>(null)
  const hitsRef = useRef<Hit[]>([])
  const dragging = useRef(false)
  const [tip, setTip] = useState<{ x: number; y: number; title: string; lines: string[] } | null>(null)
  const [coord, setCoord] = useState<{ e: number; s: number } | null>(null)
  const focusId = useStore(focusIncidentId)
  const planMode = useStore((s) => s.planMode)
  const planFrom = useStore((s) => s.planFrom)
  // a recorded-run web build plans in the browser (src/live/bridge.ts)
  const canPlan = useStore((s) => s.mode === 'live' || s.mode === 'replay')
  const [view3d, setView3d] = useState<null | '3d' | 'hud'>(null)
  useEffect(() => {
    const on = (e: Event) => setView3d((e as CustomEvent<null | '3d' | 'hud'>).detail)
    window.addEventListener('solway:view', on)
    return () => window.removeEventListener('solway:view', on)
  }, [])
  const online = useStore((s) => s.conn === 'online')
  const planRef = useRef(planMode)
  planRef.current = planMode
  const routesFileInc = useStore((s) => s.routesFile?.incident_id)
  const helloCore = useStore((s) => s.hello?.site.core)
  const core = helloCore ?? CORE_DEFAULT
  const { e0, s0, size } = core

  const fitView = useCallback(() => {
    const v = view.current
    if (!v.w || !v.h) return
    const fit = (Math.min(v.w, v.h) / size) * 0.96
    v.fit = fit; v.k = fit
    v.ox = (v.w - size * fit) / 2
    v.oy = (v.h - size * fit) / 2
    v.fitted = true
  }, [size])

  /** Frame the routes of the incident in focus together with the crew. Falls back to the whole box. */
  const fitRoutes = useCallback(() => {
    const v = view.current
    const st = store.get()
    const incId = focusIncidentId(st)
    const rf = st.routesFile && st.routesFile.incident_id === incId ? st.routesFile : null
    const chosenId = focusBundle(st)?.decision?.route_id
    const pts: [number, number][] = []
    for (const r of rf?.routes ?? []) if (chosenId === undefined || r.id === chosenId) for (const p of r.points) pts.push([p[0], p[1]])
    for (const c of st.snapshot?.crew ?? []) pts.push([c.e, c.s])
    if (!v.w || !v.h || pts.length < 2) { fitView(); return }
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity
    for (const [e, s] of pts) { a = Math.min(a, e); b = Math.max(b, e); c = Math.min(c, s); d = Math.max(d, s) }
    // screen space kept free: layer chips on top, buttons and place labels on the right
    const padL = 40, padR = Math.min(190, v.w * 0.28), padT = 84, padB = 56
    const availW = Math.max(120, v.w - padL - padR), availH = Math.max(120, v.h - padT - padB)
    const k = Math.min(v.fit * 9, Math.max(v.fit, Math.min(availW / Math.max(b - a, 220), availH / Math.max(d - c, 220))))
    v.k = k
    v.ox = padL + availW / 2 - ((a + b) / 2 - e0) * k
    v.oy = padT + availH / 2 - ((c + d) / 2 - s0) * k
  }, [fitView, e0, s0])

  // new routes for the incident in focus: bring them into frame
  const routesV = useStore((s) => s.routesV)
  const chosenRoute = useStore((s) => focusBundle(s)?.decision?.route_id)
  useEffect(() => { if (routesV > 0) fitRoutes() }, [routesV, focusId, chosenRoute, fitRoutes])

  const zoomAt = useCallback((f: number, cx?: number, cy?: number) => {
    const v = view.current
    const x = cx ?? v.w / 2, y = cy ?? v.h / 2
    const nk = Math.min(v.fit * 14, Math.max(v.fit * 0.7, v.k * f))
    const r = nk / v.k
    v.ox = x - (x - v.ox) * r; v.oy = y - (y - v.oy) * r; v.k = nk
  }, [])

  // sizing
  useEffect(() => {
    const el = wrap.current, c = cv.current
    if (!el || !c) return
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1
      const w = el.clientWidth, h = el.clientHeight
      c.width = Math.max(1, Math.round(w * dpr)); c.height = Math.max(1, Math.round(h * dpr))
      c.style.width = `${w}px`; c.style.height = `${h}px`
      const v = view.current
      const wasFit = !v.fitted || Math.abs(v.k - v.fit) < 1e-6
      v.w = w; v.h = h
      if (wasFit) fitView()
      else v.fit = (Math.min(w, h) / size) * 0.96
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [fitView, size])

  // input
  useEffect(() => {
    const c = cv.current
    if (!c) return
    let drag: { x: number; y: number } | null = null
    let press: { x: number; y: number } | null = null
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = c.getBoundingClientRect()
      zoomAt(Math.exp(-e.deltaY * 0.0016), e.clientX - r.left, e.clientY - r.top)
    }
    const onDown = (e: PointerEvent) => { drag = { x: e.clientX, y: e.clientY }; press = drag; dragging.current = true; c.setPointerCapture(e.pointerId); c.style.cursor = 'grabbing' }
    const onMove = (e: PointerEvent) => {
      const r = c.getBoundingClientRect()
      const x = e.clientX - r.left, y = e.clientY - r.top
      if (drag) { view.current.ox += e.clientX - drag.x; view.current.oy += e.clientY - drag.y; drag = { x: e.clientX, y: e.clientY } }
      hoverRef.current = { x, y }
      const v = view.current
      setCoord({ e: e0 + (x - v.ox) / v.k, s: s0 + (y - v.oy) / v.k })
    }
    const onUp = (e: PointerEvent) => {
      drag = null; dragging.current = false; c.style.cursor = ''
      try { c.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
      const still = press && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6
      press = null
      if (!still || e.button !== 0) return
      const r = c.getBoundingClientRect(), v = view.current
      const px = e.clientX - r.left, py = e.clientY - r.top
      if (planRef.current) {
        const pt = { e: e0 + (px - v.ox) / v.k, s: s0 + (py - v.oy) / v.k }
        if (e.shiftKey) store.set({ planFrom: { e: Math.round(pt.e * 10) / 10, s: Math.round(pt.s * 10) / 10 } })
        else requestPlan(pt)
        return
      }
      // a click picks what is under it: a place first, then a route line
      const st = store.get()
      let place: string | null = null, pd = 1e9
      for (const t of hitsRef.current) { if (!t.place) continue; const d = Math.hypot(t.x - px, t.y - py); if (d < t.r + 4 && d < pd) { place = t.place; pd = d } }
      if (place) { store.set({ selectedPlace: st.selectedPlace === place ? null : place }); return }
      const incId = focusIncidentId(st)
      const rf = st.routesFile && st.routesFile.incident_id === incId ? st.routesFile : null
      let rid: number | null = null, rd = 10
      for (const rt of rf?.routes ?? []) {
        for (let i = 1; i < rt.points.length; i++) {
          const a = rt.points[i - 1], b = rt.points[i]
          const d = segDist(px, py, v.ox + (a[0] - e0) * v.k, v.oy + (a[1] - s0) * v.k, v.ox + (b[0] - e0) * v.k, v.oy + (b[1] - s0) * v.k)
          if (d < rd) { rd = d; rid = rt.id }
        }
      }
      if (rid !== null) store.set({ selectedRoute: st.selectedRoute === rid ? null : rid, detail: 'routes', selectedPlace: null })
      else if (st.selectedPlace) store.set({ selectedPlace: null })
    }
    const onLeave = () => { hoverRef.current = null; setCoord(null); setTip(null) }
    c.addEventListener('wheel', onWheel, { passive: false })
    c.addEventListener('pointerdown', onDown); c.addEventListener('pointermove', onMove)
    c.addEventListener('pointerup', onUp); c.addEventListener('pointerleave', onLeave); c.addEventListener('dblclick', fitView)
    return () => {
      c.removeEventListener('wheel', onWheel); c.removeEventListener('pointerdown', onDown); c.removeEventListener('pointermove', onMove)
      c.removeEventListener('pointerup', onUp); c.removeEventListener('pointerleave', onLeave); c.removeEventListener('dblclick', fitView)
    }
  }, [zoomAt, fitView, e0, s0])

  // draw loop
  useEffect(() => {
    const c = cv.current
    if (!c) return
    const ctx = c.getContext('2d')!
    let raf = 0
    let lastTip = ''
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      const st = store.get()
      const v = view.current
      if (!v.w) return
      const dpr = window.devicePixelRatio || 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = DARK; ctx.fillRect(0, 0, v.w, v.h)
      const k = v.k
      const X = (e: number) => v.ox + (e - e0) * k
      const Y = (s: number) => v.oy + (s - s0) * k
      const x0 = X(e0), y0 = Y(s0), sz = size * k

      // ortho and scrim
      const online = st.conn === 'online'
      const ortho = getImg(fileUrl(ORTHO_PATH), online)
      if (ortho?.ready) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(ortho.el, x0, y0, sz, sz) }
      else { ctx.fillStyle = '#1a1f23'; ctx.fillRect(x0, y0, sz, sz) }
      ctx.fillStyle = 'rgba(8,11,13,.38)'; ctx.fillRect(x0, y0, sz, sz)

      // elevation contours under the hazard layer
      if (st.contours) {
        const ct = getImg(fileUrl('runtime/overlay_contours.png'), online)
        if (ct?.ready) { ctx.globalAlpha = 0.75; ctx.drawImage(ct.el, x0, y0, sz, sz); ctx.globalAlpha = 1 }
      }

      // overlay
      const layer = st.overlay.layer
      let overlayNote = ''
      if (layer) {
        const ov = getImg(fileUrl(`runtime/overlay_${layer}.png`, st.overlayV), online)
        if (ov?.ready) { ctx.globalAlpha = layer === 'comm' ? 1 : st.overlay.opacity; ctx.drawImage(ov.el, x0, y0, sz, sz); ctx.globalAlpha = 1 }
        else if (ov?.failed) overlayNote = `${LAYER_LABEL[layer as Layer] ?? layer} overlay not available yet`
      }

      // grid every 500 m
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(231,234,238,.07)'
      ctx.beginPath()
      for (let e = e0; e <= e0 + size + 0.1; e += 500) { const x = Math.round(X(e)) + 0.5; ctx.moveTo(x, y0); ctx.lineTo(x, y0 + sz) }
      for (let s = s0; s <= s0 + size + 0.1; s += 500) { const y = Math.round(Y(s)) + 0.5; ctx.moveTo(x0, y); ctx.lineTo(x0 + sz, y) }
      ctx.stroke()
      ctx.strokeStyle = 'rgba(120,128,134,.6)'; ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, sz, sz)
      const bundle = focusBundle(st)
      const incId = focusIncidentId(st)
      const live = st.snapshot
      const routesFile = st.routesFile && st.routesFile.incident_id === incId ? st.routesFile : null
      const statusOf = new Map<number, RouteStatus>((bundle?.routes ?? []).map((r) => [r.id, r.status]))
      const selId = st.selectedRoute

      // virtual-crew replays
      const traj = st.trajFile
      if (st.showReplays && traj && routesFile && bundle?.routes && traj.runs.length) {
        const inSim = live?.phase === 'simulate' && live.incident_id === incId
        const a = inSim ? 1 : 0.4
        const maxDur = Math.max(...traj.runs.map((r) => (r.samples.length - 1) * traj.dt), 60)
        const rt = ((now / 1000) * 60) % (maxDur + 360)
        for (const run of traj.runs) {
          if (statusOf.get(run.route) === 'infeasible') continue
          const n = run.samples.length
          if (n < 2) continue
          const idxF = Math.min(n - 1, rt / traj.dt)
          const i0 = Math.floor(idxF), i1 = Math.min(n - 1, i0 + 1), f = idxF - i0
          const col = ROUTE_STYLE[statusOf.get(run.route) ?? 'candidate'].map
          const fail = OUTCOME_FAIL(run.outcome)
          const from = Math.max(0, i0 - 28)
          ctx.beginPath()
          for (let i = from; i <= i0; i++) { const p = run.samples[i]; if (i === from) ctx.moveTo(X(p[0]), Y(p[1])); else ctx.lineTo(X(p[0]), Y(p[1])) }
          const pa = run.samples[i0], pb = run.samples[i1]
          const px = X(pa[0] + (pb[0] - pa[0]) * f), py = Y(pa[1] + (pb[1] - pa[1]) * f)
          ctx.lineTo(px, py)
          ctx.strokeStyle = fail ? MAP.hazard : col; ctx.globalAlpha = 0.35 * a; ctx.lineWidth = 1.2; ctx.setLineDash([]); ctx.stroke()
          ctx.globalAlpha = a
          if (idxF >= n - 1 && fail) {
            ctx.strokeStyle = MAP.hazard; ctx.lineWidth = 2
            ctx.beginPath(); ctx.moveTo(px - 4, py - 4); ctx.lineTo(px + 4, py + 4); ctx.moveTo(px + 4, py - 4); ctx.lineTo(px - 4, py + 4); ctx.stroke()
          } else {
            ctx.fillStyle = col; ctx.strokeStyle = DARK; ctx.lineWidth = 1.5
            ctx.beginPath(); ctx.arc(px, py, 2.8, 0, 6.283); ctx.stroke(); ctx.fill()
          }
          ctx.globalAlpha = 1
        }
      }

      // routes
      const decided = !!bundle?.decision
      if (routesFile) {
        const weight = (id: number) => (id === selId ? 3 : statusOf.get(id) === 'chosen' ? 2 : 0)
        const order = [...routesFile.routes].sort((p, q) => weight(p.id) - weight(q.id))
        for (const r of order) {
          if (r.points.length < 2) continue
          const status = statusOf.get(r.id) ?? 'candidate'
          const sty = ROUTE_STYLE[status]
          const sel = selId === r.id
          const chosen = status === 'chosen'
          const back = decided && !chosen && !sel
          const ch = st.routeChangedAt[`${routesFile.incident_id}:${r.id}`]
          const flash = ch ? Math.max(0, 1 - (Date.now() - ch) / 1100) : 0
          ctx.beginPath()
          r.points.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))))
          ctx.lineJoin = 'round'; ctx.lineCap = 'round'
          const base = chosen ? 4.5 : sel ? 3.2 : back ? 1.6 : 2.2
          ctx.setLineDash([]); ctx.strokeStyle = back ? 'rgba(6,8,10,.45)' : 'rgba(6,8,10,.8)'; ctx.lineWidth = base + 2.6; ctx.stroke()
          if (status === 'testing') { ctx.setLineDash([7, 5]); ctx.lineDashOffset = -((now / 45) % 12) }
          else if (status === 'rejected') ctx.setLineDash([2, 5])
          else if (status === 'infeasible') ctx.setLineDash([1, 5])
          ctx.globalAlpha = back ? 0.55 : status === 'infeasible' ? 0.6 : 1
          ctx.strokeStyle = back ? MAP.quiet : sty.map; ctx.lineWidth = base + flash * 3; ctx.stroke()
          ctx.setLineDash([])
          if (flash > 0) { ctx.globalAlpha = flash * 0.5; ctx.lineWidth = base + 10 * (1 - flash) + 4; ctx.stroke() }
          ctx.globalAlpha = 1
          // number tag at 30% of the length
          const total = pathLen(r.points)
          let acc = 0, tp = r.points[0]
          for (let i = 1; i < r.points.length; i++) {
            acc += Math.hypot(r.points[i][0] - r.points[i - 1][0], r.points[i][1] - r.points[i - 1][1])
            if (acc >= total * 0.3) { tp = r.points[i]; break }
          }
          const tx = X(tp[0]), ty = Y(tp[1])
          ctx.globalAlpha = back ? 0.7 : 1
          ctx.fillStyle = chosen ? MAP.route : DARK; ctx.strokeStyle = chosen ? DARK : back ? MAP.quiet : sty.map; ctx.lineWidth = sel ? 2 : 1.4
          ctx.beginPath(); ctx.arc(tx, ty, sel ? 10 : 9, 0, 6.283); ctx.fill(); ctx.stroke()
          ctx.font = `600 11.5px ${FACE}`; ctx.fillStyle = chosen ? '#06231c' : INK; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
          ctx.fillText(String(r.id), tx, ty + 0.5)
          ctx.globalAlpha = 1
        }
      }

      const hits: Hit[] = []

      // failure markers
      if (bundle) {
        for (const stress of Object.values(bundle.stress)) {
          const isSel = selId === stress.route_id
          if (decided && !isSel && stress.route_id !== bundle.decision!.route_id) continue
          const list = [...stress.failures].sort((a, b) => b.log_p - a.log_p).slice(0, 3)
          list.forEach((f, i) => {
            const x = X(f.e), y = Y(f.s)
            const rr = isSel ? 7 : 4.5
            ctx.globalAlpha = isSel || selId === null ? 1 : 0.55
            ctx.fillStyle = MAP.hazard; ctx.strokeStyle = DARK; ctx.lineWidth = 1.5
            ctx.beginPath(); ctx.moveTo(x, y - rr); ctx.lineTo(x + rr, y); ctx.lineTo(x, y + rr); ctx.lineTo(x - rr, y); ctx.closePath(); ctx.stroke(); ctx.fill()
            if (isSel) { ctx.font = `600 9.5px ${FACE}`; ctx.fillStyle = '#1a0807'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(i + 1), x, y + 0.5) }
            ctx.globalAlpha = 1
            hits.push({ x, y, r: rr + 4, title: `Route ${stress.route_id}: ${FAIL_LABEL[f.class] ?? f.class} (failure ${i + 1})`, lines: [f.summary ?? '', `log p ${f.log_p.toFixed(1)}`] })
          })
        }
      }

      // places
      const shelterState = new Map((bundle?.assessment?.shelters ?? []).map((s) => [s.id, s]))
      for (const p of st.hello?.places ?? []) {
        const x = X(p.e), y = Y(p.s)
        const sh = shelterState.get(p.id)
        let col = INK
        if (p.kind === 'shelter') col = sh ? (sh.open ? MAP.open : MAP.hazard) : MAP.quiet
        if (st.selectedPlace === p.id) {
          const lead = live?.crew[0]
          if (lead) {
            ctx.beginPath(); ctx.moveTo(X(lead.e), Y(lead.s)); ctx.lineTo(x, y)
            ctx.setLineDash([]); ctx.strokeStyle = MAP.line; ctx.lineWidth = 3.5; ctx.stroke()
            ctx.setLineDash([5, 5]); ctx.strokeStyle = INK; ctx.lineWidth = 1.4; ctx.stroke(); ctx.setLineDash([])
          }
          ctx.beginPath(); ctx.arc(x, y, 15, 0, 6.283)
          ctx.strokeStyle = MAP.line; ctx.lineWidth = 5; ctx.stroke()
          ctx.strokeStyle = MAP.select; ctx.lineWidth = 2.2; ctx.stroke()
        }
        ctx.lineWidth = 1.6; ctx.strokeStyle = DARK; ctx.fillStyle = col
        ctx.beginPath()
        if (p.kind === 'habitat') ctx.rect(x - 6, y - 6, 12, 12)
        else if (p.kind === 'rover') ctx.roundRect(x - 7, y - 4, 14, 8, 2)
        else if (p.kind === 'shelter') { ctx.moveTo(x - 7, y + 5); ctx.lineTo(x - 7, y - 1); ctx.arc(x, y - 1, 7, Math.PI, 0); ctx.lineTo(x + 7, y + 5); ctx.closePath() }
        else { ctx.moveTo(x, y - 8); ctx.lineTo(x + 8, y); ctx.lineTo(x, y + 8); ctx.lineTo(x - 8, y); ctx.closePath() }
        ctx.stroke(); ctx.fill()
        if (p.kind === 'shelter' && sh && !sh.open) {
          ctx.strokeStyle = DARK; ctx.lineWidth = 1.8; ctx.beginPath()
          ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4); ctx.stroke()
        }
        halo(ctx, p.name, x + 11, y)
        hits.push({ x, y, r: 12, title: p.name, place: p.id, lines: [(KIND_NAME[p.kind] ?? p.kind) + (sh ? (sh.open ? ', open' : ', closed') : ''), sh?.reason ?? '', 'Click for distance and bearing'] })
      }

      // crew: members standing together share one label
      const crewLabels: { x: number; y: number; names: string[]; bad: boolean }[] = []
      for (const cr of live?.crew ?? []) {
        const tr = st.trails[cr.id]
        if (tr && tr.length > 1) {
          ctx.beginPath(); tr.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))))
          ctx.strokeStyle = 'rgba(244,246,247,.55)'; ctx.lineWidth = 1.4; ctx.setLineDash([]); ctx.stroke()
        }
        const x = X(cr.e), y = Y(cr.s)
        const bad = cr.status >= 2 && cr.status !== 6
        ctx.save(); ctx.translate(x, y); ctx.rotate((cr.heading * Math.PI) / 180)
        ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(6, 7); ctx.lineTo(0, 3.5); ctx.lineTo(-6, 7); ctx.closePath()
        ctx.fillStyle = bad ? MAP.hazard : '#ffffff'; ctx.strokeStyle = DARK; ctx.lineWidth = 2.2; ctx.stroke(); ctx.fill()
        ctx.restore()
        const name = cr.name ?? `EV${cr.id + 1}`
        const near = crewLabels.find((l) => Math.hypot(l.x - x, l.y - y) < 16)
        if (near) { near.names.push(name); near.bad ||= bad } else crewLabels.push({ x, y, names: [name], bad })
        hits.push({ x, y, r: 12, title: cr.name ?? `Crew ${cr.id}`, lines: [`Heading ${bearingText(cr.heading)}, pace ${cr.pace.toFixed(2)} m/s`, `Oxygen ${(cr.o2 * 100).toFixed(0)}%, heat margin ${((1 - cr.heat) * 100).toFixed(0)}%`] })
      }

      for (const l of crewLabels) halo(ctx, l.names.join(' · '), l.x, l.y - 17, l.bad ? MAP.hazard : INK, 'center')

      // free plan: where it starts, where it ends, and a request still on its way
      const mark = (e: number, s: number, label: string, kind: 'to' | 'from' | 'wait') => {
        const x = X(e), y = Y(s)
        ctx.lineWidth = 2; ctx.strokeStyle = DARK; ctx.fillStyle = MAP.select
        if (kind === 'from') { ctx.beginPath(); ctx.arc(x, y, 5.5, 0, 6.283); ctx.fillStyle = DARK; ctx.fill(); ctx.strokeStyle = MAP.select; ctx.stroke() }
        else {
          const r = kind === 'wait' ? 9 + 3 * Math.sin(now / 160) : 9
          ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.strokeStyle = 'rgba(6,8,10,.85)'; ctx.lineWidth = 4.5; ctx.stroke()
          ctx.strokeStyle = MAP.select; ctx.lineWidth = 2; ctx.stroke()
          ctx.beginPath(); ctx.moveTo(x - r - 5, y); ctx.lineTo(x - 3, y); ctx.moveTo(x + 3, y); ctx.lineTo(x + r + 5, y)
          ctx.moveTo(x, y - r - 5); ctx.lineTo(x, y - 3); ctx.moveTo(x, y + 3); ctx.lineTo(x, y + r + 5); ctx.stroke()
        }
        halo(ctx, label, x + 14, y - 12)
      }
      const plan = bundle?.plan
      if (plan?.to?.e !== undefined && plan.to.s !== undefined) mark(plan.to.e, plan.to.s, plan.to.label ? `Plan to ${plan.to.label}` : 'Plan destination', 'to')
      if (plan?.from && plan.from.label !== 'Crew position') mark(plan.from.e, plan.from.s, 'Plan start', 'from')
      if (st.planMode && st.planFrom && !(plan?.from && plan.from.label !== 'Crew position')) mark(st.planFrom.e, st.planFrom.s, 'Start', 'from')
      if (st.planPending) mark(st.planPending.e, st.planPending.s, 'Planning', 'wait')

      // scale bar
      let len = 20
      for (const n of [20, 50, 100, 200, 250, 500, 1000, 2000]) if (n * k <= 130) len = n
      const bx = Math.max(12, x0 + 12), by = Math.min(v.h - 14, y0 + sz - 12)
      const bar = () => { ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + len * k, by); ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by + 4); ctx.moveTo(bx + len * k, by - 4); ctx.lineTo(bx + len * k, by + 4); ctx.stroke() }
      ctx.strokeStyle = 'rgba(6,8,10,.9)'; ctx.lineWidth = 4.5; bar()
      ctx.strokeStyle = INK; ctx.lineWidth = 1.5; bar()
      halo(ctx, len >= 1000 ? `${len / 1000} km` : `${len} m`, bx, by - 11)

      // north arrow
      const nx = v.w - 28, ny = v.h - 34
      ctx.fillStyle = 'rgba(11,14,16,.8)'; ctx.beginPath(); ctx.arc(nx, ny, 17, 0, 6.283); ctx.fill()
      ctx.strokeStyle = 'rgba(231,234,238,.3)'; ctx.lineWidth = 1; ctx.stroke()
      ctx.beginPath(); ctx.moveTo(nx, ny - 12); ctx.lineTo(nx + 4.5, ny + 3); ctx.lineTo(nx, ny); ctx.lineTo(nx - 4.5, ny + 3); ctx.closePath(); ctx.fillStyle = INK; ctx.fill()
      ctx.font = `600 9.5px ${FACE}`; ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText('N', nx, ny + 4)

      if (overlayNote) halo(ctx, overlayNote, v.w / 2, v.h - 14, MAP.quiet, 'center')

      // hover readout
      const h = hoverRef.current
      let tipNow: { x: number; y: number; title: string; lines: string[] } | null = null
      if (h) {
        let best: Hit | null = null, bd = 1e9
        for (const t of hits) { const d = Math.hypot(t.x - h.x, t.y - h.y); if (d < t.r && d < bd) { best = t; bd = d } }
        if (best) tipNow = { x: best.x, y: best.y, title: best.title, lines: best.lines.filter(Boolean) }
        if (!dragging.current && !st.planMode) c.style.cursor = best?.place ? 'pointer' : ''
      }
      hitsRef.current = hits
      const key = tipNow ? `${tipNow.title}|${Math.round(tipNow.x)}|${Math.round(tipNow.y)}` : ''
      if (key !== lastTip) { lastTip = key; setTip(tipNow) }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [e0, s0, size])

  const mapBtn = 'flex h-10 w-10 items-center justify-center text-ink2 transition-colors duration-150 hover:bg-panel3 hover:text-ink'
  const hasRoutes = !!routesFileInc && routesFileInc === focusId
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div ref={wrap} className="relative min-h-0 flex-1 overflow-hidden">
        <canvas ref={cv} className={cn('absolute inset-0 touch-none', planMode ? 'cursor-crosshair' : 'cursor-grab')} aria-label="Map of the 4 by 4 km walk area" />
        {planMode && (
          <div role="status" className="anim-rise pointer-events-none absolute inset-x-3 bottom-3 flex justify-center">
            <div className="float pointer-events-auto flex max-w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-[8px] px-3.5 py-2 text-[13px] text-ink">
              <span><span className="font-semibold">Planning a walk.</span> Click the destination. Shift and click sets another start.</span>
              {planFrom && <button type="button" className="text-ink2 underline decoration-dotted underline-offset-2 hover:text-ink" onClick={() => store.set({ planFrom: null })}>Start from the crew</button>}
              <button type="button" className="text-ink2 underline decoration-dotted underline-offset-2 hover:text-ink" onClick={() => store.set({ planMode: false })}>Stop (Esc)</button>
            </div>
          </div>
        )}
        <div className="absolute left-3 top-3 flex items-start gap-2">
          <LayerMenu />
          {canPlan && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" aria-pressed={planMode} disabled={!online} onClick={() => store.set({ planMode: !planMode, selectedPlace: null })}
                  className={cn('flex h-10 items-center gap-2 rounded-[8px] px-3 text-[13.5px] shadow-float transition-colors duration-150 disabled:opacity-50', planMode ? 'bg-solid font-semibold text-on-solid' : 'bg-panel text-ink hover:bg-panel2')}>
                  <Route size={15} /><span className="hidden sm:inline">Plan a walk</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Ask the engine for a route to any point: turn this on, then click the map (P)</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={() => setView3d('3d')} data-testid="open-3d"
                className="flex h-10 items-center gap-2 rounded-[8px] bg-panel px-3 text-[13.5px] text-ink shadow-float transition-colors duration-150 hover:bg-panel2">
                <Box size={15} /><span className="hidden sm:inline">3D</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">The walk area and the route in 3D, on the HiRISE elevation model</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={() => setView3d('hud')} disabled={!hasRoutes} data-testid="open-hud"
                className="flex h-10 items-center gap-2 rounded-[8px] bg-panel px-3 text-[13.5px] text-ink shadow-float transition-colors duration-150 hover:bg-panel2 disabled:opacity-50">
                <Compass size={15} /><span className="hidden sm:inline">Helmet HUD</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Walk the route in a simulated helmet display, with turn-by-turn guidance and the rover camera</TooltipContent>
          </Tooltip>
        </div>
        {view3d && <Suspense fallback={null}><Views3D mode={view3d} onClose={() => setView3d(null)} /></Suspense>}
        <PlaceCard />
        <div className="float absolute right-3 top-3 flex flex-col overflow-hidden rounded-[8px]">
          <button type="button" className={mapBtn} aria-label="Zoom in" onClick={() => zoomAt(1.5)}><Plus size={16} /></button>
          <button type="button" className={mapBtn} aria-label="Zoom out" onClick={() => zoomAt(1 / 1.5)}><Minus size={16} /></button>
          <Tooltip>
            <TooltipTrigger asChild><button type="button" className={mapBtn} aria-label={hasRoutes ? 'Frame the routes' : 'Whole walk area'} onClick={hasRoutes ? fitRoutes : fitView}><Scan size={16} /></button></TooltipTrigger>
            <TooltipContent side="left">{hasRoutes ? 'Frame the routes and the crew' : 'Whole 4 by 4 km walk area'}</TooltipContent>
          </Tooltip>
        </div>
        {tip && (
          <div className="invert pointer-events-none absolute z-10 max-w-[260px] rounded-[6px] bg-panel3 px-2.5 py-1.5 text-[12.5px] shadow-float" style={{ left: Math.min(tip.x + 14, (wrap.current?.clientWidth ?? 400) - 270), top: Math.max(6, tip.y - 12) }}>
            <div className="font-semibold text-ink">{tip.title}</div>
            {tip.lines.map((l, i) => <div key={i} className="text-ink2">{l}</div>)}
          </div>
        )}
      </div>
      <div className="flex min-h-[52px] shrink-0 flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-rule bg-panel px-3 py-2">
        <Timeline />
        <div className="flex shrink-0 items-center gap-4 max-md:hidden">
          <LayerLegend />
          <div className={cn('w-[150px] text-right text-[12px] text-ink3 max-xl:hidden', coord && 'num')}>{coord ? `e ${Math.round(coord.e)}  s ${Math.round(coord.s)} m` : 'HiRISE, NASA/JPL/UArizona'}</div>
        </div>
      </div>
    </div>
  )
}

/** The place picked on the map or in the list: what it is, how far, and a route to it on request. */
function PlaceCard() {
  const place = useStore((s) => s.hello?.places?.find((p) => p.id === s.selectedPlace))
  const sh = useStore((s) => focusBundle(s)?.assessment?.shelters?.find((x) => x.id === s.selectedPlace))
  const lead = useStore((s) => s.snapshot?.crew[0])
  const live = useStore((s) => s.mode === 'live' || s.mode === 'replay')
  const online = useStore((s) => s.conn === 'online')
  const planMode = useStore((s) => s.planMode)
  if (!place || planMode) return null
  const line = lead ? lineTo(lead.e, lead.s, place.e, place.s) : null
  return (
    <div className="float anim-rise absolute left-3 top-[60px] w-[min(280px,calc(100%-24px))] overflow-hidden rounded-[10px]" role="region" aria-label={`Selected place: ${place.name}`}>
      <PlaceView key={place.id} placeId={place.id} name={place.name} imgClassName="aspect-[2/1]" className="[&>figcaption]:px-3" caption="Render from the HiRISE elevation model. Colour is approximate." />
      <div className="p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold text-ink">{place.name}</div>
          <div className="text-[12.5px] text-ink3">
            {KIND_NAME[place.kind] ?? place.kind}
            {sh && <span className={cn('font-semibold', sh.open ? 'text-safe' : 'text-hazard')}> · {sh.open ? 'Open' : 'Closed'}</span>}
          </div>
        </div>
        <button type="button" aria-label="Close" className="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] text-ink3 transition-colors duration-150 hover:bg-panel3 hover:text-ink" onClick={() => store.set({ selectedPlace: null })}><Close size={15} /></button>
      </div>
      {sh && !sh.open && sh.reason && <p className="mt-1.5 text-[12.5px] leading-snug text-ink2">{sh.reason}</p>}
      <dl className="mt-2.5 space-y-1 text-[13px]">
        {line && (
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink2">From {lead?.name ?? 'the crew'}</dt>
            <dd className="num font-semibold text-ink">{num(Math.round(line.dist_m / 10) * 10)} m · {bearingText(line.bearing)}</dd>
          </div>
        )}
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-ink2">Position</dt>
          <dd className="num text-ink">e {Math.round(place.e)} · s {Math.round(place.s)}{place.z !== undefined ? ` · z ${Math.round(place.z)}` : ''}</dd>
        </div>
      </dl>
      <p className="mt-1.5 text-[12px] leading-snug text-ink3">Straight line, not a route. Metres in the site frame.</p>
      {live
        ? <Button variant="default" size="md" className="mt-2.5 w-full" disabled={!online} onClick={() => { requestPlan({ e: place.e, s: place.s }); store.set({ selectedPlace: null }) }}><Route size={14} />Plan a walk here</Button>
        : <p className="mt-2 border-t border-rule pt-2 text-[12px] leading-snug text-ink3">A recorded run cannot plan new routes. That needs the engine.</p>}
      </div>
    </div>
  )
}
