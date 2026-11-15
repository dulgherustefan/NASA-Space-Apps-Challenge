// Main-thread facade over a small pool of engine workers.
import type { SiteData } from './site'
import type { Params } from './params'
import type {
  BoulderRun, Destination, EvalJob, InitMsg, Job, NavJob, NavResult, Reply, RouteResult, StaticsResult,
} from './protocol'

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void }

export class Engine {
  private workers: Worker[] = []
  private busy: boolean[] = []
  private queue: { job: Job; p: Pending }[] = []
  private pending = new Map<number, Pending & { w: number }>()
  private nextId = 1
  ready: Promise<void>
  policyLoaded = false
  policyMeta: any = null

  constructor(site: SiteData, policy: unknown | null, size = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1))) {
    const { core, reg } = site.meta
    const half = core.size / 2
    this.policyLoaded = !!policy
    this.policyMeta = (policy as any)?.meta ?? null
    const inits: Promise<void>[] = []
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
      const msg: InitMsg = {
        type: 'init', na: core.na, n: core.n, renderCell: core.renderCell, size: core.size,
        z: site.z, slope: site.slope, rough: site.rough, sand: site.sand, beta: site.beta, sky: site.sky, pit: site.pit,
        coreH: site.coreH,
        reg: { nx: reg.nx, ny: reg.ny, cell: reg.cell, x0: reg.e0 - core.e0 - half, z0: reg.s0 - core.s0 - half, h: site.regH, slope: site.regSlope, beta: site.regBeta },
        policy,
      }
      inits.push(new Promise<void>(res => {
        w.onmessage = (ev: MessageEvent<Reply>) => {
          if (ev.data.id === -1) { res(); return }
          this.onReply(i, ev.data)
        }
      }))
      w.onerror = e => console.error('engine worker error', e.message)
      w.postMessage(msg)       // structured clone: each worker owns a copy
      this.workers.push(w); this.busy.push(false)
    }
    this.ready = Promise.all(inits).then(() => undefined)
  }

  get size() { return this.workers.length }

  /** Drop jobs that have not started yet (a newer plan supersedes them). */
  cancelQueued() { const q = this.queue; this.queue = []; for (const { p } of q) p.reject(new Error('superseded')) }

  dispose() { for (const w of this.workers) w.terminate(); this.workers = []; this.busy = []; this.queue = []; this.pending.clear() }

  private onReply(w: number, r: Reply) {
    const p = this.pending.get(r.id)
    this.busy[w] = false
    if (p) {
      this.pending.delete(r.id)
      if (r.ok) p.resolve(r.result); else p.reject(new Error(r.error))
    }
    this.pump()
  }

  private pump() {
    for (let w = 0; w < this.workers.length && this.queue.length; w++) {
      if (this.busy[w]) continue
      const { job, p } = this.queue.shift()!
      this.busy[w] = true
      this.pending.set(job.id, { ...p, w })
      this.workers[w].postMessage(job)
    }
  }

  private run<T>(job: Omit<Job, 'id'>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const full = { ...job, id: this.nextId++ } as Job
      this.queue.push({ job: full, p: { resolve, reject } })
      this.pump()
    })
  }

  setPolicy(policy: unknown) {
    this.policyLoaded = !!policy
    this.policyMeta = (policy as any)?.meta ?? null
    for (const w of this.workers) w.postMessage({ type: 'policy', policy })
  }

  statics(params: Params) { return this.run<StaticsResult>({ type: 'statics', params } as any) }
  comms(masts: { x: number; y: number; h: number }[]) { return this.run<Uint8Array>({ type: 'comms', masts } as any) }
  isochrones(params: Params, bandActive: boolean, goals: { x: number; y: number }[]) {
    return this.run<Float32Array>({ type: 'iso', params, bandActive, goals } as any)
  }
  rockfall(params: Params, count: number, seed: number, focus: { x: number; y: number; r: number }) {
    return this.run<BoulderRun[]>({ type: 'rockfall', params, count, seed, focus } as any)
  }
  evaluate(job: Omit<EvalJob, 'type' | 'id'>) { return this.run<RouteResult>({ type: 'eval', ...job } as any) }

  // ---- Navigator v2 (rl/SPEC_NAV.md): one deterministic route per destination --------------------------------
  navPolicyLoaded = false
  navPolicyMeta: any = null

  /** Load the trained navigator (parsed public/policy/nav_policy.json); null unloads it (nav jobs then return the baseline). */
  setNavPolicy(policy: unknown | null) {
    this.navPolicyLoaded = !!policy
    this.navPolicyMeta = (policy as any)?.meta ?? null
    for (const w of this.workers) w.postMessage({ type: 'navPolicy', policy })
  }

  /** One route to one destination. route.source is 'rl' when a nav policy is loaded and job.useRL, else 'baseline'. */
  navigate(job: Omit<NavJob, 'type' | 'id'>) { return this.run<NavResult>({ type: 'nav', ...job } as any) }

  /** Routes to every destination in parallel (science targets may sit inside a standing band). Results keep the order of dests. */
  navigateAll(common: Omit<NavJob, 'type' | 'id' | 'dest'>, dests: Destination[], onOne?: (r: NavResult) => void) {
    return Promise.all(dests.map(dest => this.navigate({ ...common, dest, ignoreBandForDest: common.ignoreBandForDest ?? dest.kind === 'target' })
      .then(r => { onOne?.(r); return r })))
  }

  /** Plan + simulate every destination in parallel. */
  evaluateAll(common: Omit<EvalJob, 'type' | 'id' | 'dest' | 'seed'>, dests: Destination[], seed: number, onOne?: (r: RouteResult) => void) {
    return Promise.all(dests.map((dest, i) => this.evaluate({ ...common, dest, seed: seed + i * 7919, ignoreBandForDest: dest.kind === 'target' })
      .then(r => { onOne?.(r); return r })))
  }
}
