import { useState, type ReactNode } from 'react'
import { Activity, Check, ChevronDown, Mountain, Radiation, Wind, type LucideIcon } from 'lucide-react'
import { focusBundle, focusIncidentId, PHASES, useStore } from '@/lib/store'
import type { IncidentKind, Phase, RouteStatus } from '@/lib/types'
import { ROUTE_STYLE } from '@/lib/routeStyle'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

export const INCIDENT_ICON: Record<IncidentKind, LucideIcon> = { sep: Radiation, quake: Activity, dust: Wind, science: Mountain }

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
      <span className={cn('flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border transition-colors duration-300',
        state === 'active' ? 'pulse-dot border-accent bg-accent text-[#16110a]' : state === 'done' ? 'border-ink3 text-ink2' : 'border-rule2 text-transparent')}>
        {state === 'done' ? <Check size={11} strokeWidth={2.5} /> : <span className={cn('h-1.5 w-1.5 rounded-full', state === 'active' ? 'bg-[#16110a]' : 'bg-rule2')} />}
      </span>
      <span className={cn('whitespace-nowrap text-[12.5px] transition-colors', state === 'active' ? 'font-medium text-accent' : state === 'done' ? 'text-ink2' : 'text-ink3')}>{PHASE_META[phase].title}</span>
      {!last && <span className={cn('mx-1 h-px min-w-2 flex-1', state === 'done' ? 'bg-ink3' : 'bg-rule2')} />}
    </li>
  )
}

/** Detect, Assess, Simulate, Respond for the incident in focus. */
export function PhaseSteps() {
  return (
    <ol className="flex w-full max-w-[420px] items-center" aria-label="Response steps">
      {PHASES.map((p, i) => <Step key={p} phase={p} last={i === PHASES.length - 1} />)}
    </ol>
  )
}

export function Section({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('border-t border-rule px-4 py-4', className)}>
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-semibold tracking-tight text-ink">{title}</h3>
        {aside && <div className="text-[12px] text-ink3">{aside}</div>}
      </div>
      {children}
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
        className="mt-1 flex h-8 items-center gap-1 text-[12.5px] text-ink2 hover:text-ink">
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
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px]" style={{ color: st.color }}>
          <span className={cn('h-2 w-2 rounded-full', status === 'testing' && 'pulse-dot')} style={{ background: hollow ? 'transparent' : st.color, border: hollow ? `1.5px solid ${st.color}` : undefined }} />
          {st.label}
        </span>
      </TooltipTrigger>
      <TooltipContent>{st.hint}</TooltipContent>
    </Tooltip>
  )
}
