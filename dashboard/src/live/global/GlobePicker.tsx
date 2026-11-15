// 2D global map of Mars for picking a place to load. Tiles: NASA Mars Trek WMTS, Viking MDIM 2.1 colour
// mosaic (232 m), equirectangular, 2x1 tiles at level 0, levels 0-7. Drag to pan, wheel / pinch / buttons
// to zoom, click or tap to pick. Longitudes are reported in planetocentric deg E (0..360).
import { useCallback, useEffect, useRef, useState } from 'react'
import { READY_SITES } from './sites'

const TILE = 'https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm'
const MAX_Z = 7
const TS = 256

// Every HiRISE and CTX elevation model in the USGS Astrogeology STAC catalogue (public/stac, built from the
// collections mro_hirise_socet_dtms and mro_ctx_controlled_usgs_dtms): [lon E 0..360, lat, width deg, height deg] x n
interface Footprints { hirise: Float32Array; ctx: Float32Array }
let footP: Promise<Footprints> | null = null
function loadFootprints(): Promise<Footprints> {
  const get = (f: string) => fetch(import.meta.env.BASE_URL + 'stac/' + f).then(r => (r.ok ? r.json() : { items: [] })).catch(() => ({ items: [] }))
    .then((j: { items: [string, number, number, number, number][] }) => { const a = new Float32Array(j.items.length * 4); j.items.forEach((it, i) => a.set([it[1], it[2], it[3], it[4]], i * 4)); return a })
  footP ??= Promise.all([get('hirise_dtms.json'), get('ctx_dtms.json')]).then(([hirise, ctx]) => ({ hirise, ctx }))
  return footP
}

interface View { lon: number; lat: number; ppd: number }        // centre (deg, lon -180..180) and pixels per degree

export default function GlobePicker(props: {
  onPick: (lon: number, lat: number) => void
  bundled: { name: string; lon: number; lat: number }[]
  busy?: boolean
  marker?: { lon: number; lat: number } | null
}) {
  const { onPick, bundled, busy, marker } = props
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const view = useRef<View>({ lon: 0, lat: 0, ppd: 2 })
  const size = useRef({ w: 0, h: 0 })
  const tiles = useRef(new Map<string, HTMLImageElement | 'err'>())
  const raf = useRef(0)
  const [hover, setHover] = useState<{ lon: number; lat: number } | null>(null)
  const [, force] = useState(0)
  const footRef = useRef<Footprints | null>(null)
  const [counts, setCounts] = useState<{ h: number; c: number } | null>(null)
  const overlay = useRef({ bundled, marker })
  overlay.current = { bundled, marker }

  const clampView = () => {
    const v = view.current, { w, h } = size.current
    v.ppd = Math.min(Math.max(v.ppd, Math.max(w / 360, h / 180)), TS * 2 ** MAX_Z / 180 * 3)
    const halfLat = h / 2 / v.ppd
    v.lat = Math.min(Math.max(v.lat, -90 + halfLat), 90 - halfLat)
    v.lon = ((v.lon + 540) % 360) - 180
  }

  const toScreen = (lon: number, lat: number): [number, number] => {
    const v = view.current, { w, h } = size.current
    let dl = ((lon - v.lon + 540) % 360) - 180
    if (dl < -180) dl += 360
    return [w / 2 + dl * v.ppd, h / 2 - (lat - v.lat) * v.ppd]
  }
  const toLonLat = (x: number, y: number): [number, number] => {
    const v = view.current, { w, h } = size.current
    const lon = v.lon + (x - w / 2) / v.ppd, lat = v.lat - (y - h / 2) / v.ppd
    return [((lon % 360) + 360) % 360, Math.max(-90, Math.min(90, lat))]
  }

  const draw = useCallback(() => {
    raf.current = 0
    const cv = canvasRef.current
    if (!cv) return
    const { w, h } = size.current
    const dpr = window.devicePixelRatio || 1
    const ctx = cv.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#0c0b0a'
    ctx.fillRect(0, 0, w, h)
    const v = view.current
    const want = Math.min(MAX_Z, Math.max(0, Math.ceil(Math.log2(v.ppd * dpr * 180 / TS))))
    const levels = want > 0 ? [0, want] : [0]
    for (const z of levels) {
      const deg = 180 / 2 ** z, ncol = 2 * 2 ** z, nrow = 2 ** z
      const lonL = v.lon - w / 2 / v.ppd, lonR = v.lon + w / 2 / v.ppd
      const latT = v.lat + h / 2 / v.ppd, latB = v.lat - h / 2 / v.ppd
      const c0 = Math.floor((lonL + 180) / deg), c1 = Math.floor((lonR + 180) / deg)
      const r0 = Math.max(0, Math.floor((90 - latT) / deg)), r1 = Math.min(nrow - 1, Math.floor((90 - latB) / deg))
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const cc = ((c % ncol) + ncol) % ncol
        const key = `${z}/${r}/${cc}`
        let im = tiles.current.get(key)
        if (!im) {
          const img = new Image()
          img.decoding = 'async'
          img.onload = () => { if (!raf.current) raf.current = requestAnimationFrame(draw) }
          img.onerror = () => tiles.current.set(key, 'err')
          img.src = `${TILE}/${z}/${r}/${cc}.jpg`
          tiles.current.set(key, img)
          im = img
        }
        if (im === 'err' || !im.complete || !im.naturalWidth) continue
        const x = w / 2 + (-180 + c * deg - v.lon) * v.ppd, y = h / 2 - (90 - r * deg - v.lat) * v.ppd
        const s = deg * v.ppd
        ctx.drawImage(im, Math.floor(x), Math.floor(y), Math.ceil(s) + 1, Math.ceil(s) + 1)
      }
    }
    // graticule every 30 deg
    ctx.strokeStyle = 'rgba(239,235,228,0.10)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let lon = -180; lon < 180; lon += 30) { const [x] = toScreen(lon, 0); ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, h) }
    for (let lat = -60; lat <= 60; lat += 30) { const [, y] = toScreen(0, lat); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5) }
    ctx.stroke()
    // DTM coverage from the STAC catalogue: CTX (route-planning grade) and HiRISE (EVA-grade)
    const fp = footRef.current
    if (fp) {
      const layer = (a: Float32Array, fill: string, stroke: string, minPx: number) => {
        ctx.fillStyle = fill; ctx.strokeStyle = stroke; ctx.lineWidth = 1
        for (let i = 0; i < a.length; i += 4) {
          let lon = a[i]; if (lon > 180) lon -= 360
          const [x, y] = toScreen(lon, a[i + 1])
          if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue
          const pw = Math.max(minPx, a[i + 2] * v.ppd), ph = Math.max(minPx, a[i + 3] * v.ppd)
          ctx.fillRect(x - pw / 2, y - ph / 2, pw, ph)
          if (pw > 6) ctx.strokeRect(x - pw / 2, y - ph / 2, pw, ph)
        }
      }
      layer(fp.ctx, 'rgba(255,154,46,0.22)', 'rgba(255,154,46,0.6)', 1.5)
      layer(fp.hirise, 'rgba(79,209,176,0.85)', 'rgba(79,209,176,1)', 3)
    }
    // suggested sites (small rings) and bundled sites (filled)
    const { bundled, marker } = overlay.current
    ctx.font = '600 11px "Instrument Sans Variable", system-ui, sans-serif'
    for (const s of READY_SITES) {
      const [x, y] = toScreen(s.lon, s.lat)
      ctx.strokeStyle = '#7cc4ff'; ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.stroke()
    }
    for (const s of bundled) {
      const [x, y] = toScreen(s.lon, s.lat)
      ctx.fillStyle = '#e3b472'; ctx.strokeStyle = '#1c1407'; ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
      ctx.fillStyle = 'rgba(12,11,10,0.75)'
      const tw = ctx.measureText(s.name).width
      ctx.fillRect(x + 8, y - 8, tw + 8, 16)
      ctx.fillStyle = '#efebe4'; ctx.fillText(s.name, x + 12, y + 4)
    }
    if (marker) {
      const [x, y] = toScreen(marker.lon, marker.lat)
      ctx.strokeStyle = '#e3b472'; ctx.lineWidth = 2
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2)
      ctx.moveTo(x - 15, y); ctx.lineTo(x - 5, y); ctx.moveTo(x + 5, y); ctx.lineTo(x + 15, y)
      ctx.moveTo(x, y - 15); ctx.lineTo(x, y - 5); ctx.moveTo(x, y + 5); ctx.lineTo(x, y + 15)
      ctx.stroke()
    }
  }, [])

  const redraw = useCallback(() => { if (!raf.current) raf.current = requestAnimationFrame(draw) }, [draw])

  // size to container
  useEffect(() => {
    const el = wrapRef.current, cv = canvasRef.current
    if (!el || !cv) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const first = size.current.w === 0
      size.current = { w: r.width, h: r.height }
      cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr)
      if (first) view.current.ppd = Math.max(r.width / 360, r.height / 180)
      clampView()
      draw()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [draw])
  useEffect(() => { redraw() }, [redraw, bundled, marker])
  useEffect(() => { void loadFootprints().then(f => { footRef.current = f; setCounts({ h: f.hirise.length / 4, c: f.ctx.length / 4 }); redraw() }) }, [redraw])
  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  const zoomAt = (x: number, y: number, k: number) => {
    const v = view.current, { w, h } = size.current
    const lon = v.lon + (x - w / 2) / v.ppd, lat = v.lat - (y - h / 2) / v.ppd
    v.ppd *= k
    clampView()
    v.lon = lon - (x - w / 2) / v.ppd; v.lat = lat + (y - h / 2) / v.ppd
    clampView(); redraw(); force(n => n + 1)
  }

  // pointer handling: drag = pan, two pointers = pinch zoom, short tap = pick
  const ptrs = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef({ moved: 0, pinch: 0 })
  const local = (e: React.PointerEvent | React.WheelEvent) => {
    const r = canvasRef.current!.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top] as const
  }
  const onDown = (e: React.PointerEvent) => {
    canvasRef.current!.setPointerCapture(e.pointerId)
    const [x, y] = local(e)
    ptrs.current.set(e.pointerId, { x, y })
    if (ptrs.current.size === 1) gesture.current = { moved: 0, pinch: 0 }
    if (ptrs.current.size === 2) {
      const [a, b] = [...ptrs.current.values()]
      gesture.current.pinch = Math.hypot(a.x - b.x, a.y - b.y)
    }
  }
  const onMove = (e: React.PointerEvent) => {
    const [x, y] = local(e)
    const p = ptrs.current.get(e.pointerId)
    if (!p) { setHover(toLonLatObj(x, y)); return }
    if (ptrs.current.size === 2) {
      p.x = x; p.y = y
      const [a, b] = [...ptrs.current.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      if (gesture.current.pinch > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / gesture.current.pinch)
      gesture.current.pinch = d; gesture.current.moved += 10
      return
    }
    const dx = x - p.x, dy = y - p.y
    p.x = x; p.y = y
    gesture.current.moved += Math.abs(dx) + Math.abs(dy)
    const v = view.current
    v.lon -= dx / v.ppd; v.lat += dy / v.ppd
    clampView(); redraw()
  }
  const onUp = (e: React.PointerEvent) => {
    const had = ptrs.current.delete(e.pointerId)
    if (!had || ptrs.current.size > 0) return
    if (gesture.current.moved < 6 && !busy) {
      const [x, y] = local(e)
      let [lon, lat] = toLonLat(x, y)
      // a click on (or within 7 px of) a HiRISE footprint loads that elevation model: snap to its centre
      const fp = footRef.current
      if (fp) {
        let best = -1, bd = 7
        for (let i = 0; i < fp.hirise.length; i += 4) {
          let l = fp.hirise[i]; if (l > 180) l -= 360
          const [sx, sy] = toScreen(l, fp.hirise[i + 1])
          const d = Math.hypot(sx - x, sy - y)
          if (d < bd) { bd = d; best = i }
        }
        if (best >= 0 && !(Math.abs(lat - fp.hirise[best + 1]) < fp.hirise[best + 3] / 2)) { lon = fp.hirise[best]; lat = fp.hirise[best + 1] }
      }
      onPick(lon, lat)
    }
  }
  const toLonLatObj = (x: number, y: number) => { const [lon, lat] = toLonLat(x, y); return { lon, lat } }

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = cv.getBoundingClientRect()
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015))
    }
    cv.addEventListener('wheel', wheel, { passive: false })
    return () => cv.removeEventListener('wheel', wheel)
  })

  const goTo = (lon: number, lat: number) => {
    const v = view.current
    v.lon = lon > 180 ? lon - 360 : lon; v.lat = lat
    v.ppd = Math.max(v.ppd, 40)
    clampView(); redraw(); force(n => n + 1)
    onPick(((lon % 360) + 360) % 360, lat)
  }

  const fmt = (p: { lon: number; lat: number }) => `${p.lon.toFixed(2)}°E  ${Math.abs(p.lat).toFixed(2)}°${p.lat >= 0 ? 'N' : 'S'}`

  return (
    <div className="flex h-full flex-col gap-2 p-2 text-ink">
      <div ref={wrapRef} className="relative min-h-[220px] w-full flex-1 overflow-hidden rounded-[4px] border border-rule bg-bg">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full touch-none select-none"
          style={{ cursor: busy ? 'progress' : 'crosshair' }}
          aria-label="Map of Mars: click a place to load its terrain"
          role="img"
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          onPointerLeave={() => setHover(null)}
        />
        <div className="absolute right-2 top-2 flex flex-col overflow-hidden rounded-[3px] border border-rule2 bg-panel/90">
          <button type="button" aria-label="Zoom in" className="h-8 w-8 text-[16px] leading-none text-ink hover:bg-panel3"
            onClick={() => zoomAt(size.current.w / 2, size.current.h / 2, 2)}>+</button>
          <button type="button" aria-label="Zoom out" className="h-8 w-8 border-t border-rule2 text-[16px] leading-none text-ink hover:bg-panel3"
            onClick={() => zoomAt(size.current.w / 2, size.current.h / 2, 0.5)}>−</button>
        </div>
        <div className="num pointer-events-none absolute bottom-1 left-2 text-[11px] text-ink2" style={{ textShadow: '0 1px 2px #000' }}>
          {hover ? fmt(hover) : 'Click anywhere to load its terrain'}
        </div>
        <div className="pointer-events-none absolute bottom-1 right-2 text-[10px] text-ink3" style={{ textShadow: '0 1px 2px #000' }}>
          Viking MDIM 2.1 · NASA/JPL/USGS · Mars Trek
        </div>
        {counts && (
          <div className="pointer-events-none absolute left-2 top-2 flex flex-col gap-1 rounded-[4px] bg-black/70 px-2.5 py-1.5 text-[11.5px] text-ink2">
            <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 bg-safe" /><span className="num text-ink">{counts.h.toLocaleString('en-US')}</span> HiRISE elevation models · EVA-grade</span>
            <span className="flex items-center gap-1.5"><i className="inline-block h-2.5 w-2.5 border border-caution/70 bg-caution/25" /><span className="num text-ink">{counts.c.toLocaleString('en-US')}</span> CTX elevation models · route-planning grade</span>
            <span className="text-ink3">Elsewhere: global 200 m model · not suitable for a walk</span>
            <span className="text-ink3">Source: USGS Astrogeology STAC (NASA data)</span>
          </div>
        )}
        {busy && (
          <div className="absolute inset-0 flex items-center justify-center bg-bg/40">
            <span className="rounded-[3px] bg-panel px-3 py-1 text-[12px] text-ink2">Loading terrain…</span>
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {READY_SITES.map(s => (
          <button key={s.id} type="button" disabled={busy} title={s.note}
            className="rounded-[3px] border border-rule2 bg-panel2 px-2 py-1 text-[12px] text-ink2 hover:border-accent hover:text-ink disabled:opacity-50"
            onClick={() => goTo(s.lon, s.lat)}>
            {s.name}
          </button>
        ))}
      </div>
    </div>
  )
}
