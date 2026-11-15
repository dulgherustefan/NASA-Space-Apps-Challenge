import { useEffect, useState } from 'react'
import { ArrowUp, Check, CircleCheck, Route, ShieldAlert, TriangleAlert, X } from 'lucide-react'
import { focusBundle, store, useStore, type IncidentBundle } from '@/lib/store'
import { fileUrl } from '@/lib/config'
import { compass, deadlineOf, progressOn, walkView, type Deadline, type WalkView } from '@/lib/derive'
import { closePlan } from '@/lib/engine'
import { dur, missionT, num, pct1, splitLabel } from '@/lib/format'
import type { Decision, RouteSummary } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Fig, GroupKind } from '../Kind'
import { Meter } from '../Meter'
import { INCIDENT_ICON, More, PHASE_META, PhaseSteps } from './parts'

const MODEL_SRC = 'Engine run-time model (walk physiology and suit model). Not a measurement of a real crew.'

function IncidentLine({ b }: { b: IncidentBundle }) {
  const Icon = INCIDENT_ICON[b.incident.kind]
  return (
    <div className="flex items-center justify-between gap-3 text-[13px]">
      <div className="flex min-w-0 items-center gap-2">
        <Icon size={16} strokeWidth={1.8} className="shrink-0 text-ink2" />
        <span className="truncate font-medium text-ink">{b.incident.title}</span>
        <span className="num hidden shrink-0 text-[12px] text-ink3 sm:inline">{missionT(b.incident.t)}</span>
      </div>
      {b.incident.detection ? (
        <GroupKind kind="scenario" label="Raised by the on-site dose-rate rule" source={`${b.incident.detection.rule}. ${b.incident.detection.replay ?? ''}`}>
          <span className="text-[12px] text-ink3">on-site rule</span>
        </GroupKind>
      ) : (
        <GroupKind kind={b.incident.scenario ? 'scenario' : 'measured'} label={b.incident.scenario ? 'Scripted incident' : 'Observation'} source={b.incident.source}>
          <span className="text-[12px] text-ink3">{b.incident.scenario ? 'scripted' : 'observed'}</span>
        </GroupKind>
      )}
    </div>
  )
}

/** Walking time against the time the rule allows, on one bar. */
function Budget({ time_s, deadline }: { time_s: number; deadline: Deadline }) {
  if (deadline.allowed_s === null) return null
  const allowed = deadline.allowed_s
  const spare = allowed - time_s
  const ok = spare >= 0
  const span = Math.max(allowed, time_s) * 1.04
  const rule = deadline.rule_min ? `the ${num(deadline.rule_min)}-minute shelter rule` : 'the shelter rule'
  return (
    <div className="mt-3.5">
      <div className="relative h-2 rounded-[2px] bg-rule">
        <div className="absolute inset-y-0 left-0 rounded-[2px] transition-[width] duration-500" style={{ width: `${(time_s / span) * 100}%`, background: ok ? 'var(--color-safe)' : 'var(--color-hazard)' }} />
        <div className="absolute -inset-y-1 w-[2px] bg-ink" style={{ left: `${(allowed / span) * 100}%` }} aria-hidden />
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-3 text-[13px]">
        <span className={ok ? 'text-ink2' : 'text-hazard'}>
          {ok ? <><span className="num text-ink">{dur(spare)}</span> spare under {rule}</> : <>Misses {rule} by <span className="num">{dur(-spare)}</span></>}
        </span>
        <Fig value={dur(allowed)} unit="allowed" kind="model" source="Shelter rule minus the time already used since the alert" label="Time allowed from the first step" className="shrink-0" valueClassName="text-[12.5px] text-ink2" />
      </div>
    </div>
  )
}

function Heading({ walk }: { walk: WalkView }) {
  const p = walk.progress
  if (!p || walk.phase === 'arrived') return null
  return (
    <div className="flex items-center gap-2.5 pb-1">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-panel3" aria-hidden>
        <ArrowUp size={20} strokeWidth={2.2} className="text-accent transition-transform duration-500" style={{ transform: `rotate(${p.bearing}deg)` }} />
      </span>
      <div className="min-w-0 leading-tight">
        <div className="whitespace-nowrap text-[14px] text-ink">
          <span className="num font-medium">{String(Math.round(p.bearing)).padStart(3, '0')}°</span> {compass(p.bearing)}
        </div>
        <div className="whitespace-nowrap text-[12.5px] text-ink3">
          <span className="num text-ink2">{num(Math.round(p.left_m / 5) * 5)} m</span> to go
        </div>
        {p.off_m > 25 && <div className="whitespace-nowrap text-[12.5px] text-caution">{num(Math.round(p.off_m))} m off the route</div>}
      </div>
    </div>
  )
}

/** What the destination looks like from the approach: a render of the terrain model, labelled as such. */
function ArrivalView({ placeId, name }: { placeId: string | undefined; name: string }) {
  const item = useStore((s) => (placeId ? s.pov[placeId] : undefined))
  const [failed, setFailed] = useState(false)
  const path = item ? (item.file.includes('/') ? item.file : `data/site/pov/${item.file}`) : ''
  if (!item || failed || !fileUrl(path)) return null
  return (
    <figure className="mt-5">
      <img src={fileUrl(path)} alt={`Rendered view of ${name} from the approach`} loading="lazy" onError={() => setFailed(true)} className="aspect-[21/9] w-full rounded-[8px] object-cover" />
      <figcaption className="mt-1.5 text-[12px] leading-snug text-ink3">View on arrival. {item.caption ?? 'Rendered from the HiRISE elevation model. Colour is approximate; ground detail and rocks are set dressing.'}</figcaption>
    </figure>
  )
}

function Decided({ b, d, route, compact }: { b: IncidentBundle; d: Decision; route?: RouteSummary; compact?: boolean }) {
  const snap = useStore((s) => s.snapshot)
  const routesFile = useStore((s) => s.routesFile)
  const walk = walkView(b, snap, routesFile)
  const deadline = deadlineOf(b)
  const { name, variant } = splitLabel(route?.label ?? d.shelter ?? 'shelter')
  const sortie = b.incident.kind === 'science'
  const lead = sortie
    ? { ready: 'Sortie', walking: 'On sortie', arrived: 'Sortie complete', stopped: 'Stopped on sortie', none: 'Sortie' }[walk.phase]
    : { ready: 'Go to', walking: 'On the way to', arrived: 'Arrived at', stopped: 'Stopped on the way to', none: 'Go to' }[walk.phase]
  const late = route?.rule_ok === false
  const tone = walk.phase === 'stopped' || late ? 'hazard' : 'safe'
  const big = walk.phase === 'walking' && walk.left_s !== null ? walk.left_s : d.time_to_shelter_s
  return (
    <div key={`${b.id}:${d.route_id}`} className="anim-rise">
      <h2 className="mt-5 text-balance text-[24px] font-semibold leading-[1.15] tracking-[-0.02em] text-ink">
        <span className={tone === 'hazard' ? 'text-hazard' : 'text-safe'}>{lead}</span> {name}
      </h2>
      <p className="mt-1 text-[12.5px] text-ink3">Route {d.route_id}{variant && `, ${variant}`} · {d.auto === false ? 'chosen by the operator' : 'chosen automatically'}</p>

      {walk.phase === 'arrived' ? (
        <div className="mt-4 flex items-center gap-2 text-[15px] text-safe"><CircleCheck size={18} />{sortie ? 'Crew back at the start' : `Crew at ${name}`}</div>
      ) : (
        <div className="mt-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          <div className="flex items-baseline gap-2">
            <Fig value={dur(big)} kind="model" source={MODEL_SRC + ' Planner walking time on the chosen route.'} label={walk.phase === 'walking' ? 'Walking time left' : 'Walking time to shelter'}
              valueClassName={cn('font-medium leading-none tracking-[-0.03em]', compact ? 'text-[46px]' : 'text-[56px]')} />
            <span className="text-[13px] text-ink3">{walk.phase === 'walking' ? 'left' : 'walk'}</span>
          </div>
          <Heading walk={walk} />
        </div>
      )}

      {walk.phase !== 'arrived' && <Budget time_s={d.time_to_shelter_s} deadline={deadline} />}
      {late && deadline.allowed_s === null && route?.rule_reasons?.length ? (
        <p className="mt-2 flex gap-2 text-[13px] leading-snug text-hazard"><TriangleAlert size={14} className="mt-[2px] shrink-0" />Route {route.rule_reasons.join('; ')}</p>
      ) : null}

      <div className="mt-5 grid grid-cols-3 gap-4">
        <Meter label="Oxygen" frac={d.margins.o2} source={MODEL_SRC} hint="usable oxygen left on arrival" />
        <Meter label="Heat" frac={d.margins.heat} source={MODEL_SRC} hint="room left before the heat-storage limit on arrival" />
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[11.5px] text-ink2">Dose</span>
          <Fig value={d.dose_msv ?? route?.dose ?? null} unit="mSv" digits={2} kind="model" source={MODEL_SRC} label="Dose on this walk" />
        </div>
      </div>
      <p className="mt-2 text-[12px] leading-snug text-ink3">Left on arrival, from the walk model. Dose is {Math.round(d.margins.dose * 100)}% lower than staying in the open.</p>

      {!compact && walk.phase !== 'arrived' && <ArrivalView placeId={sortie ? (b.incident.kind === 'science' ? 'B' : d.shelter) : d.shelter} name={name} />}

      {!compact && (
        <div className="mt-5">
          <ul className="space-y-1.5">
            {d.reasons.slice(0, 2).map((r, i) => (
              <li key={i} className="flex gap-2 text-[13px] leading-snug text-ink"><Check size={14} className="mt-[2px] shrink-0 text-safe" />{r}</li>
            ))}
          </ul>
          {(d.reasons.length > 2 || d.avoided.length > 0) && (
            <More label={`Why this route, and what it avoids (${d.reasons.length - Math.min(2, d.reasons.length) + d.avoided.length})`}>
              <ul className="mt-1.5 space-y-1.5">
                {d.reasons.slice(2).map((r, i) => (
                  <li key={i} className="flex gap-2 text-[13px] leading-snug text-ink"><Check size={14} className="mt-[2px] shrink-0 text-safe" />{r}</li>
                ))}
                {d.avoided.map((a, i) => (
                  <li key={`a${i}`} className="flex gap-2">
                    <ShieldAlert size={14} className="mt-[2px] shrink-0 text-hazard" strokeWidth={1.8} />
                    <div className="min-w-0 text-[13px] leading-snug"><span className="text-ink">{a.label}</span>{a.detail && <span className="text-ink3"> · {a.detail}</span>}</div>
                  </li>
                ))}
              </ul>
            </More>
          )}
        </div>
      )}
    </div>
  )
}

const PLAN_SRC = 'Path planner on the HiRISE elevation model (5 m grid) with the walk model. A model result, not a measurement.'

/** A request on its way to the engine, or the reason the engine refused the last one. */
function PlanStatus() {
  const pending = useStore((s) => s.planPending)
  const fail = useStore((s) => s.planFail)
  if (pending) {
    return (
      <div role="status" className="mb-4 flex items-center gap-2.5 rounded-[8px] bg-panel3 px-3 py-2.5 text-[13px] text-ink">
        <span className="pulse-dot h-2 w-2 shrink-0 rounded-full bg-accent" />
        Planning a walk to <span className="num">e {Math.round(pending.e)}, s {Math.round(pending.s)}</span>
      </div>
    )
  }
  if (fail) {
    return (
      <div role="alert" className="mb-4 flex items-start gap-2.5 rounded-[8px] bg-hazard/10 px-3 py-2.5 text-[13px]">
        <TriangleAlert size={15} className="mt-[2px] shrink-0 text-hazard" />
        <div className="min-w-0 flex-1 leading-snug"><span className="font-medium text-ink">No plan. </span><span className="text-ink2">{fail.reason ?? 'The engine refused the request'}.</span></div>
        <button type="button" aria-label="Dismiss" className="shrink-0 text-ink3 hover:text-ink" onClick={() => store.set({ planFail: null })}><X size={15} /></button>
      </div>
    )
  }
  return null
}

/** A route the operator asked for before a walk. No incident, no rule, and the crew is not sent anywhere. */
function PlannedWalk({ b, compact }: { b: IncidentBundle; compact?: boolean }) {
  const plan = b.plan!
  const routesFile = useStore((s) => s.routesFile)
  const selected = useStore((s) => s.selectedRoute)
  const route = b.routes?.find((r) => r.id === selected) ?? b.routes?.find((r) => r.id === plan.recommended) ?? b.routes?.[0]
  const st = route ? b.stress[route.id] : undefined
  const geom = routesFile && routesFile.incident_id === b.id ? routesFile.routes.find((r) => r.id === route?.id) : undefined
  const progress = geom && plan.from ? progressOn(geom.points, plan.from.e, plan.from.s) : null
  const dest = plan.to?.label ?? `e ${Math.round(plan.to?.e ?? 0)}, s ${Math.round(plan.to?.s ?? 0)}`
  const start = plan.from?.label ?? 'the start'
  const walkable = !!route && route.status !== 'infeasible'
  return (
    <div key={b.id} className="anim-rise">
      <div className="flex items-center justify-between gap-3 text-[13px]">
        <div className="flex min-w-0 items-center gap-2">
          <Route size={16} strokeWidth={1.8} className="shrink-0 text-ink2" />
          <span className="font-medium text-ink">Plan</span>
          <span className="truncate text-[12px] text-ink3">before the walk, no incident</span>
        </div>
        <button type="button" className="shrink-0 text-[12.5px] text-ink2 underline decoration-dotted underline-offset-2 hover:text-ink" onClick={closePlan}>Close plan</button>
      </div>
      <h2 className="mt-5 text-balance text-[24px] font-semibold leading-[1.15] tracking-[-0.02em] text-ink">
        <span className={walkable ? 'text-accent' : 'text-hazard'}>Planned walk to</span> <span className="tabular-nums">{dest}</span>
      </h2>
      {route && <p className="mt-1 text-[12.5px] text-ink3">From {start === 'Crew position' ? 'the crew position' : start} · route {route.id}{route.label ? `, ${route.label.toLowerCase()}` : ''} · not sent to the crew</p>}

      {route && walkable && (
        <div className="mt-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
          <div className="flex items-baseline gap-2">
            <Fig value={dur(route.time_s)} kind="model" source={PLAN_SRC} label="Walking time of the planned route"
              valueClassName={cn('font-medium leading-none tracking-[-0.03em]', compact ? 'text-[46px]' : 'text-[56px]')} />
            <span className="text-[13px] text-ink3">walk</span>
          </div>
          <Heading walk={{ phase: 'ready', left_s: route.time_s, progress, lead: null }} />
        </div>
      )}
      {route && !walkable && <p className="mt-3 flex gap-2 text-[14px] leading-snug text-hazard"><TriangleAlert size={15} className="mt-[2px] shrink-0" />The walk model does not reach the destination on this route within its limits.</p>}

      {route && (
        <>
          <div className="mt-5 grid grid-cols-3 gap-4">
            <Meter label="Oxygen" frac={route.o2_margin} source={PLAN_SRC} hint="usable oxygen left on arrival" />
            <Meter label="Heat" frac={route.heat_margin} source={PLAN_SRC} hint="room left before the heat-storage limit on arrival" />
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11.5px] text-ink2">Dose</span>
              <Fig value={route.dose} unit="mSv" digits={2} kind="model" source={PLAN_SRC} label="Dose on this walk" />
            </div>
          </div>
          <p className="mt-2 text-[12px] leading-snug text-ink3">Left on arrival, from the walk model.</p>
          <ul className="mt-4 space-y-1.5 text-[13px] leading-snug text-ink">
            <li><span className="num">{num(route.length_m)} m</span><span className="text-ink2">, climbing </span><span className="num">{num(route.ascent_m)} m</span><span className="text-ink2">, steepest slope </span><span className="num">{num(route.max_slope, 1)}°</span></li>
            {st && st.mc_fail_rate !== null && st.mc_fail_rate !== undefined && (
              <li>
                <span className="text-ink2">Fails in </span>
                <Fig value={pct1(st.mc_fail_rate)} kind="model" source={`Monte Carlo, ${st.n ? st.n.toLocaleString('en-US') : 'a small number of'} walks, local preview: a small run by the engine just now`} label="Failure rate of the planned route" />
                <span className="text-ink2"> of {st.n ? st.n.toLocaleString('en-US') : ''} local preview walks{st.mc_ci ? ` (${pct1(st.mc_ci[0])} to ${pct1(st.mc_ci[1])})` : ''}</span>
              </li>
            )}
            {route.nolos_m !== undefined && route.nolos_m >= 1 && <li><span className="num">{num(route.nolos_m)} m</span><span className="text-ink2"> without radio line of sight to the habitat or the rover</span></li>}
            {route.band_m !== undefined && route.band_m >= 1 && <li className="text-caution">Crosses {num(route.band_m)} m of the rockfall runout band</li>}
          </ul>
        </>
      )}
      <p className="mt-4 text-[12px] leading-snug text-ink3">{plan.note ?? 'A plan only: the crew is not told to walk it. Model-based, not crew-tested.'}</p>
    </div>
  )
}

function Planning({ b }: { b: IncidentBundle }) {
  const phase = useStore((s) => s.snapshot?.phase ?? 'idle')
  const live = useStore((s) => s.snapshot?.incident_id === b.id)
  const routes = b.routes
  const testable = routes ? routes.filter((r) => r.status !== 'infeasible').length : 0
  const done = routes ? routes.filter((r) => b.stress[r.id]).length : 0
  const stalled = !live || phase === 'idle'
  const line = stalled ? (routes && testable === 0 ? 'No walkable route to an open shelter' : 'Waiting for the engine to finish this incident')
    : phase === 'simulate' && routes ? `Stress-testing the routes, ${done} of ${testable} done`
    : PHASE_META[phase === 'respond' ? 'respond' : phase as 'detect' | 'assess' | 'simulate'].doing
  const frac = routes && testable ? done / testable : phase === 'assess' ? 0.15 : 0.05
  return (
    <div className="mt-5">
      <h2 className={cn('text-balance text-[22px] font-semibold leading-[1.15] tracking-[-0.02em]', stalled && routes && testable === 0 ? 'text-hazard' : 'text-ink')}>{line}</h2>
      {b.incident.summary && <p className="mt-2 text-[14px] leading-snug text-ink2">{b.incident.summary}</p>}
      {!stalled && (
        <div className="mt-4 h-1 overflow-hidden rounded-[2px] bg-rule" role="progressbar" aria-valuemin={0} aria-valuemax={1} aria-valuenow={frac} aria-label="Planning progress">
          <div className="h-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(0.05, frac) * 100}%` }} />
        </div>
      )}
    </div>
  )
}

function Idle() {
  const hello = useStore((s) => s.hello)
  const crew = useStore((s) => s.snapshot?.crew)
  const conn = useStore((s) => s.conn)
  const t = useStore((s) => s.snapshot?.t ?? 0)
  const started = useStore((s) => !!s.snapshot && !(s.snapshot.clock.paused && s.snapshot.t < 0.5))
  if (!hello) {
    return (
      <div>
        <h2 className="text-[22px] font-semibold leading-[1.15] tracking-[-0.02em] text-ink">{conn === 'offline' ? 'Engine not running' : 'Connecting to the engine'}</h2>
        <p className="mt-2 text-[14px] leading-snug text-ink2">The response shows here as soon as the engine answers.</p>
      </div>
    )
  }
  const next = hello.scenario.find((s) => s.at_s > t)
  return (
    <div>
      <h2 className="flex items-center gap-2.5 text-[22px] font-semibold leading-[1.15] tracking-[-0.02em] text-ink">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-safe" aria-hidden />{started ? 'Walk is nominal' : 'Ready'}
      </h2>
      <p className="mt-2 text-[14px] leading-snug text-ink2">
        {crew?.length ? `${crew.map((c) => c.name ?? `EV${c.id + 1}`).join(' and ')} at ${hello.site.name}. ` : ''}
        No incident. If one is detected, the route to shelter shows here.
      </p>
      {next && <p className="mt-2 text-[12.5px] text-ink3">Next in the script: {next.title} at <span className="num">{missionT(next.at_s)}</span>.{started ? '' : ' Run the demo to play it.'}</p>}
    </div>
  )
}

/** A strip that stays for a few seconds after a new incident. Colour is never the only cue: it carries the word and an icon. */
function AlertStrip({ b }: { b: IncidentBundle }) {
  const alertAt = useStore((s) => s.alertAt)
  const [on, setOn] = useState(false)
  useEffect(() => {
    const left = alertAt + 9000 - Date.now()
    if (left <= 0) { setOn(false); return }
    setOn(true)
    const t = setTimeout(() => setOn(false), left)
    return () => clearTimeout(t)
  }, [alertAt])
  if (!on) return null
  const urgent = b.incident.kind !== 'science'
  return (
    <div role="alert" className={cn('anim-slide -mx-4 -mt-4 mb-4 flex items-center gap-2 px-4 py-2.5 text-[13.5px] font-medium', urgent ? 'bg-hazard text-[#1a0807]' : 'bg-accent text-[#16110a]')}>
      <TriangleAlert size={15} strokeWidth={2.2} />{urgent ? 'Alert' : 'New task'}: {b.incident.title}
    </div>
  )
}

/** The one thing the crew needs from an incident: where to go, how long it takes, and what is left on arrival. */
export function ActionCard({ compact }: { compact?: boolean }) {
  const b = useStore(focusBundle)
  const d = b?.decision
  const route = b?.routes?.find((r) => r.id === d?.route_id)
  return (
    <div className="overflow-hidden px-4 pb-6 pt-4" aria-live="polite">
      <PlanStatus />
      {b?.plan ? <PlannedWalk b={b} compact={compact} /> : b ? (
        <>
          <AlertStrip b={b} />
          <IncidentLine b={b} />
          <div className="mt-3.5"><PhaseSteps /></div>
          {d ? <Decided b={b} d={d} route={route} compact={compact} /> : <Planning b={b} />}
        </>
      ) : <Idle />}
    </div>
  )
}
