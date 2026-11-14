// Message and file shapes from docs/CONTRACT.md (v0.2). Fields the contract marks optional are optional here.

export type Kind = 'measured' | 'model' | 'requirement' | 'assumption' | 'scenario'
export type Phase = 'detect' | 'assess' | 'simulate' | 'respond' | 'idle'
export type IncidentKind = 'sep' | 'quake' | 'dust' | 'science'
export type RouteStatus = 'candidate' | 'testing' | 'tested' | 'rejected' | 'chosen' | 'infeasible'
export type StressMethod = 'ppo-ast' | 'cem' | 'mc'
export type FailureClass = 'fall' | 'heat' | 'oxygen' | 'late' | 'stuck'

export interface Place { id: string; name: string; kind: 'site' | 'habitat' | 'rover' | 'shelter' | string; e: number; s: number; z?: number }
export interface ScenarioItem { id: string; kind: IncidentKind; title: string; at_s: number }
export interface Hello {
  type: 'hello'; t: number; product: string; version: string
  site: { name: string; lat?: number; lon?: number; core: { e0: number; s0: number; size: number }; z_ref?: number; ortho?: string }
  places?: Place[]
  scenario: ScenarioItem[]
}
export interface CrewState { id: number; name?: string; e: number; s: number; z: number; heading: number; pace: number; o2: number; heat: number; dose: number; status: number }
export interface Sensors { dose_rate: number; seismic: number; tau: number }
export interface Snapshot {
  type: 'snapshot'; t: number
  clock: { t: number; sol: number; lmst: string; utc?: string; speed: number; paused: boolean }
  phase: Phase; incident_id?: string | null
  crew: CrewState[]; sensors: Sensors; light_time_s?: number
}
export interface Quantity { label: string; value: number | string; unit?: string; source?: string; kind: Kind }
export interface Incident {
  type: 'incident'; t: number; id: string; kind: IncidentKind; title: string; summary?: string; source?: string
  scenario: boolean; e?: number | null; s?: number | null; params?: Quantity[]
}
export interface ShelterState { id: string; name: string; e: number; s: number; open: boolean; reason?: string }
export interface Assessment {
  type: 'assessment'; t: number; incident_id: string; changes: Quantity[]
  overlays?: { layer: string; file: string; label?: string }[]; shelters?: ShelterState[]
}
export interface RouteSummary {
  id: number; shelter: string; label?: string; length_m: number; time_s: number; ascent_m: number; max_slope: number
  o2_margin: number; heat_margin: number; dose: number; robustness_nats: number | null; mc_fail_rate: number | null; status: RouteStatus
}
export interface RoutesMsg { type: 'routes'; t: number; incident_id: string; file?: string; routes: RouteSummary[] }
export interface FailureEvent { t: number; channel: string; value: number; log_p: number }
export interface Failure { class: FailureClass; e: number; s: number; t: number; log_p: number; summary?: string; events?: FailureEvent[] }
export interface Stress {
  type: 'stress'; t: number; incident_id?: string; route_id: number; method: StressMethod; source?: string
  robustness_nats: number | null; mc_fail_rate?: number | null; mc_ci?: [number, number]; n?: number
  failures: Failure[]; heatmap?: string
}
export interface Decision {
  type: 'decision'; t: number; incident_id?: string; route_id: number; shelter?: string; auto?: boolean
  reasons: string[]; avoided: { label: string; detail?: string }[]; time_to_shelter_s: number
  margins: { o2: number; heat: number; dose: number }
}
export interface LogMsg { type: 'log'; t: number; level: string; text: string; source?: string }
export type EngineMsg = Hello | Snapshot | Incident | Assessment | RoutesMsg | Stress | Decision | LogMsg

// runtime files
export interface RoutesFile { incident_id: string; routes: { id: number; shelter: string; points: [number, number, number][]; time_s: number; length_m: number }[] }
export interface TrajRun {
  route: number; id: number; outcome: string; log_p: number
  samples: [number, number, number, number, number][]
  events?: { t: number; channel: string; value: number; log_p: number }[]
}
export interface TrajFile { dt: number; runs: TrajRun[] }
export interface ParamDef {
  key: string; label: string; value: number; unit: string; kind: string; group?: string; note?: string; source?: string; url?: string
  min?: number; max?: number
}
