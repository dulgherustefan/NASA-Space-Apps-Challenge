// Values the console derives from engine messages. Nothing here adds information the engine did not send:
// it only reads positions against the chosen polyline and picks the deadline out of the assessment.
import { useEffect, useState } from 'react'
import type { IncidentBundle } from './store'
import type { CrewState, RoutesFile, Snapshot } from './types'

export type Layout = 'field' | 'split' | 'wide'

/** field: one column for a tablet or cuff display. split: map and one rail. wide: both rails. */
export function useLayout(): Layout {
  const read = (): Layout => (window.innerWidth >= 1320 ? 'wide' : window.innerWidth >= 900 ? 'split' : 'field')
  const [l, setL] = useState<Layout>(read)
  useEffect(() => {
    const on = () => setL(read())
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return l
}

export interface Deadline {
  /** seconds allowed from the first step; null when the incident sets no deadline */
  allowed_s: number | null
  /** the rule in minutes as the engine states it, for the label */
  rule_min: number | null
}

/** The shelter deadline of an incident. Prefers the explicit field; older engines only list it under changes. */
export function deadlineOf(b: IncidentBundle | null): Deadline {
  const a = b?.assessment
  if (!a) return { allowed_s: null, rule_min: null }
  const rule = a.changes.find((c) => c.kind === 'requirement' && c.unit === 'min' && /rule/i.test(c.label))
  const rule_min = typeof rule?.value === 'number' ? rule.value : null
  if (a.limits) return { allowed_s: a.limits.shelter_s, rule_min }
  const left = a.changes.find((c) => c.unit === 'min' && /^time left under/i.test(c.label))
  return { allowed_s: typeof left?.value === 'number' ? left.value * 60 : null, rule_min }
}

export interface Progress {
  total_m: number
  left_m: number
  /** 0..1 of the polyline behind the crew */
  frac: number
  /** degrees clockwise from north towards the route about 40 m ahead */
  bearing: number
  /** distance from the crew to the nearest point of the polyline */
  off_m: number
}

/** Where a crew member is along a route polyline (local metres). */
export function progressOn(points: [number, number, number][], e: number, s: number): Progress | null {
  if (points.length < 2) return null
  let total = 0
  const cum = [0]
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
    cum.push(total)
  }
  let best = Infinity, at = 0
  for (let i = 1; i < points.length; i++) {
    const ax = points[i - 1][0], ay = points[i - 1][1], bx = points[i][0], by = points[i][1]
    const dx = bx - ax, dy = by - ay
    const l2 = dx * dx + dy * dy
    const t = l2 > 0 ? Math.min(1, Math.max(0, ((e - ax) * dx + (s - ay) * dy) / l2)) : 0
    const d = Math.hypot(e - (ax + dx * t), s - (ay + dy * t))
    if (d < best) { best = d; at = cum[i - 1] + Math.sqrt(l2) * t }
  }
  // aim point: 40 m further along, or the end
  const aim = Math.min(total, at + 40)
  let k = 1
  while (k < points.length - 1 && cum[k] < aim) k++
  const seg = cum[k] - cum[k - 1]
  const f = seg > 0 ? (aim - cum[k - 1]) / seg : 0
  const tx = points[k - 1][0] + (points[k][0] - points[k - 1][0]) * f
  const ty = points[k - 1][1] + (points[k][1] - points[k - 1][1]) * f
  // s grows southward, so north is -s
  const bearing = (Math.atan2(tx - e, -(ty - s)) * 180) / Math.PI
  return { total_m: total, left_m: Math.max(0, total - at), frac: total > 0 ? at / total : 0, bearing: (bearing + 360) % 360, off_m: best }
}

/** Straight-line distance and bearing between two points in local metres. A line on the map, not a route. */
export function lineTo(fromE: number, fromS: number, toE: number, toS: number): { dist_m: number; bearing: number } {
  // s grows southward, so north is -s
  const bearing = (Math.atan2(toE - fromE, -(toS - fromS)) * 180) / Math.PI
  return { dist_m: Math.hypot(toE - fromE, toS - fromS), bearing: (bearing + 360) % 360 }
}

/** Wall time that ticks, for readouts that age while no message arrives. */
export function useNow(every_ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every_ms)
    return () => clearInterval(t)
  }, [every_ms])
  return now
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
export const compass = (deg: number) => POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]
/** 048° NE */
export const bearingText = (deg: number) => `${String(Math.round(deg) % 360).padStart(3, '0')}° ${compass(deg)}`

export type WalkPhase = 'none' | 'ready' | 'walking' | 'arrived' | 'stopped'

export interface WalkView {
  phase: WalkPhase
  /** seconds of walking left on the chosen route; null before a decision */
  left_s: number | null
  progress: Progress | null
  lead: CrewState | null
}

/** Live state of the walk on the chosen route of an incident. */
export function walkView(b: IncidentBundle | null, snap: Snapshot | null, routes: RoutesFile | null): WalkView {
  const lead = snap?.crew[0] ?? null
  const d = b?.decision
  if (!b || !d || !lead) return { phase: 'none', left_s: null, progress: null, lead }
  const geom = routes && routes.incident_id === b.id ? routes.routes.find((r) => r.id === d.route_id) : undefined
  const progress = geom ? progressOn(geom.points, lead.e, lead.s) : null
  const w = snap?.walk && snap.walk.incident_id === b.id && snap.walk.route_id === d.route_id ? snap.walk : null
  const arrived = lead.status === 6 || lead.status === 7
  const stopped = lead.status >= 3 && lead.status <= 5
  let left_s: number | null = d.time_to_shelter_s
  if (w) left_s = Math.max(0, w.time_s - w.elapsed_s)
  else if (progress) left_s = d.time_to_shelter_s * (1 - progress.frac)
  if (arrived) left_s = 0
  const moving = w ? w.elapsed_s > 0 : lead.status === 0 && lead.pace > 0.05
  const phase: WalkPhase = arrived ? 'arrived' : stopped ? 'stopped' : moving ? 'walking' : 'ready'
  return { phase, left_s, progress, lead }
}
