import { useState, type ReactNode } from 'react'
import { ArrowUp, Check, CircleCheck, Play, Route, ShieldAlert, TriangleAlert, X } from 'lucide-react'
import { focusBundle, store, useStore, type IncidentBundle } from '@/lib/store'
import { fileUrl } from '@/lib/config'
import { bearingText, deadlineOf, lineTo, progressOn, walkView, type Deadline, type Progress } from '@/lib/derive'
import { acknowledge, closePlan, notStarted, sendCmd } from '@/lib/engine'
import { dur, hm, lightTime, missionT, num, pct, pct1, splitLabel } from '@/lib/format'
import type { Decision, RouteSummary } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Fig, GroupKind } from '../Kind'
import { Meter, severity } from '../Meter'
import { Button } from '../ui/button'
import { Conditions } from './Conditions'
import { CREW_STATUS, Crew, MODEL_SRC, crewBad, crewName, limiting } from './Crew'
import { Routes } from './Routes'
import { Hazard, Places, isCover } from './Situation'
import { INCIDENT_ICON, PHASE_META, PhaseSteps, Row, alertClass } from './parts'

const PLAN_SRC = 'Path planner on the HiRISE elevation model (5 m grid) with the walk model. A model result, not a measurement.'
const H2 = 'text-balance text-[24px] font-bold leading-[1.15] text-ink'

/** A new incident stays announced until someone acknowledges it. The class is written out; colour is the second cue. */
function AlertBand() {
  const inc = useStore((s) => (s.alertId ? s.incidents[s.alertId]?.incident : undefined))
  if (!inc) return null
  const warning = alertClass(inc.kind) === 'warning'
  const Icon = INCIDENT_ICON[inc.kind]
  return (
    <div role="alert" className={cn('anim-slide flex items-center gap-2.5 px-4 py-2.5', warning ? 'bg-hazard text-on-hazard' : 'bg-advisory text-on-advisory')}>
      <Icon size={17} strokeWidth={2.2} className="shrink-0" />
      <span className={cn('shrink-0 text-[12.5px] font-bold tracking-[.06em]', warning && 'alert-flash')}>{warning ? 'WARNING' : 'ADVISORY'}</span>
      <span className="min-w-0 flex-1 truncate text-[14px] font-bold">{inc.title}</span>
      <button type="button" onClick={acknowledge} className="flex h-8 shrink-0 items-center gap-1.5 rounded-[6px] border border-current px-2.5 text-[12.5px] font-bold transition-opacity duration-150 hover:opacity-80">
        {warning ? 'Acknowledge' : 'Dismiss'}<kbd className="font-sans text-[11.5px] font-normal opacity-80">A</kbd>
      </button>
    </div>
  )
}

function IncidentHead({ b }: { b: IncidentBundle }) {
  const Icon = INCIDENT_ICON[b.incident.kind]
  return (
    <div className="flex items-center justify-between gap-3 text-[13px]">
      <div className="flex min-w-0 items-center gap-2">
        <Icon size={16} strokeWidth={1.8} className="shrink-0 text-ink2" />
        <span className="truncate font-bold text-ink">{b.incident.title}</span>
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

/** One of the few figures read at a glance: a caption, then the value. */
function Readout({ label, children, tone }: { label: string; children: ReactNode; tone?: 'hazard' }) {
  return (
    <div className="min-w-0">
      <div className={cn('cap truncate', tone === 'hazard' && 'font-bold text-hazard')}>{label}</div>
      <div className="mt-0.5 flex min-h-[32px] items-baseline gap-1.5 whitespace-nowrap">{children}</div>
    </div>
  )
}
const BIG = 'text-[26px] font-bold leading-none'

/** Distance left on the route and where to turn: the arrow points along the route about 40 m ahead. */
function ToGo({ p }: { p: Progress | null }) {
  if (!p) return <Readout label="To go"><span className={cn('num text-ink3', BIG)}>-</span></Readout>
  return (
    <Readout label={p.off_m > 25 ? `${num(Math.round(p.off_m))} m off the route` : `To go · ${bearingText(p.bearing)}`} tone={p.off_m > 25 ? 'hazard' : undefined}>
      <ArrowUp size={22} strokeWidth={2.6} className="shrink-0 self-center text-accent transition-transform duration-500" style={{ transform: `rotate(${p.bearing}deg)` }} aria-hidden />
      <Fig value={num(Math.round(p.left_m / 5) * 5)} unit="m" kind="model" source={PLAN_SRC + ' Distance left along the chosen route from the crew position.'} label="Distance left on the route" valueClassName={BIG} />
    </Readout>
  )
}

/** Walking time against the time the rule allows, on one bar. */
function Budget({ time_s, deadline }: { time_s: number; deadline: Deadline }) {
  if (deadline.allowed_s === null) return null
  const allowed = deadline.allowed_s
  const ok = allowed - time_s >= 0
  const span = Math.max(allowed, time_s) * 1.04
  return (
    <div className="mt-3" aria-hidden>
      <div className="relative h-1.5 rounded-[1px] bg-rule">
        <div className="absolute inset-y-0 left-0 rounded-[1px] transition-[width] duration-500" style={{ width: `${(time_s / span) * 100}%`, background: ok ? 'var(--color-ink2)' : 'var(--color-hazard)' }} />
        <div className="absolute -inset-y-1 w-[2px] bg-ink" style={{ left: `${(allowed / span) * 100}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[12px] text-ink3"><span>walk <span className="num">{dur(time_s)}</span></span><span>allowed <span className="num">{dur(allowed)}</span></span></div>
    </div>
  )
}

type StepState = 'done' | 'now' | 'next'
/** What to do, in order. The engine knows the walk, so the steps tick by themselves. */
function Steps({ items }: { items: { text: ReactNode; state: StepState }[] }) {
  return (
    <div className="mt-5">
      <ol className="space-y-1.5">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-2.5 text-[13.5px] leading-snug" aria-current={it.state === 'now' ? 'step' : undefined}>
            <span className={cn('num mt-[1px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[11.5px] font-bold',
              it.state === 'done' ? 'bg-panel3 text-ink2' : it.state === 'now' ? 'bg-solid text-on-solid' : 'border border-rule2 text-ink3')}>
              {it.state === 'done' ? <Check size={11} strokeWidth={3} /> : i + 1}
            </span>
            <span className={cn(it.state === 'now' ? 'font-bold text-ink' : it.state === 'done' ? 'text-ink3' : 'text-ink2')}>{it.text}</span>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-[12px] text-ink3">Illustrative steps, not a flight procedure.</p>
    </div>
  )
}

function Decided({ b, d, route }: { b: IncidentBundle; d: Decision; route?: RouteSummary }) {
  const snap = useStore((s) => s.snapshot)
  const routesFile = useStore((s) => s.routesFile)
  const acked = useStore((s) => s.alertId !== b.id)
  const walk = walkView(b, snap, routesFile)
  const deadline = deadlineOf(b)
  const { name, variant } = splitLabel(route?.label ?? d.shelter ?? 'shelter')
  const sortie = b.incident.kind === 'science'
  const lead = sortie
    ? { ready: 'Sortie to', walking: 'On sortie to', arrived: 'Sortie complete:', stopped: 'Stopped on sortie to', none: 'Sortie to' }[walk.phase]
    : { ready: 'Go to', walking: 'On the way to', arrived: 'Arrived at', stopped: 'Stopped on the way to', none: 'Go to' }[walk.phase]
  const late = route?.rule_ok === false
  const bad = walk.phase === 'stopped' || late
  const arrived = walk.phase === 'arrived'
  const left = walk.phase === 'walking' && walk.left_s !== null ? walk.left_s : d.time_to_shelter_s
  const spare = deadline.allowed_s === null ? null : deadline.allowed_s - d.time_to_shelter_s
  const rule = deadline.rule_min ? `${num(deadline.rule_min)} min` : 'rule'
  const moving = walk.phase === 'walking' || arrived
  const frac = walk.progress?.frac ?? 0
  return (
    <div key={`${b.id}:${d.route_id}`} className="anim-rise">
      <h2 className={cn(H2, 'mt-5', bad && 'text-hazard')}>{lead} {name}</h2>
      <p className="mt-1 text-[12.5px] text-ink3">Route {d.route_id}{variant && `, ${variant}`} · {d.auto === false ? 'chosen by the operator' : 'chosen automatically'}</p>

      {arrived ? (
        <div className="mt-4 flex items-start gap-2.5 rounded-[8px] bg-panel2 px-3 py-2.5">
          <CircleCheck size={18} className="mt-[1px] shrink-0 text-safe" />
          <div className="min-w-0 text-[13.5px] leading-snug">
            <div className="font-bold text-ink">{sortie ? 'Crew back at the start' : `Crew under cover at ${name}`}</div>
            {b.incident.kind === 'sep' && <p className="mt-0.5 text-ink2">Stay under cover while the dose rate in the open is above the alert threshold. <span className="text-ink3">Exit cue: an assumption of this display.</span></p>}
          </div>
        </div>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-3 gap-3">
            <Readout label={walk.phase === 'walking' ? 'Walk time left' : 'Walk time'}>
              <Fig value={dur(left)} kind="model" source={MODEL_SRC + ' Planner walking time on the chosen route.'} label={walk.phase === 'walking' ? 'Walking time left' : 'Walking time to shelter'} valueClassName={BIG} />
            </Readout>
            {spare !== null ? (
              <Readout label={spare >= 0 ? `Spare (${rule})` : `Late (${rule})`} tone={spare >= 0 ? undefined : 'hazard'}>
                <Fig value={dur(Math.abs(spare))} kind="model" source="Shelter rule minus the time already used since the alert, minus the walking time" label="Time in hand under the shelter rule" valueClassName={cn(BIG, spare < 0 && 'text-hazard')} />
              </Readout>
            ) : (
              <Readout label="Route length">
                <Fig value={num(route?.length_m)} unit="m" kind="model" source={PLAN_SRC} label="Length of the chosen route" valueClassName={BIG} />
              </Readout>
            )}
            <ToGo p={walk.progress} />
          </div>
          <Budget time_s={d.time_to_shelter_s} deadline={deadline} />
          {late && deadline.allowed_s === null && route?.rule_reasons?.length ? (
            <p className="mt-2 flex gap-2 text-[13px] leading-snug text-hazard"><TriangleAlert size={14} className="mt-[2px] shrink-0" />Route {route.rule_reasons.join('; ')}</p>
          ) : null}
        </>
      )}

      <div className="mt-5 grid grid-cols-3 gap-3">
        <Meter label="Oxygen" frac={d.margins.o2} source={MODEL_SRC} hint="usable oxygen left on arrival" />
        <Meter label="Heat margin" frac={d.margins.heat} source={MODEL_SRC} hint="room left before the heat-storage limit on arrival" />
        <div className="min-w-0">
          <div className="cap">Dose</div>
          <Fig value={d.dose_msv ?? route?.dose ?? null} unit="mSv" digits={2} kind="model" source={MODEL_SRC} label="Dose on this walk" valueClassName="text-[15px] font-bold" />
        </div>
      </div>
      <p className="mt-1.5 text-[12px] leading-snug text-ink3">On arrival, from the walk model.{d.margins.dose > 0.005 ? ` Dose is ${Math.round(d.margins.dose * 100)}% lower than staying in the open.` : ''}</p>

      {!arrived && (
        <Steps items={[
          { text: sortie ? 'Dismiss the advisory' : 'Acknowledge the alert', state: acked ? 'done' : 'now' },
          { text: <>Turn to route {d.route_id}{walk.progress ? <>, bearing <span className="num">{bearingText(walk.progress.bearing)}</span></> : null}</>, state: moving ? 'done' : acked ? 'now' : 'next' },
          { text: <>{sortie ? 'Walk the sortie and return' : `Walk to ${name}`}{moving ? <> · <span className="num">{pct(frac)}</span> done</> : null}</>, state: moving ? 'now' : 'next' },
          ...(sortie ? [] : [{ text: 'Enter cover and report in', state: 'next' as StepState }]),
        ]} />
      )}
    </div>
  )
}

/** A request on its way to the engine, or the reason the engine refused the last one. */
function PlanStatus() {
  const pending = useStore((s) => s.planPending)
  const fail = useStore((s) => s.planFail)
  if (pending) {
    return (
      <div role="status" className="mb-4 flex items-center gap-2.5 rounded-[8px] bg-panel3 px-3 py-2.5 text-[13px] text-ink">
        <span className="pulse-dot h-2 w-2 shrink-0 rounded-full bg-solid text-solid" />
        Planning a walk to <span className="num">e {Math.round(pending.e)}, s {Math.round(pending.s)}</span>
      </div>
    )
  }
  if (fail) {
    return (
      <div role="alert" className="mb-4 flex items-start gap-2.5 rounded-[8px] border border-hazard px-3 py-2.5 text-[13px]">
        <TriangleAlert size={15} className="mt-[2px] shrink-0 text-hazard" />
        <div className="min-w-0 flex-1 leading-snug"><span className="font-bold text-ink">No plan. </span><span className="text-ink2">{fail.reason ?? 'The engine refused the request'}.</span></div>
        <button type="button" aria-label="Dismiss" className="shrink-0 text-ink3 hover:text-ink" onClick={() => store.set({ planFail: null })}><X size={15} /></button>
      </div>
    )
  }
  return null
}

/** A route the operator asked for before a walk. No incident, no rule, and the crew is not sent anywhere. */
function PlannedWalk({ b }: { b: IncidentBundle }) {
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
          <span className="font-bold text-ink">Plan</span>
          <span className="truncate text-[12px] text-ink3">before the walk, no incident</span>
        </div>
        <Button variant="outline" size="sm" className="shrink-0" onClick={closePlan}>Close plan</Button>
      </div>
      <h2 className={cn(H2, 'mt-5', !walkable && 'text-hazard')}>Planned walk to <span className="num">{dest}</span></h2>
      {route && <p className="mt-1 text-[12.5px] text-ink3">From {start === 'Crew position' ? 'the crew position' : start} · route {route.id}{route.label ? `, ${route.label.toLowerCase()}` : ''} · not sent to the crew</p>}

      {route && walkable && (
        <div className="mt-4 grid grid-cols-3 gap-3">
          <Readout label="Walk time"><Fig value={dur(route.time_s)} kind="model" source={PLAN_SRC} label="Walking time of the planned route" valueClassName={BIG} /></Readout>
          <Readout label="Route length"><Fig value={num(route.length_m)} unit="m" kind="model" source={PLAN_SRC} label="Length of the planned route" valueClassName={BIG} /></Readout>
          <ToGo p={progress} />
        </div>
      )}
      {route && !walkable && <p className="mt-3 flex gap-2 text-[14px] leading-snug text-hazard"><TriangleAlert size={15} className="mt-[2px] shrink-0" />The walk model does not reach the destination on this route within its limits.</p>}

      {route && (
        <>
          <div className="mt-5 grid grid-cols-3 gap-3">
            <Meter label="Oxygen" frac={route.o2_margin} source={PLAN_SRC} hint="usable oxygen left on arrival" />
            <Meter label="Heat margin" frac={route.heat_margin} source={PLAN_SRC} hint="room left before the heat-storage limit on arrival" />
            <div className="min-w-0">
              <div className="cap">Dose</div>
              <Fig value={route.dose} unit="mSv" digits={2} kind="model" source={PLAN_SRC} label="Dose on this walk" valueClassName="text-[15px] font-bold" />
            </div>
          </div>
          <p className="mt-1.5 text-[12px] leading-snug text-ink3">On arrival, from the walk model.</p>
          <ul className="mt-4 space-y-1.5 text-[13px] leading-snug text-ink">
            <li><span className="text-ink2">Climbs </span><span className="num">{num(route.ascent_m)} m</span><span className="text-ink2">, steepest slope </span><span className="num">{num(route.max_slope, 1)}°</span></li>
            {st && st.mc_fail_rate !== null && st.mc_fail_rate !== undefined && (
              <li>
                <span className="text-ink2">Fails in </span>
                <Fig value={pct1(st.mc_fail_rate)} kind="model" source={`Monte Carlo, ${st.n ? st.n.toLocaleString('en-US') : 'a small number of'} walks, local preview: a small run by the engine just now`} label="Failure rate of the planned route" />
                <span className="text-ink2"> of {st.n ? st.n.toLocaleString('en-US') : ''} local preview walks{st.mc_ci ? ` (${pct1(st.mc_ci[0])} to ${pct1(st.mc_ci[1])})` : ''}</span>
              </li>
            )}
            {route.nolos_m !== undefined && route.nolos_m >= 1 && <li><span className="num">{num(route.nolos_m)} m</span><span className="text-ink2"> without radio line of sight to the habitat or the rover</span></li>}
            {route.band_m !== undefined && route.band_m >= 1 && <li className="font-bold text-caution">Crosses {num(route.band_m)} m of the rockfall runout band</li>}
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
  const none = stalled && !!routes && testable === 0
  const line = stalled ? (none ? 'No walkable route to an open shelter' : 'Waiting for the engine to finish this incident')
    : phase === 'simulate' && routes ? `Stress-testing the routes, ${done} of ${testable} done`
    : PHASE_META[phase === 'respond' ? 'respond' : phase as 'detect' | 'assess' | 'simulate'].doing
  const frac = routes && testable ? done / testable : phase === 'assess' ? 0.15 : 0.05
  return (
    <div className="mt-5">
      <h2 className={cn(H2, 'text-[22px]', none && 'text-hazard')}>{line}</h2>
      {b.incident.summary && <p className="mt-2 text-[14px] leading-snug text-ink2">{b.incident.summary}</p>}
      {!stalled && (
        <div className="mt-4 h-1 overflow-hidden rounded-[1px] bg-rule" role="progressbar" aria-valuemin={0} aria-valuemax={1} aria-valuenow={frac} aria-label="Planning progress">
          <div className="h-full bg-solid transition-[width] duration-500" style={{ width: `${Math.max(0.05, frac) * 100}%` }} />
        </div>
      )}
      <p className="mt-3 text-[13px] text-ink2">Hold position until a route is chosen. <span className="text-ink3">The route shows here in a few seconds.</span></p>
    </div>
  )
}

/** One line of the watch list: what is watched, its value now, and what it is compared with. */
function Watch({ label, children, note }: { label: string; children: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[7px]">
      <dt className="min-w-0 text-[13px] text-ink2">{label}{note && <span className="block text-[12px] text-ink3">{note}</span>}</dt>
      <dd className="shrink-0">{children}</dd>
    </div>
  )
}

/** No incident: who is out, the nearest cover, and the few values that would start a response. */
function Standby() {
  const hello = useStore((s) => s.hello)
  const crew = useStore((s) => s.snapshot?.crew)
  const conn = useStore((s) => s.conn)
  const fresh = useStore(notStarted)
  const live = useStore((s) => s.mode === 'live')
  const sensors = useStore((s) => s.snapshot?.sensors)
  const daylight = useStore((s) => s.snapshot?.env?.daylight_s)
  const sunSrc = useStore((s) => s.snapshot?.env?.sun_source)
  const light = useStore((s) => s.snapshot?.light_time_s)
  const params = useStore((s) => s.params.items)
  const planMode = useStore((s) => s.planMode)
  if (!hello) {
    return (
      <div>
        <h2 className={cn(H2, 'text-[22px]')}>{conn === 'offline' ? 'Engine not running' : 'Connecting to the engine'}</h2>
        <p className="mt-2 text-[14px] leading-snug text-ink2">The display fills in as soon as the engine answers.</p>
      </div>
    )
  }
  const lead = crew?.[0]
  const cover = lead ? (hello.places ?? []).filter((p) => isCover(p.kind)).map((p) => ({ p, ...lineTo(lead.e, lead.s, p.e, p.s) })).sort((a, b) => a.dist_m - b.dist_m)[0] : undefined
  const gcr = params.find((p) => p.key === 'gcrRate')
  const pctUp = params.find((p) => p.key === 'nowcastPct')
  const threshold = gcr && pctUp ? gcr.value * (1 + pctUp.value / 100) : null
  const rate = sensors?.dose_rate_open ?? sensors?.dose_rate
  return (
    <div>
      <h2 className={cn(H2, 'flex items-center gap-2.5')}>
        <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-safe" aria-hidden />{fresh ? 'Ready' : 'Standing by'}
      </h2>
      <p className="mt-1.5 text-[13.5px] leading-snug text-ink2">No incident at {hello.site.name}. If one is detected, the route to cover shows here.</p>

      {!!crew?.length && (
        <ul className="mt-4 border-y border-rule">
          {crew.map((c) => {
            const lim = limiting(c)
            const sev = severity(lim.frac)
            return (
              <li key={c.id} className="border-b border-rule last:border-b-0">
                <button type="button" onClick={() => store.set({ detail: 'crew' })} className="card-hover -mx-2 flex min-h-[44px] w-[calc(100%+16px)] items-center gap-3 rounded-[4px] px-2 text-left">
                  <span className="text-[14px] font-bold text-ink">{crewName(c)}</span>
                  <span className={cn('text-[12.5px]', crewBad(c) ? 'font-bold text-hazard' : 'text-ink3')}>{CREW_STATUS[c.status] ?? `status ${c.status}`}</span>
                  <span className="ml-auto text-[12.5px] text-ink3">{lim.label}</span>
                  <span className={cn('num text-[14px] font-bold', sev.name === 'critical' ? 'text-hazard' : sev.name === 'low' ? 'text-caution' : 'text-ink')}>{pct(lim.frac)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {cover && (
        <button type="button" onClick={() => store.set({ selectedPlace: cover.p.id })} className="card-hover -mx-2 mt-1 flex min-h-[52px] w-[calc(100%+16px)] items-center gap-3 rounded-[4px] px-2 text-left">
          <span className="min-w-0 flex-1">
            <span className="cap block">Nearest cover</span>
            <span className="block truncate text-[14px] font-bold text-ink">{cover.p.name}</span>
          </span>
          <span className="shrink-0 text-right">
            <span className="num block text-[14px] font-bold text-ink">{num(Math.round(cover.dist_m / 10) * 10)} m</span>
            <span className="num block text-[12px] text-ink3">{bearingText(cover.bearing)} · straight line</span>
          </span>
        </button>
      )}

      <dl className="mt-3 divide-y divide-rule border-y border-rule">
        <Watch label="Dose rate in the open" note={threshold !== null ? <>alert at <span className="num">{num(threshold, 1)}</span> µGy/h</> : undefined}>
          <Fig value={rate} unit="µGy/h" digits={1} kind="scenario" source={`Dose rate produced by the engine for this scenario, not an instrument reading.${threshold !== null ? ` Alert threshold: ${pctUp!.value}% above the background of ${gcr!.value} µGy/h (${pctUp!.source ?? 'Loewe et al. 2025'}, simplified).` : ''}`} label="Dose rate in the open" valueClassName="text-[15px] font-bold" />
        </Watch>
        <Watch label="Ground motion">
          <Fig value={sensors?.seismic} unit="m/s²" digits={3} kind="scenario" source="Ground motion produced by the engine for this scenario, not an instrument reading." label="Ground motion" valueClassName="text-[15px] font-bold" />
        </Watch>
        <Watch label="Daylight left">
          <Fig value={daylight === undefined ? null : daylight > 0 ? hm(daylight, true) : 'Sun down'} kind="model" source={`${sunSrc ?? 'Sun position'}. Flat horizon: the canyon wall can shade the ground earlier.`} label="Daylight left" valueClassName={cn('text-[15px] font-bold', daylight !== undefined && daylight < 3600 && 'text-caution')} />
        </Watch>
        <Watch label="Answer from Earth" note="there and back, so the crew decides locally">
          <Fig value={light === undefined ? null : lightTime(light * 2)} kind="model" source="Twice the one-way light time to Earth, from JPL Horizons distances." label="Round trip to Earth" valueClassName="text-[15px] font-bold" />
        </Watch>
      </dl>

      <div className="mt-4 flex flex-wrap gap-2">
        {live && <Button variant={planMode ? 'default' : 'outline'} size="lg" disabled={conn !== 'online'} aria-pressed={planMode} onClick={() => store.set((s) => ({ planMode: !s.planMode, selectedPlace: null }))}><Route size={15} />{planMode ? 'Click the map' : 'Plan a walk'}</Button>}
        {fresh && <Button variant={live ? 'outline' : 'default'} size="lg" disabled={conn !== 'online'} onClick={() => sendCmd({ cmd: live ? 'demo' : 'resume' })}><Play size={14} fill="currentColor" />Play demo scenario</Button>}
      </div>
    </div>
  )
}

/** The one thing the crew needs: what state the walk is in, where to go, how long it takes, what is left on arrival. */
export function Panel() {
  const b = useStore(focusBundle)
  const d = b?.decision
  const route = b?.routes?.find((r) => r.id === d?.route_id)
  return (
    <div aria-live="polite">
      <AlertBand />
      <div className="px-4 pb-5 pt-4">
        <PlanStatus />
        {b?.plan ? <PlannedWalk b={b} /> : b ? (
          <>
            <IncidentHead b={b} />
            <div className="mt-3.5"><PhaseSteps /></div>
            {d ? <Decided b={b} d={d} route={route} /> : <Planning b={b} />}
          </>
        ) : <Standby />}
      </div>
    </div>
  )
}

function Why({ d }: { d: Decision }) {
  return (
    <ul className="space-y-1.5 px-4 pb-4 pt-1">
      {d.reasons.map((r, i) => (
        <li key={i} className="flex gap-2 text-[13px] leading-snug text-ink"><Check size={14} className="mt-[2px] shrink-0 text-ink3" />{r}</li>
      ))}
      {d.avoided.map((a, i) => (
        <li key={`a${i}`} className="flex gap-2">
          <ShieldAlert size={14} className="mt-[2px] shrink-0 text-hazard" strokeWidth={1.8} />
          <div className="min-w-0 text-[13px] leading-snug"><span className="text-ink2">Avoids: </span><span className="text-ink">{a.label}</span>{a.detail && <span className="text-ink3"> · {a.detail}</span>}</div>
        </li>
      ))}
    </ul>
  )
}

/** What the destination looks like from the approach: a render of the terrain model, labelled as such. */
function ArrivalView({ placeId, name }: { placeId: string; name: string }) {
  const item = useStore((s) => s.pov[placeId])
  const [failed, setFailed] = useState(false)
  const path = item ? (item.file.includes('/') ? item.file : `data/site/pov/${item.file}`) : ''
  if (!item || failed || !fileUrl(path)) return <p className="px-4 pb-4 pt-1 text-[13px] text-ink3">No rendered view for this destination.</p>
  return (
    <figure className="px-4 pb-4 pt-1">
      <img src={fileUrl(path)} alt={`Rendered view of ${name} from the approach`} loading="lazy" onError={() => setFailed(true)} className="aspect-[21/9] w-full rounded-[6px] object-cover" />
      <figcaption className="mt-1.5 text-[12px] leading-snug text-ink3">{item.caption ?? 'Rendered from the HiRISE elevation model. Colour is approximate; ground detail and rocks are set dressing.'}</figcaption>
    </figure>
  )
}

/** Everything behind the state above, one group open at a time. */
export function Details() {
  const b = useStore(focusBundle)
  const crew = useStore((s) => s.snapshot?.crew)
  const daylight = useStore((s) => s.snapshot?.env?.daylight_s)
  const hasPov = useStore((s) => Object.keys(s.pov).length > 0)
  const nPlaces = useStore((s) => s.hello?.places?.length ?? 0)
  const d = b?.decision
  const route = b?.routes?.find((r) => r.id === d?.route_id)
  const crewAlert = !!crew?.some(crewBad)
  const worst = crew?.length ? crew.map(limiting).sort((x, y) => x.frac - y.frac)[0] : null
  const shelters = b?.assessment?.shelters
  const sortie = b?.incident.kind === 'science'
  const viewId = d ? (sortie ? 'B' : d.shelter) : undefined
  const a = b?.assessment
  return (
    <div className="border-b border-rule">
      {d && <Row id="why" title="Why this route" meta={`${d.reasons.length + d.avoided.length} points`}><Why d={d} /></Row>}
      {b && <Row id="routes" title={b.plan ? 'Planned routes' : 'Routes compared'} meta={b.routes ? `${b.routes.length}` : 'planning'}><Routes /></Row>}
      <Row id="crew" title="Crew and suits" flag={crewAlert} meta={worst ? `lowest: ${worst.label.toLowerCase()} ${pct(worst.frac)}` : undefined}><Crew /></Row>
      {b && <Row id="hazard" title={b.plan ? 'Plan assumptions' : 'Detection and hazard'} meta={b.plan ? undefined : a ? `${a.changes.length} changes` : 'assessing'}><Hazard /></Row>}
      <Row id="places" title="Cover and places" meta={shelters?.length ? `${shelters.filter((s) => s.open).length} of ${shelters.length} open` : nPlaces ? `${nPlaces}` : undefined}><Places /></Row>
      <Row id="conditions" title="Conditions" meta={daylight === undefined ? undefined : daylight > 0 ? `${hm(daylight, true)} of daylight` : 'Sun down'}><Conditions /></Row>
      {d && viewId && hasPov && <Row id="view" title="View on arrival" meta="render"><ArrivalView placeId={viewId} name={splitLabel(route?.label ?? d.shelter ?? 'shelter').name} /></Row>}
    </div>
  )
}
