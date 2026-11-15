import { useRef } from 'react'
import { ChevronDown, TriangleAlert } from 'lucide-react'
import { focusBundle, store, useStore, type IncidentBundle } from '@/lib/store'
import type { Failure, RouteSummary, Stress } from '@/lib/types'
import { FAIL_LABEL, ROUTE_STYLE } from '@/lib/routeStyle'
import { cn } from '@/lib/utils'
import { dur, logp, num, pct1, splitLabel } from '@/lib/format'
import { sendCmd } from '@/lib/engine'
import { Fig, GroupKind } from '../Kind'
import { Meter } from '../Meter'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { Empty, StatusPill } from './parts'

const PLANNER_SRC = 'Path planner output on the HiRISE DTM (core grid, 5 m cells). A model result, not a measurement.'
const METHOD: Record<string, string> = { 'ppo-ast': 'PPO adversary', cem: 'Cross-entropy adversary', mc: 'Monte Carlo' }
const METHOD_HELP: Record<string, string> = {
  'ppo-ast': 'Adaptive Stress Testing (Lee et al., 2020) with a reinforcement-learning adversary that searches the disturbances for the most likely failure.',
  cem: 'Adaptive Stress Testing (Lee et al., 2020) with the cross-entropy method searching the disturbances for the most likely failure.',
  mc: 'Plain Monte Carlo: random disturbances, no adversarial search. It cannot report robustness.',
}
/** Disturbances the stress test had to push (log p below -0.5). */
const DRIVER_LOGP = -0.5

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="min-w-0">
      <div className="cap">{label}</div>
      <div className="num text-[14px] text-ink">{value}{unit && <span className="ml-0.5 text-[12px] text-ink3">{unit}</span>}</div>
    </div>
  )
}

function StressDetail({ r, st }: { r: RouteSummary; st?: Stress }) {
  if (!st) return <p className="text-[12.5px] text-ink3">{r.status === 'infeasible' ? 'Not stress-tested: it cannot be walked within the limits.' : 'Stress-test result has not arrived yet.'}</p>
  const trained = st.source === 'data/ast'
  const src = trained ? 'trained offline (data/ast)' : 'local preview: a small run by the engine just now'
  return (
    <div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Tooltip>
            <TooltipTrigger asChild><div className="cap cursor-help underline decoration-dotted underline-offset-2" tabIndex={0}>Robustness</div></TooltipTrigger>
            <TooltipContent>Negative log-probability of the most likely failure the search found, in nats. Larger means the failure needs a more extreme combination of disturbances.</TooltipContent>
          </Tooltip>
          {st.robustness_nats === null || st.robustness_nats === undefined
            ? <Tooltip><TooltipTrigger asChild><span tabIndex={0} className="cursor-help text-[13px] text-ink3">not reported</span></TooltipTrigger><TooltipContent>{METHOD_HELP[st.method] ?? 'This method does not report robustness.'}</TooltipContent></Tooltip>
            : <Fig value={st.robustness_nats} unit="nats" kind="model" source={`${METHOD[st.method] ?? st.method}, ${src}`} label={`Route ${r.id} robustness`} valueClassName="text-[16px] font-medium" />}
        </div>
        <div>
          <div className="cap">Failure rate</div>
          {st.mc_fail_rate === null || st.mc_fail_rate === undefined ? <span className="num text-[13px] text-ink3">-</span> : (
            <Fig value={pct1(st.mc_fail_rate)} kind="model" source={`Monte Carlo${st.n ? `, ${st.n.toLocaleString('en-US')} runs` : ''}, ${src}`} label={`Route ${r.id} failure rate`} valueClassName="text-[16px] font-medium" />
          )}
          {st.mc_ci && <div className="num text-[11.5px] text-ink3">{pct1(st.mc_ci[0])} to {pct1(st.mc_ci[1])}{st.n ? ` · n ${st.n.toLocaleString('en-US')}` : ''}</div>}
        </div>
      </div>
      <div className="mt-2 text-[12px] text-ink3">
        <Tooltip><TooltipTrigger asChild><span tabIndex={0} className="cursor-help text-ink2 underline decoration-dotted underline-offset-2">{METHOD[st.method] ?? st.method}</span></TooltipTrigger><TooltipContent>{METHOD_HELP[st.method]}</TooltipContent></Tooltip>
        {' · '}{trained ? 'trained offline' : 'local preview'} · model-based, not crew-tested
      </div>
    </div>
  )
}

function Failures({ list }: { list: Failure[] }) {
  const top = [...list].sort((a, b) => b.log_p - a.log_p).slice(0, 3)
  if (!top.length) return null
  return (
    <div className="mt-3 border-t border-rule pt-3">
      <div className="mb-2 text-[12.5px] text-ink2">Most likely ways this route fails</div>
      <ol className="space-y-2.5">
        {top.map((f, i) => {
          const drivers = (f.events ?? []).filter((ev) => ev.log_p <= DRIVER_LOGP).sort((a, b) => a.log_p - b.log_p).slice(0, 3)
          return (
            <li key={i} className="flex items-start gap-2.5">
              <span className="num mt-[1px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border border-hazard/60 text-[11.5px] text-hazard">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[13px] font-medium text-hazard">{FAIL_LABEL[f.class] ?? f.class}</span>
                  <span className="num whitespace-nowrap text-[11.5px] text-ink3">{dur(f.t)} in · log p {logp(f.log_p)}</span>
                </div>
                {f.summary && <p className="mt-0.5 text-[12.5px] leading-snug text-ink2">{f.summary}</p>}
                {drivers.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {drivers.map((ev, k) => (
                      <Tooltip key={k}>
                        <TooltipTrigger asChild>
                          <span tabIndex={0} className="num cursor-help rounded-[3px] bg-panel3 px-1.5 py-[2px] text-[11.5px] text-ink2">{ev.channel} <span className="text-ink">{num(ev.value, 2)}</span></span>
                        </TooltipTrigger>
                        <TooltipContent>Disturbance pushed by the stress test: {ev.channel} = {num(ev.value, 3)} at {dur(ev.t)} into the walk, log p {logp(ev.log_p)}. Model input, not an observation.</TooltipContent>
                      </Tooltip>
                    ))}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function RouteRow({ r, bundle, open }: { r: RouteSummary; bundle: IncidentBundle; open: boolean }) {
  const st = bundle.stress[r.id]
  const style = ROUTE_STYLE[r.status]
  const li = useRef<HTMLLIElement>(null)
  const reveal = () => requestAnimationFrame(() => li.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
  const fail = st?.mc_fail_rate ?? r.mc_fail_rate
  const { name, variant } = splitLabel(r.label ?? r.shelter)
  const replay = useStore((s) => s.mode === 'replay')
  return (
    <li ref={li} className={cn('border-b border-rule last:border-b-0', r.status === 'infeasible' && 'opacity-60')} data-route={r.id} data-status={r.status}>
      <button type="button" onClick={() => { store.set({ selectedRoute: open ? null : r.id }); if (!open) reveal() }} aria-expanded={open}
        className={cn('card-hover relative flex min-h-[56px] w-full items-center gap-3 py-2.5 pl-4 pr-3 text-left', open && 'bg-panel2')}>
        <span className="num flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-[1.5px] text-[12.5px] text-ink" style={r.status === 'chosen' ? { borderColor: style.color, background: `color-mix(in srgb, ${style.color} 18%, transparent)` } : { borderColor: style.color }}>{r.id}</span>
        <div className="min-w-0 flex-1">
          <div className={cn('truncate text-[14px] font-medium text-ink', r.status === 'rejected' && 'text-ink2')}>{name}{variant && <span className="font-normal text-ink3"> · {variant}</span>}</div>
          <div className="flex items-center gap-2 text-[12px]">
            {r.status === 'rejected' && r.rule_ok !== false
              ? <span className="inline-flex items-center gap-1.5 text-[12px] text-ink3"><span className="h-2 w-2 rounded-full border-[1.5px] border-ink3" />Not chosen</span>
              : <StatusPill status={r.status} />}
            {r.rule_ok === false && <span className="flex items-center gap-1 text-hazard"><TriangleAlert size={12} />misses a rule</span>}
            {r.status === 'testing' && <span className="testing-bar h-[2px] w-10 opacity-80" />}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="num text-[15px] text-ink">{dur(r.time_s)}</div>
          <div className="num text-[12px] text-ink3">{fail === null || fail === undefined ? `${num(r.length_m)} m` : `fails ${pct1(fail)}`}</div>
        </div>
        <ChevronDown size={15} className={cn('shrink-0 text-ink3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="anim-fade bg-panel2 px-4 pb-5 pt-2">
          <div className="grid grid-cols-4 gap-3">
            <Stat label="Length" value={num(r.length_m)} unit="m" />
            <Stat label="Ascent" value={`+${num(r.ascent_m)}`} unit="m" />
            <Stat label="Max slope" value={num(r.max_slope, 1)} unit="°" />
            <Stat label="Dose" value={num(r.dose, 2)} unit="mSv" />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Meter label="Oxygen on arrival" frac={r.o2_margin} source={PLANNER_SRC} />
            <Meter label="Heat margin on arrival" frac={r.heat_margin} source={PLANNER_SRC} />
          </div>
          {r.band_m !== undefined && r.band_m >= 1 && <p className="mt-2 text-[12.5px] text-caution">Crosses {num(r.band_m)} m of the rockfall runout band.</p>}
          {r.nolos_m !== undefined && r.nolos_m >= 1 && <p className="mt-2 text-[12.5px] text-ink2">{num(r.nolos_m)} m without radio line of sight to the habitat or the rover.</p>}
          {r.rule_reasons?.map((why, i) => <p key={i} className="mt-2 flex gap-1.5 text-[12.5px] text-hazard"><TriangleAlert size={13} className="mt-[2px] shrink-0" />Route {why}</p>)}
          <div className="mt-3 border-t border-rule pt-3"><StressDetail r={r} st={st} /></div>
          {st && <Failures list={st.failures} />}
          <div className="mt-3 flex items-center justify-between gap-3">
            {r.status !== 'chosen' && r.status !== 'infeasible' && !replay
              ? <Button variant="outline" size="md" className="tap" onClick={() => { sendCmd({ cmd: 'choose', route_id: r.id }); reveal() }}>Choose route {r.id} instead</Button>
              : <span className="text-[12.5px] text-ink3">{r.status === 'chosen' ? 'The crew is told to take this route.' : ''}</span>}
            <GroupKind kind="model" source={PLANNER_SRC} label={`Route ${r.id} planner figures`} />
          </div>
        </div>
      )}
    </li>
  )
}

export function Routes() {
  const bundle = useStore(focusBundle)
  const selectedRoute = useStore((s) => s.selectedRoute)
  const routes = bundle?.routes
  const done = routes ? routes.filter((r) => bundle!.stress[r.id]).length : 0
  const testable = routes ? routes.filter((r) => r.status !== 'infeasible').length : 0
  // chosen first, then by walking time
  const rank = (r: RouteSummary) => (r.status === 'chosen' ? 0 : r.status === 'infeasible' ? 2 : 1)
  const sorted = routes ? [...routes].sort((a, b) => rank(a) - rank(b) || a.time_s - b.time_s) : []
  return (
    <section>
      {!routes ? (
        <div className="px-4 py-5"><Empty>No routes yet. After an incident the planner proposes one to every open shelter, and virtual crews walk each under disturbances.</Empty></div>
      ) : (
        <>
          <ul>
            {sorted.map((r) => <RouteRow key={r.id} r={r} bundle={bundle!} open={selectedRoute === r.id} />)}
          </ul>
          <p className="border-t border-rule px-4 py-3 text-[12px] text-ink3">{done} of {testable} stress-tested. Model-based, not crew-tested.</p>
        </>
      )}
    </section>
  )
}

