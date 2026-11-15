import { useState } from 'react'
import { Menu as MenuIcon, Pause, Play, RotateCcw, SlidersHorizontal, Volume2, VolumeX } from 'lucide-react'
import { useStore } from '@/lib/store'
import { FALLBACK_PRODUCT } from '@/lib/config'
import { sendCmd } from '@/lib/engine'
import { hm, lightTime } from '@/lib/format'
import { PAGES, hrefFor, usePage } from '@/lib/route'
import { isMuted, setMuted } from '@/lib/alert'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { Menu } from './ui/menu'
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

/** One clock on screen. Daylight and the light time to Earth sit behind it, and under Situation. */
function Clock() {
  const clock = useStore((s) => s.snapshot?.clock)
  const light = useStore((s) => s.snapshot?.light_time_s)
  const daylight = useStore((s) => s.snapshot?.env?.daylight_s)
  const sunSrc = useStore((s) => s.snapshot?.env?.sun_source)
  const dusk = daylight !== undefined && daylight < 3600
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex cursor-help items-baseline gap-2 whitespace-nowrap" tabIndex={0}>
          <span className="hidden text-[12.5px] text-ink3 sm:inline">Sol {clock?.sol ?? '-'}</span>
          <span className="num text-[15px] text-ink">{clock?.lmst ?? '--:--:--'}</span>
          {dusk && <span className="hidden text-[12.5px] text-caution md:inline">{daylight > 0 ? `${hm(daylight)} of daylight` : 'Sun down'}</span>}
        </div>
      </TooltipTrigger>
      <TooltipContent className="w-[300px]">
        <dl className="space-y-2">
          <div><dt className="text-ink3">Local mean solar time at the site</dt><dd className="num text-ink">Sol {clock?.sol ?? '-'} · {clock?.lmst ?? '--:--:--'}</dd></div>
          {daylight !== undefined && <div><dt className="text-ink3">Daylight left</dt><dd className="text-ink"><span className="num">{daylight > 0 ? hm(daylight) : 'Sun down'}</span><span className="text-ink2"> · from the Sun position ({sunSrc ?? 'ephemeris'}), flat horizon. The canyon wall can shade the ground earlier.</span></dd></div>}
          <div><dt className="text-ink3">Earth, one way</dt><dd className="text-ink"><span className="num">{lightTime(light)}</span><span className="text-ink2"> · from JPL Horizons distances. An answer from Earth takes twice this, so the crew decides locally.</span></dd></div>
        </dl>
      </TooltipContent>
    </Tooltip>
  )
}

function ConnDot() {
  const conn = useStore((s) => s.conn)
  const attempts = useStore((s) => s.attempts)
  const hadData = useStore((s) => !!s.hello)
  const replay = useStore((s) => s.mode === 'replay')
  if (replay && conn === 'online') {
    return (
      <Tooltip>
        <TooltipTrigger asChild><span tabIndex={0} className="hidden cursor-help whitespace-nowrap rounded-full bg-panel3 px-2.5 py-1 text-[12px] text-ink2 sm:inline">Recorded run</span></TooltipTrigger>
        <TooltipContent>A recorded run of the scripted demo, played from saved engine messages. No engine is connected, so routes cannot be re-planned here.</TooltipContent>
      </Tooltip>
    )
  }
  const label = conn === 'online' ? 'Engine online' : attempts === 0 ? 'Connecting' : hadData ? 'Reconnecting' : 'Engine offline'
  const color = conn === 'online' ? 'var(--color-safe)' : conn === 'connecting' ? 'var(--color-accent)' : 'var(--color-hazard)'
  return (
    <div className="flex items-center gap-2" role="status" aria-live="polite">
      <span className={cn('h-2 w-2 shrink-0 rounded-full', conn !== 'online' && 'pulse-dot')} style={{ background: color }} />
      <span className={cn('whitespace-nowrap text-[12.5px]', conn === 'online' ? 'sr-only' : 'text-ink')}>{label}</span>
    </div>
  )
}

function Nav({ onNavigate, stacked }: { onNavigate?: () => void; stacked?: boolean }) {
  const page = usePage()
  return (
    <ul className={cn(stacked ? 'space-y-0.5' : 'flex h-full items-stretch gap-6')}>
      {PAGES.map((p) => (
        <li key={p.id} className="flex">
          <a href={hrefFor(p.id)} onClick={onNavigate} aria-current={page === p.id ? 'page' : undefined}
            className={cn('relative flex items-center whitespace-nowrap text-[13.5px] transition-colors', stacked ? 'tap w-full rounded-[6px] px-2.5' : '', page === p.id ? 'font-medium text-ink' : 'text-ink3 hover:text-ink2', stacked && page === p.id && 'bg-panel3')}>
            {p.label}
            {!stacked && <span className={cn('absolute inset-x-0 bottom-0 h-[2px]', page === p.id ? 'bg-accent' : 'bg-transparent')} />}
          </a>
        </li>
      ))}
    </ul>
  )
}

/** Exercise controls. They drive the scripted scenario; a crew display would not carry them. */
function Controls({ close }: { close: () => void }) {
  const scenario = useStore((s) => s.hello?.scenario)
  const speed = useStore((s) => s.snapshot?.clock.speed)
  const paused = useStore((s) => s.snapshot?.clock.paused ?? false)
  const off = useStore((s) => s.conn !== 'online')
  const notStarted = useStore((s) => !!s.snapshot && s.snapshot.clock.paused && s.snapshot.t < 0.5 && s.order.length === 0)
  const [muted, setM] = useState(isMuted)
  const replay = useStore((s) => s.mode === 'replay')
  return (
    <div className="space-y-3">
      <Button variant="quiet" size="md" className="w-full justify-start" disabled={off} onClick={() => { sendCmd({ cmd: 'demo' }); close() }}><Play size={14} />Run the demo from the start</Button>
      <div className="border-t border-rule2 pt-3">
        <div className="cap mb-1.5">Mission clock</div>
        <div className="flex flex-wrap items-center gap-2">
          {notStarted ? (
            <Button size="md" disabled={off} onClick={() => sendCmd({ cmd: 'start' })}><Play size={14} />Start</Button>
          ) : (
            <Button size="md" disabled={off} onClick={() => sendCmd({ cmd: paused ? 'resume' : 'pause' })}>
              {paused ? <><Play size={14} />Resume</> : <><Pause size={14} />Pause</>}
            </Button>
          )}
          <Button size="md" disabled={off} onClick={() => { sendCmd({ cmd: 'reset' }); close() }}><RotateCcw size={14} />Reset</Button>
          {!replay && <ToggleGroup type="single" value={speed ? String(speed) : ''} onValueChange={(v) => v && sendCmd({ cmd: 'speed', value: Number(v) })} aria-label="Clock speed" disabled={off} className="ml-auto">
            {[1, 8, 60].map((v) => <ToggleGroupItem key={v} value={String(v)} className="h-8 px-2.5 text-[12px]">{v}x</ToggleGroupItem>)}
          </ToggleGroup>}
        </div>
      </div>
      {!replay && <div className="border-t border-rule2 pt-3">
        <div className="cap mb-1.5">Fire one scripted incident</div>
        <div className="grid gap-1.5">
          {(scenario ?? []).map((s) => (
            <Button key={s.id} size="md" variant="quiet" className="justify-start" disabled={off} onClick={() => { sendCmd({ cmd: 'trigger', id: s.id }); close() }}>{s.title}</Button>
          ))}
          {!scenario?.length && <span className="text-[12.5px] text-ink3">Waiting for the scenario list from the engine.</span>}
        </div>
      </div>}
      <div className="border-t border-rule2 pt-3">
        <Button size="md" variant="quiet" className="w-full justify-start" aria-pressed={!muted} onClick={() => { setMuted(!muted); setM(!muted) }}>
          {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}Alert sound {muted ? 'off' : 'on'}
        </Button>
      </div>
      <p className="border-t border-rule2 pt-2.5 text-[12px] leading-snug text-ink3">{replay ? 'Recorded run. A live engine also fires single incidents and takes another route on request.' : 'For the exercise only. Scripted incidents are marked as scenario wherever they appear.'}</p>
    </div>
  )
}

/** The one clock control worth a place in the bar: start the scripted run, then pause or resume it. */
function Transport() {
  const off = useStore((s) => s.conn !== 'online')
  const paused = useStore((s) => s.snapshot?.clock.paused ?? false)
  const notStarted = useStore((s) => !s.snapshot || (s.snapshot.clock.paused && s.snapshot.t < 0.5 && s.order.length === 0))
  if (notStarted) {
    return <Button variant="default" size="md" disabled={off} onClick={() => sendCmd({ cmd: 'demo' })}><Play size={13} fill="currentColor" />Run demo</Button>
  }
  return (
    <Button variant="outline" size="md" disabled={off} onClick={() => sendCmd({ cmd: paused ? 'resume' : 'pause' })} aria-label={paused ? 'Resume the mission clock' : 'Pause the mission clock'} className="max-sm:w-9 max-sm:px-0">
      {paused ? <Play size={14} /> : <Pause size={14} />}<span className="max-sm:hidden">{paused ? 'Resume' : 'Pause'}</span>
    </Button>
  )
}

export function Header() {
  const product = useStore((s) => s.hello?.product) ?? FALLBACK_PRODUCT
  const site = useStore((s) => s.hello?.site.name)
  const iconBtn = 'inline-flex h-9 w-9 items-center justify-center rounded-[6px] text-ink2 transition-colors hover:bg-panel3 hover:text-ink'
  return (
    <header className="flex h-[52px] shrink-0 items-center gap-4 border-b border-rule bg-panel px-4 lg:gap-7">
      <a href={hrefFor('console')} className="flex shrink-0 items-center gap-2.5">
        <Mark />
        <span className="text-[16px] font-bold tracking-[-0.01em] text-ink">{product}</span>
        <span className="hidden max-w-[170px] truncate text-[13px] text-ink3 md:inline">{site ?? 'No site loaded'}</span>
      </a>
      <nav className="hidden h-full min-[1120px]:block" aria-label="Pages"><Nav /></nav>
      <div className="ml-auto flex items-center gap-3 lg:gap-4">
        <Clock />
        <ConnDot />
        <div className="flex items-center gap-1">
          <Transport />
          <Menu label="Exercise controls" button={<SlidersHorizontal size={16} />} buttonClassName={iconBtn}>
            {(close) => <Controls close={close} />}
          </Menu>
          <div className="min-[1120px]:hidden">
            <Menu label="Pages" button={<MenuIcon size={17} />} buttonClassName={iconBtn} className="w-[220px] p-1.5">
              {(close) => <Nav stacked onNavigate={close} />}
            </Menu>
          </div>
        </div>
      </div>
    </header>
  )
}
