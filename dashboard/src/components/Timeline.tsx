import { useRef } from 'react'
import { Pause, Play } from 'lucide-react'
import { focusIncidentId, store, useStore } from '@/lib/store'
import { isRunning, notStarted, sendCmd, togglePlay } from '@/lib/engine'
import { replaySeek } from '@/lib/replay'
import { missionT } from '@/lib/format'
import { cn } from '@/lib/utils'
import { INCIDENT_ICON } from './console/parts'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

function PlayButton() {
  const fresh = useStore(notStarted)
  const running = useStore(isRunning)
  const off = useStore((s) => s.conn !== 'online')
  const label = fresh ? 'Play demo' : running ? 'Pause' : 'Resume'
  return (
    <button type="button" onClick={togglePlay} disabled={off} aria-label={`${label} (Space)`}
      className={cn('flex h-9 shrink-0 items-center gap-1.5 rounded-[6px] px-3 text-[13px] font-semibold transition-colors duration-150 disabled:opacity-40',
        'border border-rule2 text-ink hover:bg-panel3')}>
      {running ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}{label}
    </button>
  )
}

/** A recorded run: drag to any second, or jump to an incident and play from there. */
function Scrubber() {
  const replay = useStore((s) => s.replay)!
  const track = useRef<HTMLDivElement>(null)
  const last = useRef(0)
  const at = (clientX: number) => {
    const r = track.current!.getBoundingClientRect()
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * replay.dur
  }
  const seek = (t: number, force = false) => {
    const now = performance.now()
    if (!force && now - last.current < 100) return
    last.current = now
    replaySeek(t)
  }
  const frac = replay.dur ? replay.pos / replay.dur : 0
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <div ref={track} role="slider" tabIndex={0} aria-label="Position in the recorded run" aria-valuemin={0} aria-valuemax={Math.round(replay.dur)} aria-valuenow={Math.round(replay.pos)} aria-valuetext={`${clock(replay.pos)} of ${clock(replay.dur)}`}
        className="group relative h-9 min-w-0 flex-1 cursor-pointer touch-none"
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); seek(at(e.clientX), true) }}
        onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) seek(at(e.clientX)) }}
        onPointerUp={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) { e.currentTarget.releasePointerCapture(e.pointerId); seek(at(e.clientX), true) } }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') { e.preventDefault(); seek(replay.pos + 5, true) }
          else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(replay.pos - 5, true) }
          else if (e.key === 'Home') { e.preventDefault(); seek(0, true) }
        }}>
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-rule2" />
        <div className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-ink" style={{ width: `${frac * 100}%` }} />
        <div className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-panel bg-ink transition-transform duration-150 group-hover:scale-125" style={{ left: `${frac * 100}%` }} />
        {replay.marks.map((m) => {
          const Icon = INCIDENT_ICON[m.kind]
          const past = replay.pos >= m.at
          return (
            <Tooltip key={m.id}>
              <TooltipTrigger asChild>
                <button type="button" aria-label={`Play from: ${m.title}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); replaySeek(Math.max(0, m.at - 0.4)); sendCmd({ cmd: 'resume' }) }}
                  className={cn('absolute top-1/2 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-panel transition-colors duration-150 hover:border-ink hover:text-ink',
                    past ? 'border-ink text-ink' : 'border-rule2 text-ink3')}
                  style={{ left: `${(m.at / replay.dur) * 100}%` }}>
                  <Icon size={13} strokeWidth={2} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{m.title}. Click to play from here.</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
      <Tooltip>
        <TooltipTrigger asChild><span tabIndex={0} className="num hidden shrink-0 cursor-help text-[12.5px] text-ink2 sm:inline">{clock(replay.pos)} / {clock(replay.dur)}</span></TooltipTrigger>
        <TooltipContent side="top">Time in the recording. The mission clock in the header runs faster between incidents.</TooltipContent>
      </Tooltip>
    </div>
  )
}

/** A live engine: the scripted incidents of the exercise in order. One that has fired can be opened again. */
function Program() {
  const scenario = useStore((s) => s.hello?.scenario)
  const order = useStore((s) => s.order)
  const focus = useStore(focusIncidentId)
  const liveId = useStore((s) => s.snapshot?.incident_id ?? null)
  if (!scenario?.length) return <span className="text-[12.5px] text-ink3">No scripted incidents</span>
  return (
    <ol className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" aria-label="Scripted incidents">
      <li className="mr-1 hidden shrink-0 text-[12px] text-ink3 xl:block" aria-hidden>Scenario</li>
      {scenario.map((it, i) => {
        const Icon = INCIDENT_ICON[it.kind]
        const fired = order.includes(it.id)
        const on = fired && focus === it.id
        return (
          <li key={it.id} className="flex min-w-0 items-center gap-1">
            {i > 0 && <span className={cn('h-px w-3 shrink-0 sm:w-5', fired ? 'bg-ink3' : 'bg-rule2')} aria-hidden />}
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" disabled={!fired} aria-pressed={on}
                  onClick={() => store.set({ focusId: it.id === liveId ? null : it.id, selectedRoute: null })}
                  className={cn('flex h-8 min-w-0 items-center gap-1.5 rounded-[6px] border px-2 text-[12.5px] transition-colors duration-150',
                    on ? 'border-accent bg-accent-dim font-semibold text-ink' : fired ? 'border-rule2 text-ink hover:bg-panel3' : 'border-transparent text-ink3')}>
                  <Icon size={13} strokeWidth={2} className="shrink-0" />
                  <span className="hidden truncate lg:inline">{it.title}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{it.title}. {fired ? 'Click to look at this incident again.' : `Scripted for ${missionT(it.at_s)}.`}</TooltipContent>
            </Tooltip>
          </li>
        )
      })}
    </ol>
  )
}

/** One bar under the map: run the exercise, see where in it we are, go back to an earlier incident. */
export function Timeline() {
  const replay = useStore((s) => !!s.replay)
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <PlayButton />
      {replay ? <Scrubber /> : <Program />}
    </div>
  )
}
