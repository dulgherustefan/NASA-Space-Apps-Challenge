// Contract between the RL navigator (engine/nav.ts), the engine worker, the mission core and both UIs.
// A NavRoute is ONE deterministic rollout of the navigator from the crew position to one destination.
// The route the product shows is the greedy rollout of the trained policy (source 'rl').

export type NavSource = 'rl' | 'baseline' | 'planner'
//  'rl'       trained PPO policy, argmax under the hard-limit mask
//  'baseline' scripted walker that follows the static time-to-go field (used when no policy file is loaded)
//  'planner'  risk-weighted Dijkstra path walked with the scripted pace (comparison only)

export type NavStatus = 'arrived' | 'timeout' | 'stuck' | 'heat' | 'o2' | 'unreachable'

/** Bit flags per route sample (NavRoute.flags). */
export const NAV_FLAG = { BAND: 1, SAND: 2, STEEP: 4, SHIELDED: 8, ASSIST: 16 } as const

export interface NavSummary {
  timeS: number                 // walking time to the destination
  lengthM: number
  climbM: number
  descentM: number
  maxSlopeDeg: number
  meanPace: number              // m/s
  bandS: number                 // seconds spent inside the rockfall band (active or standing)
  bandM: number                 // metres walked inside the band
  sandM: number                 // metres on loose sand
  doseArrive: number            // uGy accumulated on the walk (SEP + GCR)
  dose2h: number                // uGy by 2 h after SEP onset, sheltered time included (model)
  doseOpen2h: number            // uGy by the same time if the crew stayed in the open (reference)
  heatPeakKJ: number            // peak stored body heat
  o2UsedKg: number
  o2MarginMin: number           // minutes of O2 left on arrival at the nominal rate
  expectedFalls: number         // integrated fall rate along the route (model, not a count)
  inRule: boolean | null        // arrived inside the shelter rule; null when no SEP is active
  cost: number                  // objective J in equivalent seconds (same definition for rl, baseline, planner)
}

export interface NavRoute {
  destId: string
  source: NavSource
  status: NavStatus
  n: number                     // number of samples; sample 0 is the start
  x: Float32Array               // core metres east
  y: Float32Array               // core metres south
  t: Float32Array               // seconds since departure
  v: Float32Array               // pace chosen at that sample, m/s
  elev: Float32Array            // terrain elevation, m
  slope: Float32Array           // local slope, deg
  heat: Float32Array            // stored body heat, kJ
  o2: Float32Array              // O2 remaining, kg
  dose: Float32Array            // uGy accumulated since departure
  flags: Uint8Array             // NAV_FLAG bits
  summary: NavSummary
  policyValue: number | null    // critic estimate at departure (training-reward units); null if not available
  assistSteps: number           // steps where the run-time assist overrode the policy (0 = pure policy)
  ms: number                    // wall-clock of this rollout
}

/** Flat polyline (x0, y0, x1, y1, ...) for drawing; core metres. */
export function navPolyline(r: NavRoute): Float32Array {
  const out = new Float32Array(r.n * 2)
  for (let i = 0; i < r.n; i++) { out[2 * i] = r.x[i]; out[2 * i + 1] = r.y[i] }
  return out
}

/** nav_policy.json meta shown in the dashboard (free-form beyond these keys). */
export interface NavPolicyMeta {
  version: string
  date: string
  envSteps: number
  wallClockS: number
  device: string
  obsDim: number
  hidden: number[]
  headings: number
  paces: number[]
  [k: string]: unknown
}

/** One checkpoint of the learning process (nav_replay.json), for the training-replay animation. */
export interface NavReplay {
  scenarios: {
    id: string; title: string
    start: { x: number; y: number }
    goal: { x: number; y: number; name: string }
    bandActive: boolean
    checkpoints: {
      update: number; envSteps: number
      greedy: { xy: number[]; arrived: boolean; timeS: number }
      samples: { xy: number[]; arrived: boolean; timeS: number }[]
    }[]
  }[]
}
