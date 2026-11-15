// Shared types for live mode. Coordinates follow docs/CONTRACT.md: core metres, x east / y south of
// the EVA-box corner. World (three.js) frame: x = east, y = up (elevation - Z0), z = south, origin at
// the box centre, so worldX = x - size/2, worldZ = y - size/2.
import type { SiteData } from './engine/site'

export type Grade = 'eva' | 'planning' | 'unsuitable'

export const GRADE_LABEL: Record<Grade, string> = {
  eva: 'EVA-grade',
  planning: 'Route-planning grade',
  unsuitable: 'Not suitable for a walk',
}

/** Describes the terrain grid the planner runs on, where it came from and how far it can be trusted. */
export interface SiteDescriptor {
  id: string
  name: string
  lon: number; lat: number          // box centre, planetocentric deg E (0..360) / deg N
  sizeM: number                     // box edge (m), 4000 for the bundled site
  cellM: number                     // planner cell (m), always 5
  n: number                         // planner cells per edge (sizeM / cellM)
  source: string                    // dataset id + credit line
  sourceResM: number                // native post spacing of the elevation source (m)
  grade: Grade
  gradeReason: string
  bundled: boolean                  // true: precomputed by the Python pipeline; false: fetched live in the browser
  orthoUrl: string | null           // top-down image for the box (same extent), or null
  orthoNote: string                 // where the image comes from
}

export interface LoadedSite { site: SiteData; desc: SiteDescriptor }

/** Bit flags on a route sample. */
export const FLAG = { BAND: 1, STEEP: 2, SAND: 4, NO_COMMS: 8 } as const

export interface RouteSample {
  x: number; y: number              // core metres
  z: number                         // absolute elevation (m)
  d: number                         // metres along the route
  t: number                         // seconds since departure (planner walking time, model)
  o2Min: number                     // O2 left (minutes at nominal use), model
  heatKJ: number                    // stored body heat (kJ), model
  doseUGy: number                   // dose accumulated on the walk since departure (µGy, GCR + SEP), model
  slopeDeg: number
  flags: number                     // FLAG bits
}

export interface Turn {
  i: number                         // sample index of the turn
  d: number                         // metres along the route
  angleDeg: number                  // signed heading change, + = right
  text: string                      // "Bear left", "Turn right", "Sharp left"
}

export interface MonteCarlo {
  n: number                         // virtual crews walked
  successRate: number               // fraction that arrived inside every limit
  failRate: number
  ciLo: number; ciHi: number        // 95 % Wilson interval on failRate
  p50S: number; p90S: number        // arrival-time percentiles (s)
  modes: { label: string; count: number }[]   // failure causes
  policy: 'rl' | 'baseline'         // pacing/steering of the virtual crews
  ms: number                        // compute time of the virtual crews
  planMs?: number                   // compute time of the planner field + path
}

export interface LiveRoute {
  destId: string
  destName: string
  destKind: 'habitat' | 'rover' | 'terrain'
  destX: number; destY: number
  shield: number                    // fraction of dose removed inside
  samples: RouteSample[]
  turns: Turn[]
  lengthM: number
  timeS: number                     // planner walking time
  climbM: number
  maxSlopeDeg: number
  bandLengthM: number               // metres inside the rockfall band
  admissible: boolean
  reason: string                    // why rejected / chosen, one line
  mc: MonteCarlo | null
  chosen: boolean
  failXY: Float32Array | null       // end points of failed virtual crews
}

export interface Shelter { id: string; kind: 'habitat' | 'rover' | 'terrain'; name: string; x: number; y: number; shield: number; open: boolean }

export type IncidentKind = 'storm' | 'quake'
export interface Incident {
  kind: IncidentKind
  startedAt: number                 // Date.now() of the alert
  ruleS: number                     // storm: 30-min rule; quake: hold-out time
}

export interface Hazard { kind: 'rockfall' | 'steep' | 'comms'; x: number; y: number; label: string }
