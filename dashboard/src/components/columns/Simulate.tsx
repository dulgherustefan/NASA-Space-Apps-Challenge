import { useRef } from 'react'
import { focusBundle, store, useStore, type IncidentBundle } from '@/lib/store'
import type { Failure, RouteSummary, Stress } from '@/lib/types'
import { FAIL_LABEL, ROUTE_STYLE } from '@/lib/routeStyle'
import { cn } from '@/lib/utils'
import { dur, logp, num, pct, pct1 } from '@/lib/format'
import { sendCmd } from '@/lib/engine'
import { Empty, PhaseColumn, Section } from './PhaseColumn'
import { Fig, GroupKind, KindBadge } from '../Kind'
import { severity } from '../Meter'
import { LearningCurve } from '../LearningCurve'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

const PLANNER_SRC = 'Path planner output on the HiRISE DTM (core grid, 5 m cells). A model result, not a measurement.'

function StatusPill({ status }: { status: RouteSummary['status'] }) {
  const st = ROUTE_STYLE[status]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-wider" style={{ color: st.color }}>
          <span className={cn('h-1.5 w-1.5 rounded-full', status === 'testing' && 'pulse-dot')} style={{ background: status === 'infeasible' || status === 'candidate' ? 'transparent' : st.color, border: status === 'infeasible' || status === 'candidate' ? `1.5px solid ${st.color}` : undefined }} />
          {st.label}
        </span>
      </TooltipTrigger>
      <TooltipContent>{st.hint}</TooltipContent>
    </Tooltip>
  )
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[9px] uppercase tracking-wider text-ink3">{label}</div>
      <div className="num text-[13px] leading-tight text-ink">{value}{unit && <span className="ml-0.5 text-[10px] text-ink3">{unit}</span>}</div>
    </div>
  )
}

function MiniMargin({ label, frac, text }: { label: string; frac: number; text: string }) {
  const sev = severity(frac)
  return (
    <div>
      <div className="mb-0.5 flex items-baseline justify-between"><span className="font-mono text-[9px] uppercase tracking-wider text-ink3">{label}</span><span className="num text-[11px] text-ink">{text}</span></div>
      <div className="h-[3px] overflow-hidden rounded-[1px]" style={{ background: `color-mix(in srgb, ${sev.color} 16%, transparent)` }}>
        <div className="h-full" style={{ width: `${Math.min(1, Math.max(0, frac)) * 100}%`, background: sev.color }} />
      </div>
    </div>
  )
}

const METHOD: Record<string, string> = { 'ppo-ast': 'PPO-AST', cem: 'CEM', mc: 'Monte Carlo' }
const METHOD_HELP: Record<string, string> = {
  'ppo-ast': 'Adaptive Stress Testing with a PPO reinforcement-learning agent searching for the most likely failure.',
  cem: 'Adaptive Stress Testing with the cross-entropy method searching for the most likely failure.',
  mc: 'Plain Monte Carlo: random disturbances only, no adversarial search. It cannot report robustness in nats.',
}

function StressBlock({ r, st }: { r: RouteSummary; st?: Stress }) {
  if (!st) {
    return r.status === 'testing' ? (
      <div className="mt-2.5">
        <div className="mb-1 text-[11.5px] text-accent">Virtual crews are walking this route</div>
        <div className="testing-bar h-[2px] w-full opacity-80" />
      </div>
    ) : (
      <div className="mt-2.5 text-[11.5px] text-ink3">{r.status === 'infeasible' ? 'Not stress-tested: infeasible.' : 'Not stress-tested yet.'}</div>
    )
  }
  const trained = st.source === 'data/ast'
  const srcLabel = trained ? 'trained offline' : st.source || 'local preview'
  const src = trained ? 'Trained offline (data/ast)' : `${st.source || 'Local preview'}: a small run by the engine`
  return (
    <div className="mt-2.5 rule-t pt-2">
      <div className="grid grid-cols-2 gap-x-3">
        <div>
          <div className="font-mono text-[9px] uppercase tracking-wider text-ink3">
            <Tooltip><TooltipTrigger asChild><span className="cursor-help underline decoration-dotted decoration-ink3 underline-offset-2">Robustness</span></TooltipTrigger>
              <TooltipContent>Negative log-probability of the most likely failure the search found, in nats. Larger means the failure needs a more extreme combination of disturbances.</TooltipContent></Tooltip>
          </div>
          {st.robustness_nats === null || st.robustness_nats === undefined
            ? <Tooltip><TooltipTrigger asChild><span tabIndex={0} className="num cursor-help text-[12px] text-ink3">not reported</span></TooltipTrigger><TooltipContent>{METHOD_HELP[st.method] ?? 'This method does not report robustness.'}</TooltipContent></Tooltip>
            : <Fig value={st.robustness_nats} unit="nats" kind="model" source={`${METHOD[st.method] ?? st.method} stress test, ${src}`} label={`Route ${r.id} robustness`} valueClassName="text-[15px] font-medium" />}
        </div>
        <div>
          <div className="font-mono text-[9px] uppercase tracking-wider text-ink3">Failure rate</div>
          {st.mc_fail_rate === null || st.mc_fail_rate === undefined ? <span className="num text-[12px] text-ink3">-</span> : (
            <Fig value={pct1(st.mc_fail_rate)} kind="model" source={`Monte Carlo${st.n ? `, ${st.n.toLocaleString('en-US')} runs` : ''}. ${src}`} label={`Route ${r.id} failure rate`} valueClassName="text-[15px] font-medium" />
          )}
          {st.mc_ci && <div className="num text-[10px] text-ink3">{pct1(st.mc_ci[0])} to {pct1(st.mc_ci[1])}{st.n ? ` · n ${st.n.toLocaleString('en-US')}` : ''}</div>}
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Tooltip><TooltipTrigger asChild><span tabIndex={0} className="cursor-help rounded-[2px] bg-panel3 px-1.5 py-[2px] font-mono text-[9.5px] uppercase tracking-wider text-ink2">{METHOD[st.method] ?? st.method}</span></TooltipTrigger><TooltipContent>{METHOD_HELP[st.method]}</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger asChild>
          <span tabIndex={0} className={cn('cursor-help rounded-[2px] border px-1.5 py-[1px] font-mono text-[9.5px] uppercase tracking-wider', trained ? 'border-k-requirement/40 text-k-requirement' : 'border-dashed border-ink3 text-ink2')}>{srcLabel}</span>
        </TooltipTrigger><TooltipContent>{trained ? 'Result from the offline training run stored in data/ast.' : 'A small Monte Carlo run done by the engine just now. Less reliable than a trained result.'}</TooltipContent></Tooltip>
      </div>
    </div>
  )
}

/** Disturbances that matter: the ones the stress test had to push (log p below -0.5). */
const DRIVER_LOGP = -0.5

function Failures({ list, max = 3 }: { list: Failure[]; max?: number }) {
  const top = [...list].sort((a, b) => b.log_p - a.log_p).slice(0, max)
  if (!top.length) return null
  return (
    <div className="mt-2.5 rule-t pt-2">
      <div className="mb-1.5 flex items-baseline justify-between"><span className="eyebrow !text-ink2">Most likely failures</span><span className="text-[10.5px] text-ink3">log p, higher is likelier</span></div>
      <ol className="space-y-2.5">
        {top.map((f, i) => {
          const drivers = (f.events ?? []).filter((ev) => ev.log_p <= DRIVER_LOGP).sort((a, b) => a.log_p - b.log_p).slice(0, 3)
          return (
            <li key={i} className="anim-rise">
              <div className="flex items-start gap-2">
                <span className="num mt-[1px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-hazard/60 text-[9.5px] text-hazard">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-hazard">{FAIL_LABEL[f.class] ?? f.class}</span>
                    <span className="num whitespace-nowrap text-[10px] text-ink3">{dur(f.t)} into walk · log p {logp(f.log_p)}</span>
                  </div>
                  {f.summary && <p className="mt-0.5 text-[12px] leading-snug text-ink2">{f.summary}</p>}
                  {drivers.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {drivers.map((ev, k) => (
                        <Tooltip key={k}>
                          <TooltipTrigger asChild>
                            <span tabIndex={0} className="num cursor-help rounded-[2px] bg-panel3 px-1.5 py-[1px] text-[10px] text-ink2">
                              {ev.channel} <span className="text-ink">{num(ev.value, 2)}</span> <span className="text-ink3">{logp(ev.log_p)}</span>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>Disturbance pushed by the stress test: {ev.channel} = {num(ev.value, 3)} at {dur(ev.t)} into the walk, log p {logp(ev.log_p)}. Model input, not an observation.</TooltipContent>
                        </Tooltip>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function RouteBlock({ r, bundle, selected }: { r: RouteSummary; bundle: IncidentBundle; selected: boolean }) {
  const st = bundle.stress[r.id]
  const style = ROUTE_STYLE[r.status]
  const dim = r.status === 'infeasible'
  const rejected = r.status === 'rejected'
  const li = useRef<HTMLLIElement>(null)
  // keep the route the operator just opened in view when the rows above it change height
  const reveal = () => requestAnimationFrame(() => li.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
  return (
    <li ref={li} className={cn('relative rule-b last:border-b-0', dim && 'opacity-60')} data-route={r.id} data-status={r.status}>
      <button
        onClick={() => { store.set({ selectedRoute: selected ? null : r.id }); if (!selected) reveal() }}
        className={cn('card-hover block w-full px-2.5 pb-2.5 pt-2 text-left', selected && 'bg-panel2')}
        aria-expanded={selected}
      >
        <span className="absolute inset-y-0 left-0 w-[2px]" style={{ background: selected ? style.color : 'transparent' }} />
        <div className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 truncate text-[13px] font-medium text-ink" title={`Route ${r.id} to ${r.label ?? r.shelter}`}>
            <span className={cn(rejected && 'line-through decoration-hazard/70')}>Route {r.id}</span>
            <span className="font-normal text-ink2"> to {r.label ?? r.shelter}</span>
          </span>
          <StatusPill status={r.status} />
        </div>
        <div className="mt-1.5 grid grid-cols-4 gap-2">
          <Stat label="Length" value={num(r.length_m)} unit="m" />
          <Stat label="Time" value={dur(r.time_s)} />
          <Stat label="Ascent" value={`+${num(r.ascent_m)}`} unit="m" />
          <Stat label="Max slope" value={num(r.max_slope, 1)} unit="°" />
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2.5">
          <MiniMargin label="O2 left" frac={r.o2_margin} text={pct(r.o2_margin)} />
          <MiniMargin label="Heat left" frac={r.heat_margin} text={pct(r.heat_margin)} />
          <div>
            <div className="mb-0.5 flex items-baseline justify-between"><span className="font-mono text-[9px] uppercase tracking-wider text-ink3">Dose</span><span className="num text-[11px] text-ink">{num(r.dose, 2)}<span className="ml-0.5 text-[9px] text-ink3">mSv</span></span></div>
            <div className="flex h-[10px] items-center justify-end"><GroupKind kind="model" source={PLANNER_SRC} label={`Route ${r.id} planner figures (length, time, ascent, slope, margins, dose)`} /></div>
          </div>
        </div>
        <StressBlock r={r} st={st} />
      </button>
      {selected && st && st.failures.length > 0 && <div className="px-2.5 pb-3"><Failures list={st.failures} /></div>}
      {selected && !st && <div className="px-2.5 pb-3 text-[11.5px] text-ink3">Failure modes appear when the stress result arrives.</div>}
      {selected && r.status !== 'chosen' && r.status !== 'infeasible' && (
        <div className="px-2.5 pb-3"><Button variant="outline" size="sm" onClick={() => { sendCmd({ cmd: 'choose', route_id: r.id }); reveal() }}>Choose route {r.id} instead</Button></div>
      )}
    </li>
  )
}

export function SimulateColumn() {
  const bundle = useStore(focusBundle)
  const selectedRoute = useStore((s) => s.selectedRoute)
  const routes = bundle?.routes
  const defaultSel = routes ? (routes.find((r) => r.status === 'chosen') ?? routes.find((r) => bundle!.stress[r.id]) ?? routes[0])?.id : undefined
  const sel = selectedRoute ?? defaultSel
  const done = routes ? routes.filter((r) => bundle!.stress[r.id]).length : 0
  const testable = routes ? routes.filter((r) => r.status !== 'infeasible').length : 0

  return (
    <PhaseColumn phase="simulate">
      <Section title="Candidate routes" first aside={routes ? `${done} of ${testable} stress-tested` : undefined}>
        {!routes ? (
          <Empty title="No routes yet">The path planner finds candidate routes to every open shelter. Virtual crews then walk each one.</Empty>
        ) : (
          <ul className="-mx-3.5 border-y border-rule">
            {routes.map((r) => <RouteBlock key={r.id} r={r} bundle={bundle!} selected={sel === r.id} />)}
          </ul>
        )}
        {routes && (
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-ink3">
            <KindBadge kind="model" source={PLANNER_SRC} label="Route figures" /> <span>All figures on this table come from models, not crew trials.</span>
          </div>
        )}
      </Section>
      <Section title="Learning curve" aside="adversarial search">
        <LearningCurve />
      </Section>
    </PhaseColumn>
  )
}
