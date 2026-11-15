// Messages between the main thread and the engine workers.
import type { Params } from './params'
import type { RouteStats } from './sim'
import type { BoulderRun } from './rockfall'
import type { TerrainShelter } from './planner'
import type { NavRoute } from './navTypes'

export type ShelterKind = 'habitat' | 'rover' | 'terrain' | 'target'

export interface Destination {
  id: string
  kind: ShelterKind
  name: string
  x: number; y: number            // core metres (east, south)
  shield: number                  // fraction of dose removed when inside
}

export interface InitMsg {
  type: 'init'
  na: number; n: number; renderCell: number; size: number
  z: Float32Array; slope: Float32Array; rough: Float32Array; sand: Float32Array
  beta: Float32Array; sky: Float32Array; pit: Float32Array
  coreH: Float32Array
  reg: { nx: number; ny: number; cell: number; x0: number; z0: number; h: Float32Array; slope: Uint8Array; beta: Uint8Array }
  policy: unknown | null
}

export interface EvalJob {
  type: 'eval'
  id: number
  params: Params
  bandActive: boolean
  dest: Destination
  start: { x: number; y: number; heat: number; o2: number; dose: number }
  sepElapsedS: number
  deadlineS: number
  dust: number
  n: number
  seed: number
  useRL: boolean
  greedy: boolean
  trackAgents: number
  ignoreBandForDest?: boolean     // science targets may sit inside a standing band
}

export interface RouteResult {
  destId: string
  reachable: boolean
  admissible: boolean             // destination is outside an active rockfall band
  inBand: boolean
  path: { xy: Float32Array; timeS: number; lengthM: number; climbM: number; descentM: number; maxSlopeDeg: number; bandLengthM: number; sandLengthM: number } | null
  stats: RouteStats | null
  tracks: Float32Array | null     // trackAgents x (steps+1) x 2
  trackStatus: Uint8Array | null
  trackEnd: Float32Array | null   // seconds
  trackAgents: number
  steps: number
  failXY: Float32Array | null     // x, y of every failed crew
  planMs: number; simMs: number
  policy: 'rl' | 'baseline'
}

/** Navigator job (v2): one deterministic route per destination, produced by the RL policy. */
export interface NavJob {
  type: 'nav'
  id: number
  params: Params
  bandActive: boolean
  dest: Destination
  start: { x: number; y: number; heat: number; o2: number; dose: number }
  sepElapsedS: number             // same convention as EvalJob
  deadlineS: number
  dust: number
  useRL: boolean                  // false forces the scripted baseline
  ignoreBandForDest?: boolean     // science targets may sit inside a standing band
  withReference?: boolean         // also return the risk-weighted planner route for comparison
}

export interface NavResult {
  destId: string
  reachable: boolean              // the static time-to-go field reaches the start
  admissible: boolean             // destination is outside an active rockfall band
  inBand: boolean
  route: NavRoute | null          // the navigator's route (source 'rl', or 'baseline' when no policy is loaded)
  reference: NavRoute | null      // source 'planner', only when withReference
  planMs: number
  navMs: number
}

export interface StaticsJob { type: 'statics'; id: number; params: Params }
export interface StaticsResult { keepout: Uint8Array; blocked: Uint8Array; shelters: TerrainShelter[]; sheltersOutsideBand: TerrainShelter[] }

export interface IsoJob { type: 'iso'; id: number; params: Params; bandActive: boolean; goals: { x: number; y: number }[] }
export interface CommsJob { type: 'comms'; id: number; masts: { x: number; y: number; h: number }[] }
export interface RockfallJob { type: 'rockfall'; id: number; params: Params; count: number; seed: number; focus: { x: number; y: number; r: number } }
export interface PolicyMsg { type: 'policy'; policy: unknown }
/** Loads (or clears, with null) the Navigator v2 policy (public/policy/nav_policy.json) in a worker. */
export interface NavPolicyMsg { type: 'navPolicy'; policy: unknown | null }

export type Job = EvalJob | NavJob | StaticsJob | IsoJob | CommsJob | RockfallJob
export type ToWorker = InitMsg | Job | PolicyMsg | NavPolicyMsg

export interface Reply { id: number; ok: boolean; error?: string; result?: unknown }
export type { BoulderRun, TerrainShelter, RouteStats }
