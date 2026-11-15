import { useCallback, useEffect, useRef, useState } from 'react'
import { Maximize2, Minus, Mountain, Plus, Route, Users } from 'lucide-react'
import { CORE_DEFAULT, LAYER_LABEL, ORTHO_PATH, fileUrl, type Layer } from '@/lib/config'
import { focusBundle, focusIncidentId, store, useStore } from '@/lib/store'
import { ROUTE_STYLE, OUTCOME_FAIL, FAIL_LABEL } from '@/lib/routeStyle'
import type { RouteStatus } from '@/lib/types'
import { cn } from '@/lib/utils'
import { LayerLegend, LayerSwitch } from './console/Layers'
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
interface Hit { x: number; y: number; r: number; title: string; lines: string[] }
const INK = '#e7eaee'
const MONO = '11px "JetBrains Mono Variable", ui-monospace, monospace'

function halo(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color = INK, align: CanvasTextAlign = 'left') {
  ctx.font = MONO; ctx.textAlign = align; ctx.textBaseline = 'middle'
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,13,.85)'; ctx.lineJoin = 'round'
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
  const [tip, setTip] = useState<{ x: number; y: number; title: string; lines: string[] } | null>(null)
  const [coord, setCoord] = useState<{ e: number; s: number } | null>(null)
  const showReplays = useStore((s) => s.showReplays)
  const contours = useStore((s) => s.contours)
  const focusId = useStore(focusIncidentId)
  const routesFileInc = useStore((s) => s.routesFile?.incident_id)
  const phase = useStore((s) => s.snapshot?.phase ?? 'idle')
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
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = c.getBoundingClientRect()
      zoomAt(Math.exp(-e.deltaY * 0.0016), e.clientX - r.left, e.clientY - r.top)
    }
    const onDown = (e: PointerEvent) => { drag = { x: e.clientX, y: e.clientY }; c.setPointerCapture(e.pointerId); c.style.cursor = 'grabbing' }
    const onMove = (e: PointerEvent) => {
      const r = c.getBoundingClientRect()
      const x = e.clientX - r.left, y = e.clientY - r.top
      if (drag) { view.current.ox += e.clientX - drag.x; view.current.oy += e.clientY - drag.y; drag = { x: e.clientX, y: e.clientY } }
      hoverRef.current = { x, y }
      const v = view.current
      setCoord({ e: e0 + (x - v.ox) / v.k, s: s0 + (y - v.oy) / v.k })
    }
    const onUp = (e: PointerEvent) => { drag = null; c.style.cursor = 'grab'; try { c.releasePointerCapture(e.pointerId) } catch { /* not captured */ } }
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
      ctx.fillStyle = '#0a0c0f'; ctx.fillRect(0, 0, v.w, v.h)
      const k = v.k
      const X = (e: number) => v.ox + (e - e0) * k
      const Y = (s: number) => v.oy + (s - s0) * k
      const x0 = X(e0), y0 = Y(s0), sz = size * k

      // ortho and scrim
      const online = st.conn === 'online'
      const ortho = getImg(fileUrl(ORTHO_PATH), online)
      if (ortho?.ready) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(ortho.el, x0, y0, sz, sz) }
      else { ctx.fillStyle = '#14181d'; ctx.fillRect(x0, y0, sz, sz) }
      ctx.fillStyle = 'rgba(7,9,12,.5)'; ctx.fillRect(x0, y0, sz, sz)

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
      ctx.strokeStyle = 'rgba(231,234,238,.28)'; ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, sz, sz)
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
          const col = ROUTE_STYLE[statusOf.get(run.route) ?? 'candidate'].color
          const fail = OUTCOME_FAIL(run.outcome)
          const from = Math.max(0, i0 - 28)
          ctx.beginPath()
          for (let i = from; i <= i0; i++) { const p = run.samples[i]; if (i === from) ctx.moveTo(X(p[0]), Y(p[1])); else ctx.lineTo(X(p[0]), Y(p[1])) }
          const pa = run.samples[i0], pb = run.samples[i1]
          const px = X(pa[0] + (pb[0] - pa[0]) * f), py = Y(pa[1] + (pb[1] - pa[1]) * f)
          ctx.lineTo(px, py)
          ctx.strokeStyle = fail ? '#ff5f57' : col; ctx.globalAlpha = 0.35 * a; ctx.lineWidth = 1.2; ctx.setLineDash([]); ctx.stroke()
          ctx.globalAlpha = a
          if (idxF >= n - 1 && fail) {
            ctx.strokeStyle = '#ff5f57'; ctx.lineWidth = 2
            ctx.beginPath(); ctx.moveTo(px - 4, py - 4); ctx.lineTo(px + 4, py + 4); ctx.moveTo(px + 4, py - 4); ctx.lineTo(px - 4, py + 4); ctx.stroke()
          } else {
            ctx.fillStyle = col; ctx.strokeStyle = '#0a0c0f'; ctx.lineWidth = 1.5
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
          ctx.strokeStyle = back ? '#aab3bf' : sty.color; ctx.lineWidth = base + flash * 3; ctx.stroke()
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
          ctx.fillStyle = '#0a0c0f'; ctx.strokeStyle = back ? '#aab3bf' : sty.color; ctx.lineWidth = sel ? 2 : 1.4
          ctx.beginPath(); ctx.arc(tx, ty, sel ? 10 : 9, 0, 6.283); ctx.fill(); ctx.stroke()
          ctx.font = '600 11px "JetBrains Mono Variable", monospace'; ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
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
            ctx.fillStyle = '#ff5f57'; ctx.strokeStyle = '#0a0c0f'; ctx.lineWidth = 1.5
            ctx.beginPath(); ctx.moveTo(x, y - rr); ctx.lineTo(x + rr, y); ctx.lineTo(x, y + rr); ctx.lineTo(x - rr, y); ctx.closePath(); ctx.stroke(); ctx.fill()
            if (isSel) { ctx.font = '600 9px "JetBrains Mono Variable", monospace'; ctx.fillStyle = '#1a0807'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(i + 1), x, y + 0.5) }
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
        if (p.kind === 'shelter') col = sh ? (sh.open ? '#4fd1b0' : '#ff5f57') : '#a3acb8'
        if (p.kind === 'site') col = '#7fa9cf'
        ctx.lineWidth = 1.6; ctx.strokeStyle = '#0a0c0f'; ctx.fillStyle = col
        ctx.beginPath()
        if (p.kind === 'habitat') ctx.rect(x - 6, y - 6, 12, 12)
        else if (p.kind === 'rover') ctx.roundRect(x - 7, y - 4, 14, 8, 2)
        else if (p.kind === 'shelter') { ctx.moveTo(x - 7, y + 5); ctx.lineTo(x - 7, y - 1); ctx.arc(x, y - 1, 7, Math.PI, 0); ctx.lineTo(x + 7, y + 5); ctx.closePath() }
        else { ctx.moveTo(x, y - 8); ctx.lineTo(x + 8, y); ctx.lineTo(x, y + 8); ctx.lineTo(x - 8, y); ctx.closePath() }
        ctx.stroke(); ctx.fill()
        if (p.kind === 'shelter' && sh && !sh.open) {
          ctx.strokeStyle = '#0a0c0f'; ctx.lineWidth = 1.8; ctx.beginPath()
          ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4); ctx.stroke()
        }
        halo(ctx, p.name, x + 11, y)
        hits.push({ x, y, r: 12, title: p.name, lines: [p.kind + (sh ? (sh.open ? ', open' : ', closed') : ''), sh?.reason ?? '', `e ${p.e}  s ${p.s}  z ${p.z ?? '-'}`] })
      }

      // crew: members standing together share one label
      const crewLabels: { x: number; y: number; names: string[]; bad: boolean }[] = []
      for (const cr of live?.crew ?? []) {
        const tr = st.trails[cr.id]
        if (tr && tr.length > 1) {
          ctx.beginPath(); tr.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))))
          ctx.strokeStyle = 'rgba(227,180,114,.5)'; ctx.lineWidth = 1.4; ctx.setLineDash([]); ctx.stroke()
        }
        const x = X(cr.e), y = Y(cr.s)
        const bad = cr.status >= 2 && cr.status !== 6
        ctx.save(); ctx.translate(x, y); ctx.rotate((cr.heading * Math.PI) / 180)
        ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(6, 7); ctx.lineTo(0, 3.5); ctx.lineTo(-6, 7); ctx.closePath()
        ctx.fillStyle = bad ? '#ff5f57' : '#e3b472'; ctx.strokeStyle = '#0a0c0f'; ctx.lineWidth = 1.8; ctx.stroke(); ctx.fill()
        ctx.restore()
        const name = cr.name ?? `EV${cr.id + 1}`
        const near = crewLabels.find((l) => Math.hypot(l.x - x, l.y - y) < 16)
        if (near) { near.names.push(name); near.bad ||= bad } else crewLabels.push({ x, y, names: [name], bad })
        hits.push({ x, y, r: 12, title: cr.name ?? `Crew ${cr.id}`, lines: [`heading ${Math.round(cr.heading)} deg, pace ${cr.pace.toFixed(2)} m/s`, `O2 ${(cr.o2 * 100).toFixed(0)}%  heat stored ${(cr.heat * 100).toFixed(0)}%`] })
      }

      for (const l of crewLabels) halo(ctx, l.names.join(' · '), l.x, l.y - 17, l.bad ? '#ff5f57' : '#e3b472', 'center')

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
      ctx.fillStyle = 'rgba(10,12,15,.75)'; ctx.beginPath(); ctx.arc(nx, ny, 17, 0, 6.283); ctx.fill()
      ctx.strokeStyle = 'rgba(231,234,238,.3)'; ctx.lineWidth = 1; ctx.stroke()
      ctx.beginPath(); ctx.moveTo(nx, ny - 12); ctx.lineTo(nx + 4.5, ny + 3); ctx.lineTo(nx, ny); ctx.lineTo(nx - 4.5, ny + 3); ctx.closePath(); ctx.fillStyle = INK; ctx.fill()
      ctx.font = '600 9px "JetBrains Mono Variable", monospace'; ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText('N', nx, ny + 4)

      if (overlayNote) halo(ctx, overlayNote, v.w / 2, v.h - 14, '#a3acb8', 'center')

      // hover readout
      const h = hoverRef.current
      let tipNow: { x: number; y: number; title: string; lines: string[] } | null = null
      if (h) {
        let best: Hit | null = null, bd = 1e9
        for (const t of hits) { const d = Math.hypot(t.x - h.x, t.y - h.y); if (d < t.r && d < bd) { best = t; bd = d } }
        if (best) tipNow = { x: best.x, y: best.y, title: best.title, lines: best.lines.filter(Boolean) }
      }
      const key = tipNow ? `${tipNow.title}|${Math.round(tipNow.x)}|${Math.round(tipNow.y)}` : ''
      if (key !== lastTip) { lastTip = key; setTip(tipNow) }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [e0, s0, size])

  const mapBtn = 'flex h-9 w-9 items-center justify-center rounded-[4px] text-ink2 hover:bg-panel3 hover:text-ink'
  const hasRoutes = !!routesFileInc && routesFileInc === focusId
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div ref={wrap} className="relative min-h-0 flex-1 overflow-hidden">
        <canvas ref={cv} className="absolute inset-0 cursor-grab touch-none" aria-label="Map of the 4 by 4 km walk area" />
        <div className="absolute left-3 right-[60px] top-3 flex"><LayerSwitch /></div>
        <div className="absolute right-3 top-3 flex flex-col rounded-[6px] border border-rule2 bg-bg/85 p-0.5 backdrop-blur-sm">
          <Tooltip><TooltipTrigger asChild><button type="button" className={mapBtn} aria-label="Zoom in" onClick={() => zoomAt(1.5)}><Plus size={16} /></button></TooltipTrigger><TooltipContent side="left">Zoom in</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger asChild><button type="button" className={mapBtn} aria-label="Zoom out" onClick={() => zoomAt(1 / 1.5)}><Minus size={16} /></button></TooltipTrigger><TooltipContent side="left">Zoom out</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger asChild><button type="button" className={mapBtn} aria-label="Frame the routes" onClick={fitRoutes}><Route size={16} /></button></TooltipTrigger><TooltipContent side="left">Frame the routes and the crew</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger asChild><button type="button" className={mapBtn} aria-label="Whole walk area" onClick={fitView}><Maximize2 size={15} /></button></TooltipTrigger><TooltipContent side="left">Whole 4 by 4 km walk area</TooltipContent></Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={() => store.set((s) => ({ contours: !s.contours }))} aria-pressed={contours} aria-label="Elevation contours" className={cn(mapBtn, contours && 'text-accent')}><Mountain size={16} /></button>
            </TooltipTrigger>
            <TooltipContent side="left">Elevation contours every 20 m, heavier every 100 m, from the HiRISE elevation model</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={() => store.set((s) => ({ showReplays: !s.showReplays }))} aria-pressed={showReplays} aria-label="Virtual crews" className={cn(mapBtn, showReplays && 'text-accent')}><Users size={16} /></button>
            </TooltipTrigger>
            <TooltipContent side="left">Virtual crews from the stress test, replayed on the map. {phase === 'simulate' ? 'Playing now.' : 'Shown faintly outside the Simulate step.'}</TooltipContent>
          </Tooltip>
        </div>
        {tip && (
          <div className="pointer-events-none absolute z-10 max-w-[260px] rounded-[4px] border border-rule2 bg-panel3 px-2.5 py-1.5 text-[12.5px] shadow-lg" style={{ left: Math.min(tip.x + 14, (wrap.current?.clientWidth ?? 400) - 270), top: Math.max(6, tip.y - 12) }}>
            <div className="font-medium text-ink">{tip.title}</div>
            {tip.lines.map((l, i) => <div key={i} className="text-ink2">{l}</div>)}
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-5 gap-y-1 border-t border-rule px-3 py-2">
        <Legend hasRoutes={hasRoutes} decided={chosenRoute !== undefined} />
        <LayerLegend />
        <div className="num hidden text-[11.5px] text-ink3 md:block">{coord ? `e ${Math.round(coord.e)}  s ${Math.round(coord.s)} m` : 'HiRISE 1 m, NASA/JPL/University of Arizona'}</div>
      </div>
    </div>
  )
}

function Legend({ hasRoutes, decided }: { hasRoutes: boolean; decided: boolean }) {
  const items: RouteStatus[] = !hasRoutes ? [] : decided ? ['chosen'] : ['testing', 'tested']
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[12px] text-ink2">
      <div className="flex items-center gap-1.5"><svg width="12" height="14" aria-hidden><path d="M6 1 11 13 6 10 1 13Z" fill="#e3b472" /></svg>Crew</div>
      {items.map((s) => (
        <div key={s} className="flex items-center gap-1.5">
          <svg width="18" height="6" aria-hidden><line x1="0" y1="3" x2="18" y2="3" stroke={ROUTE_STYLE[s].color} strokeWidth="2.4" strokeDasharray={s === 'testing' ? '5 3' : s === 'rejected' ? '2 3' : undefined} /></svg>
          {ROUTE_STYLE[s].label}
        </div>
      ))}
      {hasRoutes && decided && <div className="flex items-center gap-1.5"><svg width="18" height="6" aria-hidden><line x1="0" y1="3" x2="18" y2="3" stroke="#aab3bf" strokeWidth="1.8" strokeDasharray="2 3" opacity=".7" /></svg>Not chosen</div>}
      {hasRoutes && <div className="flex items-center gap-1.5"><svg width="10" height="10" aria-hidden><path d="M5 0.5 9.5 5 5 9.5 0.5 5Z" fill="#ff5f57" /></svg>Likely failure</div>}
    </div>
  )
}
