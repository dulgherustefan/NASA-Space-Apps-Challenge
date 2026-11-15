import { useState, type ReactNode } from 'react'
import { Activity, Check, ChevronDown, Mountain, Radiation, Wind, type LucideIcon } from 'lucide-react'
import { focusBundle, focusIncidentId, PHASES, store, useStore, type DetailId } from '@/lib/store'
import type { IncidentKind, Phase, RouteStatus } from '@/lib/types'
import { ROUTE_STYLE } from '@/lib/routeStyle'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

export const INCIDENT_ICON: Record<IncidentKind, LucideIcon> = { sep: Radiation, quake: Activity, dust: Wind, science: Mountain }

/** Alert class of an incident. A science target is news, not a danger. */
export const alertClass = (kind: IncidentKind) => (kind === 'science' ? 'advisory' : 'warning')

export const PHASE_META: Record<Exclude<Phase, 'idle'>, { title: string; doing: string }> = {
  detect: { title: 'Detect', doing: 'Incident received' },
  assess: { title: 'Assess', doing: 'Updating the hazard map' },
  simulate: { title: 'Simulate', doing: 'Stress-testing the routes' },
  respond: { title: 'Respond', doing: 'Route chosen' },
}

export type PhaseState = 'active' | 'done' | 'waiting'

export function usePhaseState(phase: Exclude<Phase, 'idle'>): PhaseState {
  const livePhase = useStore((s) => s.snapshot?.phase ?? 'idle')
  const liveId = useStore((s) => s.snapshot?.incident_id ?? null)
  const focusId = useStore(focusIncidentId)
  const reached = useStore((s) => focusBundle(s)?.stageT[phase] !== undefined)
  const isLive = !!liveId && liveId === focusId
  if (isLive && livePhase === phase) return 'active'
  if (isLive && livePhase !== 'idle') return PHASES.indexOf(phase) < PHASES.indexOf(livePhase) ? 'done' : 'waiting'
  return reached ? 'done' : 'waiting'
}

function Step({ phase, last }: { phase: Exclude<Phase, 'idle'>; last: boolean }) {
  const state = usePhaseState(phase)
  return (
    <li data-phase={phase} data-state={state} className={cn('flex items-center gap-1.5', !last && 'flex-1')} aria-current={state === 'active' ? 'step' : undefined}>
      <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors duration-200',
        state === 'active' ? 'pulse-dot bg-solid text-solid' : state === 'done' ? 'bg-panel3 text-ink2' : 'border border-rule2')}>
        {state === 'done' && <Check size={10} strokeWidth={3} />}
      </span>
      <span className={cn('whitespace-nowrap text-[12.5px] transition-colors', state === 'active' ? 'font-semibold text-ink' : state === 'done' ? 'text-ink2' : 'text-ink3')}>{PHASE_META[phase].title}</span>
      {!last && <span className={cn('mx-1 h-px min-w-2 flex-1', state === 'done' ? 'bg-rule2' : 'bg-rule')} />}
    </li>
  )
}

/** Detect, Assess, Simulate, Respond for the incident in focus. */
export function PhaseSteps() {
  return (
    <ol className="flex w-full items-center" aria-label="Response steps">
      {PHASES.map((p, i) => <Step key={p} phase={p} last={i === PHASES.length - 1} />)}
    </ol>
  )
}

/** A group of supporting detail. Closed by default, and opening one closes the other. */
export function Row({ id, title, meta, flag, children }: { id: DetailId; title: string; meta?: ReactNode; flag?: boolean; children: ReactNode }) {
  const open = useStore((s) => s.detail === id)
  return (
    <section className="border-t border-rule" data-detail={id}>
      <h3>
        <button type="button" aria-expanded={open} onClick={() => store.set({ detail: open ? null : id })}
          className={cn('card-hover flex min-h-[48px] w-full items-center gap-2.5 px-4 text-left', open && 'bg-panel2')}>
          <span className="text-[14px] font-semibold text-ink">{title}</span>
          {flag && <span className="h-2 w-2 rounded-full bg-hazard" aria-label="needs attention" />}
          <span className="ml-auto text-[12.5px] text-ink3">{meta}</span>
          <ChevronDown size={15} className={cn('shrink-0 text-ink3 transition-transform duration-200', open && 'rotate-180')} />
        </button>
      </h3>
      {open && <div className="anim-fade">{children}</div>}
    </section>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-[13px] leading-snug text-ink3">{children}</p>
}

/** "Show all" for lists that are useful only now and then. */
export function More({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="mt-1 flex h-9 items-center gap-1 text-[13px] text-ink2 underline decoration-rule2 underline-offset-4 hover:text-ink">
        <ChevronDown size={14} className={cn('transition-transform', open && 'rotate-180')} />{open ? 'Show less' : label}
      </button>
      {open && <div className="anim-fade">{children}</div>}
    </div>
  )
}

export function StatusPill({ status }: { status: RouteStatus }) {
  const st = ROUTE_STYLE[status]
  const hollow = status === 'infeasible' || status === 'candidate'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px]" style={{ color: st.ink }}>
          <span className={cn('h-2 w-2 rounded-full', status === 'testing' && 'pulse-dot')} style={{ background: hollow ? 'transparent' : st.ink, border: hollow ? `1.5px solid ${st.ink}` : undefined }} />
          {st.label}
        </span>
      </TooltipTrigger>
      <TooltipContent>{st.hint}</TooltipContent>
    </Tooltip>
  )
}
