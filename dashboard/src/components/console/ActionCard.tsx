import { useEffect, useState } from 'react'
import { ArrowUp, Check, CircleCheck, ShieldAlert, TriangleAlert } from 'lucide-react'
import { focusBundle, useStore, type IncidentBundle } from '@/lib/store'
import { fileUrl } from '@/lib/config'
import { compass, deadlineOf, walkView, type Deadline, type WalkView } from '@/lib/derive'
import { dur, missionT, num, splitLabel } from '@/lib/format'
import type { Decision, RouteSummary } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Fig, KindBadge } from '../Kind'
import { Meter } from '../Meter'
import { INCIDENT_ICON, More, PHASE_META, PhaseSteps } from './parts'

const MODEL_SRC = 'Engine run-time model (walk physiology and suit model). Not a measurement of a real crew.'

function IncidentLine({ b }: { b: IncidentBundle }) {
  const Icon = INCIDENT_ICON[b.incident.kind]
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <Icon size={16} strokeWidth={1.8} className="shrink-0 text-ink2" />
        <span className="truncate text-[13.5px] font-medium text-ink">{b.incident.title}</span>
        <span className="num hidden shrink-0 text-[11.5px] text-ink3 sm:inline">{missionT(b.incident.t)}</span>
      </div>
      <KindBadge kind={b.incident.scenario ? 'scenario' : 'measured'} label={b.incident.scenario ? 'Scripted incident' : 'Observation'} source={b.incident.source} className="shrink-0" />
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
    <div className="mt-4">
      <div className="relative h-2 rounded-[2px] bg-rule">
        <div className="absolute inset-y-0 left-0 rounded-[2px] transition-[width] duration-500" style={{ width: `${(time_s / span) * 100}%`, background: ok ? 'var(--color-safe)' : 'var(--color-hazard)' }} />
        <div className="absolute -inset-y-1 w-[2px] bg-ink" style={{ left: `${(allowed / span) * 100}%` }} aria-hidden />
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-3 text-[12.5px]">
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
    <div className="mt-4 flex items-center gap-3 border-t border-rule pt-3.5">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-rule2" aria-hidden>
        <ArrowUp size={20} strokeWidth={2.2} className="text-accent transition-transform duration-500" style={{ transform: `rotate(${p.bearing}deg)` }} />
      </span>
      <div className="min-w-0">
        <div className="text-[14px] text-ink">
          Head <span className="num font-medium">{String(Math.round(p.bearing)).padStart(3, '0')}°</span> {compass(p.bearing)}
        </div>
        <div className="cap">
          <span className="num text-ink2">{num(Math.round(p.left_m / 5) * 5)} m</span> to go{p.off_m > 25 ? <span className="text-caution"> · {num(Math.round(p.off_m))} m off the route</span> : ''}
        </div>
      </div>
    </div>
  )
}

/** What the destination looks like from the approach: a render of the terrain model, labelled as such. */
function ArrivalView({ placeId, name }: { placeId: string | undefined; name: string }) {
  const item = useStore((s) => (placeId ? s.pov[placeId] : undefined))
  const [failed, setFailed] = useState(false)
  if (!item || failed) return null
  const path = item.file.includes('/') ? item.file : `data/site/pov/${item.file}`
  return (
    <figure className="mt-4 border-t border-rule pt-3.5">
      <div className="mb-2 text-[12.5px] text-ink2">View on arrival</div>
      <img src={fileUrl(path)} alt={`Rendered view of ${name} from the approach`} loading="lazy" onError={() => setFailed(true)} className="aspect-video w-full rounded-[4px] border border-rule2 object-cover" />
      <figcaption className="mt-1.5 text-[12px] leading-snug text-ink3">{item.caption ?? 'Rendered from the HiRISE elevation model. Colour is approximate; ground detail and rocks are set dressing.'}</figcaption>
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
      <div className="mt-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className={cn('text-[13px] font-medium', tone === 'hazard' ? 'text-hazard' : 'text-safe')}>{lead}</div>
          <div className="text-[24px] font-semibold leading-tight tracking-tight text-ink">{name}</div>
        </div>
        <span className="mt-1 shrink-0 text-right text-[12px] leading-snug text-ink3">Route {d.route_id} · {d.auto === false ? 'operator choice' : 'automatic'}{variant && <><br />{variant}</>}</span>
      </div>

      {walk.phase === 'arrived' ? (
        <div className="mt-3 flex items-center gap-2 text-[15px] text-safe"><CircleCheck size={18} />{sortie ? 'Crew back at the start' : `Crew at ${name}`}</div>
      ) : (
        <div className="mt-2 flex items-baseline gap-2">
          <Fig value={dur(big)} kind="model" source={MODEL_SRC + ' Planner walking time on the chosen route.'} label={walk.phase === 'walking' ? 'Walking time left' : 'Walking time to shelter'}
            valueClassName={cn('font-medium leading-none tracking-tight', compact ? 'text-[44px]' : 'text-[52px]')} />
          <span className="text-[13px] text-ink3">{walk.phase === 'walking' ? 'left' : 'walk'}</span>
        </div>
      )}

      {walk.phase !== 'arrived' && <Budget time_s={d.time_to_shelter_s} deadline={deadline} />}
      {late && deadline.allowed_s === null && route?.rule_reasons?.length ? (
        <p className="mt-2 flex gap-2 text-[12.5px] leading-snug text-hazard"><TriangleAlert size={14} className="mt-[2px] shrink-0" />Route {route.rule_reasons.join('; ')}</p>
      ) : null}
      <Heading walk={walk} />

      <div className="mt-4 border-t border-rule pt-3.5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[12.5px] text-ink2">Left on arrival</span>
          <KindBadge kind="model" source={MODEL_SRC} label="Margins on arrival" />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Meter label="Oxygen" frac={d.margins.o2} source={MODEL_SRC} hint="usable oxygen left on arrival" />
          <Meter label="Heat" frac={d.margins.heat} source={MODEL_SRC} hint="room left before the heat-storage limit on arrival" />
          <div>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="text-[11.5px] text-ink2">Dose</span>
              <Fig value={d.dose_msv ?? route?.dose ?? null} unit="mSv" digits={2} kind="model" source={MODEL_SRC} label="Dose on this walk" />
            </div>
            <div className="text-[11.5px] leading-tight text-ink3">{Math.round(d.margins.dose * 100)}% less than staying in the open</div>
          </div>
        </div>
      </div>

      {walk.phase !== 'arrived' && <ArrivalView placeId={sortie ? (b.incident.kind === 'science' ? 'B' : d.shelter) : d.shelter} name={name} />}

      {!compact && (
        <div className="mt-4 border-t border-rule pt-3.5">
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
    <div className="mt-4">
      <div className={cn('text-[20px] font-semibold leading-tight tracking-tight', stalled && routes && testable === 0 ? 'text-hazard' : 'text-ink')}>{line}</div>
      {b.incident.summary && <p className="mt-1.5 text-[13.5px] leading-snug text-ink2">{b.incident.summary}</p>}
      {!stalled && (
        <div className="mt-4 h-1 overflow-hidden rounded-[2px] bg-rule" role="progressbar" aria-valuemin={0} aria-valuemax={1} aria-valuenow={frac} aria-label="Planning progress">
          <div className="h-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(0.05, frac) * 100}%` }} />
        </div>
      )}
      <p className="mt-3 text-[12.5px] text-ink3">The route appears here as soon as the stress tests are in.</p>
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
        <div className="text-[20px] font-semibold leading-tight tracking-tight text-ink">{conn === 'offline' ? 'Engine not running' : 'Connecting to the engine'}</div>
        <p className="mt-1.5 text-[13.5px] leading-snug text-ink2">The console shows the response as soon as the engine answers.</p>
      </div>
    )
  }
  const next = hello.scenario.find((s) => s.at_s > t)
  return (
    <div>
      <div className="text-[13px] font-medium text-safe">No active incident</div>
      <div className="text-[24px] font-semibold leading-tight tracking-tight text-ink">{started ? 'Walk is nominal' : 'Ready'}</div>
      <p className="mt-1.5 text-[13.5px] leading-snug text-ink2">
        {crew?.length ? `${crew.map((c) => c.name ?? `EV${c.id + 1}`).join(' and ')} at ${hello.site.name}. ` : ''}
        When an incident is detected, the route to shelter and its margins appear here.
      </p>
      {next && <p className="mt-3 text-[12.5px] text-ink3">Scenario script: {next.title} at <span className="num">{missionT(next.at_s)}</span>. Run the demo to play it.</p>}
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
    <div role="alert" className={cn('anim-slide -mx-4 -mt-4 mb-3 flex items-center gap-2 px-4 py-2 text-[13px] font-medium', urgent ? 'bg-hazard text-[#1a0807]' : 'bg-accent text-[#16110a]')}>
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
    <div className="overflow-hidden p-4" aria-live="polite">
      {b ? (
        <>
          <AlertStrip b={b} />
          <IncidentLine b={b} />
          <div className="mt-3"><PhaseSteps /></div>
          {d ? <Decided b={b} d={d} route={route} compact={compact} /> : <Planning b={b} />}
        </>
      ) : <Idle />}
    </div>
  )
}
