import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { focusBundle, focusIncidentId, PHASES, useStore } from '@/lib/store'
import type { Phase } from '@/lib/types'
import { cn } from '@/lib/utils'
import { missionT } from '@/lib/format'

export const PHASE_META: Record<Exclude<Phase, 'idle'>, { title: string; blurb: string }> = {
  detect: { title: 'Detect', blurb: 'An incident appears' },
  assess: { title: 'Assess', blurb: 'The hazard map updates' },
  simulate: { title: 'Simulate', blurb: 'Virtual crews walk the routes' },
  respond: { title: 'Respond', blurb: 'Safest route to shelter' },
}
export const COL_FR = [0.95, 1.05, 1.3, 1.0]

export type PhaseState = 'active' | 'done' | 'waiting'

export function usePhaseState(phase: Exclude<Phase, 'idle'>): { state: PhaseState; t?: number } {
  const livePhase = useStore((s) => s.snapshot?.phase ?? 'idle')
  const liveId = useStore((s) => s.snapshot?.incident_id ?? null)
  const focusId = useStore(focusIncidentId)
  const bundle = useStore(focusBundle)
  const isLive = !!liveId && liveId === focusId
  const t = bundle?.stageT[phase]
  if (isLive && livePhase === phase) return { state: 'active', t }
  if (isLive && livePhase !== 'idle') {
    return PHASES.indexOf(phase) < PHASES.indexOf(livePhase) ? { state: 'done', t } : { state: 'waiting' }
  }
  return t !== undefined ? { state: 'done', t } : { state: 'waiting' }
}

export function PhaseColumn({ phase, children }: { phase: Exclude<Phase, 'idle'>; children: ReactNode }) {
  const meta = PHASE_META[phase]
  const { state, t } = usePhaseState(phase)
  const bundle = useStore(focusBundle)
  const active = state === 'active'
  return (
    <section
      data-phase={phase}
      data-state={state}
      className={cn('relative flex min-h-0 min-w-0 flex-col border-r border-rule transition-colors duration-300', active ? 'bg-panel' : 'bg-[#0e1114]')}
    >
      <div className={cn('absolute inset-x-0 top-0 h-[2px] transition-colors duration-300', active ? 'bg-accent' : 'bg-transparent')} />
      <header className="shrink-0 border-b border-rule px-3.5 pb-2.5 pt-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className={cn('text-[15px] font-semibold tracking-tight transition-colors', active ? 'text-accent' : 'text-ink')}>{meta.title}</h2>
          <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider">
            {active && (<><span className="pulse-dot h-1.5 w-1.5 rounded-full bg-accent" /><span className="text-accent">In progress</span></>)}
            {state === 'done' && (<><Check size={11} className="text-ink2" /><span className="num normal-case tracking-normal text-ink3">{t !== undefined ? missionT(t) : 'done'}</span></>)}
            {state === 'waiting' && <span className="text-ink3">Waiting</span>}
          </div>
        </div>
        <div className="mt-0.5 flex min-h-[18px] items-center justify-between gap-2 text-[11.5px] text-ink3">
          <span>{meta.blurb}</span>
          {active && bundle && (
            <span key={bundle.id} className="anim-slide num max-w-[55%] truncate rounded-[2px] border border-accent/40 bg-accent-dim px-1.5 py-[1px] text-[10px] text-accent" title={bundle.incident.title}>
              {bundle.id}
            </span>
          )}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3.5 pb-6">{children}</div>
    </section>
  )
}

export function Section({ title, aside, children, first }: { title: string; aside?: ReactNode; children: ReactNode; first?: boolean }) {
  return (
    <div className={cn(!first && 'mt-1')}>
      <div className="section-h">
        <h3 className="eyebrow !text-ink2">{title}</h3>
        {aside && <div className="text-[11px] text-ink3">{aside}</div>}
      </div>
      {children}
    </div>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-[3px] border border-dashed border-rule2 px-3 py-4">
      <div className="text-[12.5px] text-ink2">{title}</div>
      {children && <div className="mt-1 text-[11.5px] leading-snug text-ink3">{children}</div>}
    </div>
  )
}

/** The loop rail: one chip travels Detect -> Assess -> Simulate -> Respond with the live incident. */
export function LoopRail({ widths }: { widths: number[] }) {
  const phase = useStore((s) => s.snapshot?.phase ?? 'idle')
  const liveId = useStore((s) => s.snapshot?.incident_id ?? null)
  const idx = phase === 'idle' ? -1 : PHASES.indexOf(phase)
  const total = widths.reduce((a, b) => a + b, 0)
  const centers = widths.map((w, i) => ((widths.slice(0, i).reduce((a, b) => a + b, 0) + w / 2) / total) * 100)
  const left = idx >= 0 ? centers[idx] : centers[PHASES.length - 1]
  return (
    <div className="relative h-[22px] shrink-0 border-b border-rule bg-bg" aria-hidden>
      <div className="absolute inset-x-0 top-1/2 h-px bg-rule2" />
      {idx >= 0 && <div className="absolute top-1/2 h-px bg-accent transition-[width] duration-700 ease-out" style={{ left: `${centers[0]}%`, width: `${left - centers[0]}%` }} />}
      {centers.map((c, i) => (
        <span key={i} className={cn('absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full border transition-colors duration-500', i <= idx ? 'border-accent bg-accent' : 'border-rule2 bg-bg')} style={{ left: `${c}%` }} />
      ))}
      {idx >= 0 && liveId && (
        <span className="num absolute top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-[2px] bg-accent px-1.5 py-[1px] text-[10px] font-medium text-[#16110a] transition-[left] duration-700 ease-[cubic-bezier(.3,.7,.2,1)]" style={{ left: `${left}%` }}>
          {liveId}
        </span>
      )}
    </div>
  )
}
