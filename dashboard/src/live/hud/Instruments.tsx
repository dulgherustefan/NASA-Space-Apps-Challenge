// Screen-space instruments of the helmet display: manoeuvre arrow, compass tape, suit bars, hazard icons, mini-map.
import { useEffect, useRef } from 'react'
import type { LiveRoute, Shelter } from '../types'
import type { TerrainKit } from '../scene/geometry'
import { COL } from '../scene/palette'
import type { HazardKind } from './guidance'

export type Level = 'ok' | 'caution' | 'warning' | 'info'
export const LEVEL_COLOR: Record<Level, string> = { ok: COL.route, caution: COL.caution, warning: COL.warning, info: COL.info }

/** Shape cue that goes with every colour (colour is never the only cue). */
export function LevelShape({ level, size = 10 }: { level: Level; size?: number }) {
  const c = LEVEL_COLOR[level]
  const s = size
  if (level === 'warning') return <svg width={s} height={s} viewBox="0 0 10 10" aria-hidden><path d="M5 0.5 L9.6 9.3 H0.4 Z" fill={c} /></svg>
  if (level === 'caution') return <svg width={s} height={s} viewBox="0 0 10 10" aria-hidden><path d="M5 0.3 L9.7 5 L5 9.7 L0.3 5 Z" fill={c} /></svg>
  if (level === 'info') return <svg width={s} height={s} viewBox="0 0 10 10" aria-hidden><rect x="1" y="1" width="8" height="8" rx="1" fill="none" stroke={c} strokeWidth="1.8" /></svg>
  return <svg width={s} height={s} viewBox="0 0 10 10" aria-hidden><circle cx="5" cy="5" r="4.2" fill={c} /></svg>
}

/** Manoeuvre arrow: a stem that bends by the turn angle; a flag for arrival. */
export function TurnArrow({ angleDeg, arrive, size = 56 }: { angleDeg: number; arrive?: boolean; size?: number }) {
  if (arrive) {
    return (
      <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
        <path d="M14 42 V8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
        <path d="M14 8 H36 L31 15 L36 22 H14" fill="currentColor" />
      </svg>
    )
  }
  const a = Math.max(-150, Math.min(150, angleDeg)) * Math.PI / 180
  const bx = 24, by = 24, L = 16
  const tx = bx + Math.sin(a) * L, ty = by - Math.cos(a) * L
  const hx = Math.sin(a), hy = -Math.cos(a)
  const px = -hy, py = hx
  const head = `M${tx + hx * 6} ${ty + hy * 6} L${tx + px * 7} ${ty + py * 7} L${tx - px * 7} ${ty - py * 7} Z`
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      <path d={`M24 44 L${bx} ${by} L${tx} ${ty}`} stroke="currentColor" strokeWidth="5" fill="none" strokeLinejoin="round" strokeLinecap="round" />
      <path d={head} fill="currentColor" />
    </svg>
  )
}

export function HazardIcon({ kind, size = 16 }: { kind: HazardKind; size?: number }) {
  const s = size
  switch (kind) {
    case 'band': return (
      <svg width={s} height={s} viewBox="0 0 16 16" aria-hidden><path d="M8 1 L15.3 14.5 H0.7 Z" fill={COL.warning} /><path d="M8 5.5 V10" stroke="#1f0705" strokeWidth="1.8" strokeLinecap="round" /><circle cx="8" cy="12.3" r="1" fill="#1f0705" /></svg>)
    case 'steep': return (
      <svg width={s} height={s} viewBox="0 0 16 16" aria-hidden><path d="M8 0.6 L15.4 8 L8 15.4 L0.6 8 Z" fill={COL.caution} /><path d="M4 11 L12 5 V11 Z" fill="#1f1205" /></svg>)
    case 'sand': return (
      <svg width={s} height={s} viewBox="0 0 16 16" aria-hidden><path d="M8 0.6 L15.4 8 L8 15.4 L0.6 8 Z" fill={COL.caution} /><circle cx="6" cy="7" r="1.1" fill="#1f1205" /><circle cx="10" cy="7" r="1.1" fill="#1f1205" /><circle cx="8" cy="10" r="1.1" fill="#1f1205" /></svg>)
    default: return (
      <svg width={s} height={s} viewBox="0 0 16 16" aria-hidden><rect x="1" y="1" width="14" height="14" rx="2" fill="none" stroke={COL.info} strokeWidth="1.6" /><path d="M8 12 V6 M5 5 Q8 2 11 5" stroke={COL.info} strokeWidth="1.5" fill="none" strokeLinecap="round" /><path d="M3 13 L13 3" stroke={COL.info} strokeWidth="1.6" /></svg>)
  }
}

/** Heading tape: ticks every 5°, labels every 30°, markers for the shelter and the next turn. */
export function CompassTape({ heading, marks, width }: { heading: number; marks: { deg: number; label: string; color: string; shape: 'dia' | 'tri' }[]; width: number }) {
  const span = width < 300 ? 90 : 120
  const pxPerDeg = width / span
  const ticks: React.ReactNode[] = []
  const start = Math.floor((heading - span / 2) / 5) * 5
  const names: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }
  for (let dg = start; dg <= heading + span / 2; dg += 5) {
    const x = width / 2 + (dg - heading) * pxPerDeg
    const n = ((dg % 360) + 360) % 360
    const major = n % 30 === 0
    ticks.push(<line key={dg} x1={x} x2={x} y1={major ? 18 : 22} y2={28} stroke="currentColor" strokeWidth={major ? 1.6 : 1} opacity={major ? 0.95 : 0.55} />)
    if (major) ticks.push(<text key={'t' + dg} x={x} y={13} textAnchor="middle" fontSize={names[n] ? 12.5 : 10.5} fontWeight={names[n] ? 700 : 500} fill="currentColor">{names[n] ?? n}</text>)
  }
  return (
    <svg className="hv-tape" width={width} height={44} viewBox={`0 0 ${width} 44`} role="img" aria-label={`Heading ${Math.round(heading)} degrees`}>
      {ticks}
      {marks.map(m => {
        let dd = ((m.deg - heading + 540) % 360) - 180
        const off = Math.abs(dd) > span / 2 - 4
        dd = Math.max(-span / 2 + 4, Math.min(span / 2 - 4, dd))
        const x = width / 2 + dd * pxPerDeg
        return (
          <g key={m.label} transform={`translate(${x} 36)`}>
            {m.shape === 'dia' ? <path d="M0 -6 L6 0 L0 6 L-6 0 Z" fill={m.color} /> : <path d="M-6 -4 L6 -4 L0 6 Z" fill={m.color} />}
            {off && <text x={dd < 0 ? 9 : -9} y={4} fontSize={10} textAnchor={dd < 0 ? 'start' : 'end'} fill={m.color}>{dd < 0 ? '◂' : '▸'}</text>}
          </g>
        )
      })}
      <path d={`M${width / 2 - 6} 44 L${width / 2} 37 L${width / 2 + 6} 44 Z`} fill="currentColor" />
      <rect x={width / 2 - 20} y={0} width={40} height={0} />
    </svg>
  )
}

export function SuitBar({ label, value, unit, frac, level, word }: { label: string; value: string; unit: string; frac: number; level: Level; word: string }) {
  const c = LEVEL_COLOR[level]
  return (
    <div className="hv-bar">
      <div className="hv-bar-top">
        <span className="hv-bar-l">{label}</span>
        <span className="hv-bar-v num">{value}<small> {unit}</small></span>
        <span className="hv-bar-w" style={{ color: c }}><LevelShape level={level} size={9} />{word}</span>
      </div>
      <div className="hv-bar-track"><div style={{ width: `${Math.max(2, Math.min(100, frac * 100))}%`, background: c }} /></div>
    </div>
  )
}

/** North-up mini-map around the walker: orbital image (or hillshade), route, shelters, position dot + heading beam. */
export function MiniMap({ kit, route, shelters, x, y, yaw, d, size }: {
  kit: TerrainKit; route: LiveRoute; shelters: Shelter[]; x: number; y: number; yaw: number; d: number; size: number
}) {
  const cv = useRef<HTMLCanvasElement>(null)
  const img = useRef<HTMLImageElement | HTMLCanvasElement | null>(null)
  useEffect(() => {
    if (!kit.orthoImageUrl) { img.current = kit.hillshade; return }
    const im = new Image()
    im.onload = () => { img.current = im }
    im.onerror = () => { img.current = kit.hillshade }
    im.src = kit.orthoImageUrl
    img.current = kit.hillshade
  }, [kit])
  useEffect(() => {
    const c = cv.current
    if (!c) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (c.width !== size * dpr) { c.width = size * dpr; c.height = size * dpr }
    const g = c.getContext('2d')
    if (!g) return
    const win = 640                          // metres across
    const k = size * dpr / win               // px per metre
    const ox = x - win / 2, oy = y - win / 2
    g.fillStyle = '#1b1917'; g.fillRect(0, 0, c.width, c.height)
    const im = img.current
    if (im) {
      const ppm = im.width / kit.size
      try { g.drawImage(im, ox * ppm, oy * ppm, win * ppm, win * ppm, 0, 0, c.width, c.height) } catch { /* not ready */ }
    }
    g.fillStyle = 'rgba(12,11,10,0.25)'; g.fillRect(0, 0, c.width, c.height)
    const P = (px: number, py: number) => [(px - ox) * k, (py - oy) * k] as const
    const s = route.samples
    g.lineCap = 'round'; g.lineJoin = 'round'
    g.lineWidth = 5 * dpr; g.strokeStyle = 'rgba(6,35,28,0.8)'
    g.beginPath(); s.forEach((p, i) => { const [a, b] = P(p.x, p.y); if (i) g.lineTo(a, b); else g.moveTo(a, b) }); g.stroke()
    g.lineWidth = 2.6 * dpr; g.strokeStyle = COL.route
    g.beginPath(); let started = false
    s.forEach(p => { if (p.d < d) return; const [a, b] = P(p.x, p.y); if (started) g.lineTo(a, b); else { g.moveTo(a, b); started = true } }); g.stroke()
    g.lineWidth = 2 * dpr; g.strokeStyle = 'rgba(239,235,228,0.45)'
    g.beginPath(); started = false
    s.forEach(p => { if (p.d > d) return; const [a, b] = P(p.x, p.y); if (started) g.lineTo(a, b); else { g.moveTo(a, b); started = true } }); g.stroke()
    for (const sh of shelters) {
      const [a, b] = P(sh.x, sh.y)
      g.fillStyle = sh.open ? COL.shelter : COL.muted
      g.beginPath(); g.moveTo(a, b - 6 * dpr); g.lineTo(a + 6 * dpr, b); g.lineTo(a, b + 6 * dpr); g.lineTo(a - 6 * dpr, b); g.closePath(); g.fill()
    }
    // position: filled circle + forward beam showing the field of view
    const cx = c.width / 2, cy = c.height / 2
    g.fillStyle = 'rgba(239,235,228,0.22)'
    g.beginPath(); g.moveTo(cx, cy)
    g.arc(cx, cy, 34 * dpr, yaw - Math.PI / 2 - 0.6, yaw - Math.PI / 2 + 0.6); g.closePath(); g.fill()
    g.fillStyle = COL.crew; g.strokeStyle = '#0c0b0a'; g.lineWidth = 2 * dpr
    g.beginPath(); g.arc(cx, cy, 5 * dpr, 0, Math.PI * 2); g.fill(); g.stroke()
    g.fillStyle = COL.crew; g.font = `600 ${10 * dpr}px system-ui`; g.textAlign = 'center'; g.fillText('N', c.width / 2, 12 * dpr)
    // scale bar 100 m, bottom centre (inside the round frame)
    const bx = c.width / 2 - 50 * k, by = c.height - 14 * dpr
    g.strokeStyle = COL.crew; g.lineWidth = 2 * dpr
    g.beginPath(); g.moveTo(bx, by); g.lineTo(bx + 100 * k, by); g.stroke()
    g.textAlign = 'center'; g.font = `500 ${9 * dpr}px system-ui`; g.fillText('100 m', c.width / 2, by - 4 * dpr)
  })
  return <canvas ref={cv} className="hv-mini" style={{ width: size, height: size }} aria-label="Mini-map, north up" />
}
