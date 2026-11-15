import { Menu as MenuIcon, Pause, Play, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { useStore } from '@/lib/store'
import { FALLBACK_PRODUCT } from '@/lib/config'
import { sendCmd } from '@/lib/engine'
import { hm, lightTime } from '@/lib/format'
import { PAGES, hrefFor, usePage } from '@/lib/route'
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

function Clock() {
  const clock = useStore((s) => s.snapshot?.clock)
  const light = useStore((s) => s.snapshot?.light_time_s)
  const daylight = useStore((s) => s.snapshot?.env?.daylight_s)
  const sunSrc = useStore((s) => s.snapshot?.env?.sun_source)
  return (
    <div className="flex items-center gap-5">
      <div>
        <div className="cap whitespace-nowrap">Sol {clock?.sol ?? '-'} · local time</div>
        <div className="num text-[17px] leading-tight text-ink">{clock?.lmst ?? '--:--:--'}</div>
      </div>
      {daylight !== undefined && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="hidden cursor-help md:block" tabIndex={0}>
              <div className="cap whitespace-nowrap">Daylight left</div>
              <div className={cn('num text-[17px] leading-tight', daylight > 0 && daylight < 3600 ? 'text-caution' : 'text-ink2')}>{daylight > 0 ? hm(daylight) : 'Sun down'}</div>
            </div>
          </TooltipTrigger>
          <TooltipContent>Time to sunset at the site, computed from the Sun position ({sunSrc ?? 'ephemeris'}). Flat horizon; the canyon wall can shade the ground earlier.</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="hidden cursor-help sm:block" tabIndex={0}>
            <div className="cap whitespace-nowrap">Earth, one way</div>
            <div className="num text-[17px] leading-tight text-ink2">{lightTime(light)}</div>
          </div>
        </TooltipTrigger>
        <TooltipContent>One-way light time to Earth, from JPL Horizons distances. A question to Earth and its answer take twice this, so the crew decides locally.</TooltipContent>
      </Tooltip>
    </div>
  )
}

function ConnDot() {
  const conn = useStore((s) => s.conn)
  const attempts = useStore((s) => s.attempts)
  const hadData = useStore((s) => !!s.hello)
  const label = conn === 'online' ? 'Engine online' : attempts === 0 ? 'Connecting' : hadData ? 'Reconnecting' : 'Engine offline'
  const color = conn === 'online' ? 'var(--color-safe)' : conn === 'connecting' ? 'var(--color-accent)' : 'var(--color-hazard)'
  return (
    <div className="flex items-center gap-2" role="status" aria-live="polite">
      <span className={cn('h-2 w-2 shrink-0 rounded-full', conn !== 'online' && 'pulse-dot')} style={{ background: color }} />
      <span className={cn('whitespace-nowrap text-[12.5px]', conn === 'online' ? 'hidden text-ink3 2xl:inline' : 'text-ink')}>{label}</span>
    </div>
  )
}

function Nav({ onNavigate, stacked }: { onNavigate?: () => void; stacked?: boolean }) {
  const page = usePage()
  return (
    <ul className={cn(stacked ? 'space-y-0.5' : 'flex h-full items-stretch gap-5')}>
      {PAGES.map((p) => (
        <li key={p.id} className="flex">
          <a href={hrefFor(p.id)} onClick={onNavigate} aria-current={page === p.id ? 'page' : undefined}
            className={cn('relative flex items-center whitespace-nowrap text-[13px] transition-colors', stacked ? 'tap w-full rounded-[4px] px-2.5' : '', page === p.id ? 'text-ink' : 'text-ink3 hover:text-ink2', stacked && page === p.id && 'bg-panel3')}>
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
  return (
    <div className="space-y-3">
      <div>
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
          <ToggleGroup type="single" value={speed ? String(speed) : ''} onValueChange={(v) => v && sendCmd({ cmd: 'speed', value: Number(v) })} aria-label="Clock speed" disabled={off} className="ml-auto">
            {[1, 8, 60].map((v) => <ToggleGroupItem key={v} value={String(v)} className="h-8 px-2.5 text-[12px]">{v}x</ToggleGroupItem>)}
          </ToggleGroup>
        </div>
      </div>
      <div className="border-t border-rule2 pt-3">
        <div className="cap mb-1.5">Fire a scripted incident now</div>
        <div className="grid gap-1.5">
          {(scenario ?? []).map((s) => (
            <Button key={s.id} size="md" variant="quiet" className="justify-start" disabled={off} onClick={() => { sendCmd({ cmd: 'trigger', id: s.id }); close() }}>{s.title}</Button>
          ))}
          {!scenario?.length && <span className="text-[12.5px] text-ink3">Waiting for the scenario list from the engine.</span>}
        </div>
      </div>
      <p className="border-t border-rule2 pt-2.5 text-[12px] leading-snug text-ink3">Exercise controls. Incidents are scripted and marked as scenario wherever they appear.</p>
    </div>
  )
}

export function Header() {
  const product = useStore((s) => s.hello?.product) ?? FALLBACK_PRODUCT
  const site = useStore((s) => s.hello?.site.name)
  const off = useStore((s) => s.conn !== 'online')
  return (
    <header className="flex h-[56px] shrink-0 items-center gap-4 border-b border-rule bg-panel px-4 lg:gap-6">
      <a href={hrefFor('console')} className="flex shrink-0 items-center gap-2.5">
        <Mark />
        <div className="leading-none">
          <div className="font-mono text-[15px] font-semibold uppercase tracking-[0.2em] text-ink">{product}</div>
          <div className="mt-1 hidden max-w-[150px] truncate text-[11.5px] text-ink3 sm:block">{site ?? 'No site loaded'}</div>
        </div>
      </a>
      <nav className="hidden h-full min-[1120px]:block" aria-label="Pages"><Nav /></nav>
      <div className="ml-auto flex items-center gap-3 lg:gap-5">
        <Clock />
        <ConnDot />
        <div className="flex items-center gap-1.5">
          <Button variant="default" size="md" disabled={off} onClick={() => sendCmd({ cmd: 'demo' })} className="hidden sm:inline-flex"><Play size={13} fill="currentColor" />Run demo</Button>
          <Menu label="Exercise controls" button={<SlidersHorizontal size={16} />} buttonClassName="inline-flex h-9 w-9 items-center justify-center rounded-[4px] border border-rule2 text-ink2 hover:bg-panel3 hover:text-ink">
            {(close) => (
              <>
                <Button variant="default" size="lg" disabled={off} onClick={() => { sendCmd({ cmd: 'demo' }); close() }} className="mb-3 w-full sm:hidden"><Play size={14} fill="currentColor" />Run demo</Button>
                <Controls close={close} />
              </>
            )}
          </Menu>
          <div className="min-[1120px]:hidden">
            <Menu label="Pages" button={<MenuIcon size={17} />} buttonClassName="inline-flex h-9 w-9 items-center justify-center rounded-[4px] border border-rule2 text-ink2 hover:bg-panel3 hover:text-ink" className="w-[220px] p-1.5">
              {(close) => <Nav stacked onNavigate={close} />}
            </Menu>
          </div>
        </div>
      </div>
    </header>
  )
}
