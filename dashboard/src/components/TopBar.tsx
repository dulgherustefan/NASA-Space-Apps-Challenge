import { Pause, Play, RotateCcw, Sparkles } from 'lucide-react'
import { useStore } from '@/lib/store'
import { FALLBACK_PRODUCT } from '@/lib/config'
import { sendCmd } from '@/lib/engine'
import { lightTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

function Mark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
      <circle cx="11" cy="11" r="2.4" fill="var(--color-accent)" />
      <path d="M4.2 11a6.8 6.8 0 0 1 13.6 0" fill="none" stroke="var(--color-accent)" strokeWidth="1.5" strokeLinecap="round" opacity=".75" />
      <path d="M1.4 11a9.6 9.6 0 0 1 19.2 0" fill="none" stroke="var(--color-accent)" strokeWidth="1.5" strokeLinecap="round" opacity=".35" />
    </svg>
  )
}

function Clock() {
  const clock = useStore((s) => s.snapshot?.clock)
  const light = useStore((s) => s.snapshot?.light_time_s)
  const utc = clock?.utc ? clock.utc.slice(11, 19) : '--:--:--'
  return (
    <div className="flex items-stretch gap-3 min-[1600px]:gap-4">
      <div className="min-w-[128px]">
        <div className="eyebrow whitespace-nowrap">Sol <span className="num text-ink">{clock?.sol ?? '-'}</span> · LMST</div>
        <div className="num text-[17px] leading-tight text-ink">{clock?.lmst ?? '--:--:--'}</div>
      </div>
      <div className="min-w-[68px]">
        <div className="eyebrow">UTC</div>
        <div className="num text-[17px] leading-tight text-ink2">{utc}</div>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="min-w-[80px] cursor-help">
            <div className="eyebrow whitespace-nowrap">Earth, one way</div>
            <div className="num text-[17px] leading-tight text-ink2">{lightTime(light)}</div>
          </div>
        </TooltipTrigger>
        <TooltipContent>One-way light time to Earth. Any command from Earth arrives this long after it is sent, so the crew response runs locally.</TooltipContent>
      </Tooltip>
    </div>
  )
}

function ConnPill() {
  const conn = useStore((s) => s.conn)
  const attempts = useStore((s) => s.attempts)
  const hadData = useStore((s) => !!s.hello)
  const label = conn === 'online' ? 'Engine online' : attempts === 0 ? 'Connecting' : hadData ? 'Reconnecting' : 'Engine offline'
  const color = conn === 'online' ? 'var(--color-safe)' : conn === 'connecting' ? 'var(--color-accent)' : 'var(--color-hazard)'
  return (
    <div className="flex items-center gap-2 rounded-[3px] border border-rule2 px-2.5 py-1" role="status" aria-live="polite">
      <span className={cn('h-2 w-2 rounded-full', conn !== 'online' && 'pulse-dot')} style={{ background: color }} />
      <span className="whitespace-nowrap text-[12px] text-ink">{label}</span>
    </div>
  )
}

export function TopBar() {
  const product = useStore((s) => s.hello?.product) ?? FALLBACK_PRODUCT
  const site = useStore((s) => s.hello?.site.name)
  const scenario = useStore((s) => s.hello?.scenario)
  const speed = useStore((s) => s.snapshot?.clock.speed)
  const paused = useStore((s) => s.snapshot?.clock.paused ?? false)
  const conn = useStore((s) => s.conn)
  const off = conn !== 'online'
  // Mission clock has not run yet: offer Start instead of Resume.
  const notStarted = useStore((s) => !!s.snapshot && s.snapshot.clock.paused && s.snapshot.t < 0.5 && s.order.length === 0)

  return (
    <header className="flex h-[52px] shrink-0 items-center gap-3 min-[1600px]:gap-5 border-b border-rule bg-panel px-4">
      <div className="flex min-w-[130px] items-center gap-2.5">
        <Mark />
        <div className="leading-none">
          <div className="font-mono text-[15px] font-semibold uppercase tracking-[0.22em] text-ink">{product}</div>
          <div className="mt-1 max-w-[130px] truncate text-[10.5px] text-ink3">{site ?? 'No site loaded'}</div>
        </div>
      </div>
      <div className="h-7 w-px bg-rule" />
      <Clock />
      <div className="h-7 w-px bg-rule" />
      <div className="flex flex-col gap-1">
        <span className="eyebrow">Speed</span>
        <ToggleGroup type="single" value={speed ? String(speed) : ''} onValueChange={(v) => v && sendCmd({ cmd: 'speed', value: Number(v) })} aria-label="Simulation speed" className="-mt-0.5" disabled={off}>
          {[1, 8, 60].map((v) => <ToggleGroupItem key={v} value={String(v)}>{v}x</ToggleGroupItem>)}
        </ToggleGroup>
      </div>
      <div className="flex items-center gap-1.5">
        <Button variant="default" size="md" disabled={off} onClick={() => sendCmd({ cmd: 'demo' })}><Play size={13} fill="currentColor" />Run demo</Button>
        {notStarted ? (
          <Button variant="outline" size="md" disabled={off} onClick={() => sendCmd({ cmd: 'start' })}><Play size={13} />Start</Button>
        ) : (
          <Button variant="outline" size="md" disabled={off} onClick={() => sendCmd({ cmd: paused ? 'resume' : 'pause' })}>
            {paused ? <><Play size={13} />Resume</> : <><Pause size={13} />Pause</>}
          </Button>
        )}
        <Button variant="outline" size="md" disabled={off} onClick={() => sendCmd({ cmd: 'reset' })}><RotateCcw size={13} />Reset</Button>
      </div>
      <div className="ml-auto flex items-center gap-2 min-[1600px]:gap-3">
        <div className="flex items-center gap-1">
          <span className="eyebrow mr-0.5 hidden min-[1600px]:inline">Trigger</span>
          {(scenario ?? []).map((s) => (
            <Tooltip key={s.id}>
              <TooltipTrigger asChild>
                <Button variant="quiet" size="sm" disabled={off} onClick={() => sendCmd({ cmd: 'trigger', id: s.id })}><Sparkles size={11} className="hidden min-[1600px]:block" />{s.title}</Button>
              </TooltipTrigger>
              <TooltipContent>Fire {s.id} now instead of at its scripted time</TooltipContent>
            </Tooltip>
          ))}
          {!scenario?.length && <span className="text-[11.5px] text-ink3">waiting for the scenario list</span>}
        </div>
        <ConnPill />
      </div>
    </header>
  )
}
