import { useState } from 'react'
import { History, Play, RotateCcw, Settings2, Sparkles, Volume2, VolumeX } from 'lucide-react'
import { useStore } from '@/lib/store'
import { FALLBACK_PRODUCT } from '@/lib/config'
import { sendCmd } from '@/lib/engine'
import { useNow } from '@/lib/derive'
import { dur, hm, lightTime } from '@/lib/format'
import { hrefFor, usePage } from '@/lib/route'
import { isMuted, setMuted } from '@/lib/alert'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { Menu } from './ui/menu'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

export function Mark() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden>
      <defs>
        <linearGradient id="mark-far" gradientUnits="userSpaceOnUse" x1="-10.6" y1="0" x2="-6.4" y2="0">
          <stop offset="0" stopColor="#efebe4" stopOpacity=".85" /><stop offset="1" stopColor="#efebe4" stopOpacity="0" />
        </linearGradient>
        <mask id="mark-rim"><circle cx="12.2" cy="11.7" r="7.2" fill="#fff" /><circle cx="11.3" cy="12.6" r="6.9" fill="#000" /></mask>
      </defs>
      <g transform="translate(10.7 13.4) rotate(29)" fill="none" strokeLinecap="round">
        <path d="M-10.6 0A10.6 3.4 0 0 1 10.6 0" stroke="url(#mark-far)" strokeWidth="1.2" />
      </g>
      <circle cx="12.2" cy="11.7" r="7" fill="#3a2118" />
      <circle cx="12.2" cy="11.7" r="7.2" fill="#ffd9bf" mask="url(#mark-rim)" />
      <g transform="translate(10.7 13.4) rotate(29)" fill="none" strokeLinecap="round">
        <path d="M-10.6 0A10.6 3.4 0 0 0 10.6 0" stroke="#efebe4" strokeWidth="1.2" />
        <circle cx="10.6" cy="0" r="1.5" fill="#fff" />
      </g>
    </svg>
  )
}

/** Each time carries the name of its time system. */
function Clocks() {
  const clock = useStore((s) => s.snapshot?.clock)
  const t = useStore((s) => (s.snapshot ? Math.floor(s.snapshot.t) : null))
  const light = useStore((s) => s.snapshot?.light_time_s)
  const daylight = useStore((s) => s.snapshot?.env?.daylight_s)
  const sunSrc = useStore((s) => s.snapshot?.env?.sun_source)
  const dusk = daylight !== undefined && daylight < 3600
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex cursor-help items-baseline gap-4 whitespace-nowrap" tabIndex={0}>
          <span className="flex items-baseline gap-1.5">
            <span className="text-[12px] text-ink3"><span className="hidden lg:inline">Sol {clock?.sol ?? '-'} · </span>LMST</span>
            <span className="num text-[15px] font-semibold text-ink">{clock?.lmst ?? '--:--:--'}</span>
          </span>
          <span className="hidden items-baseline gap-1.5 md:flex">
            <span className="text-[12px] text-ink3">MET</span>
            <span className="num text-[15px] text-ink">{t === null ? '-:--' : dur(t)}</span>
          </span>
          {dusk && <span className="hidden text-[12.5px] font-semibold text-caution xl:inline">{daylight > 0 ? `${hm(daylight)} of daylight` : 'Sun down'}</span>}
        </div>
      </TooltipTrigger>
      <TooltipContent className="w-[300px]">
        <dl className="space-y-2">
          <div><dt className="text-ink3">LMST: local mean solar time at the site</dt><dd className="num text-ink">Sol {clock?.sol ?? '-'} · {clock?.lmst ?? '--:--:--'}</dd></div>
          <div><dt className="text-ink3">MET: time since the walk clock started</dt><dd className="num text-ink">{t === null ? '-' : dur(t)}</dd></div>
          {daylight !== undefined && <div><dt className="text-ink3">Daylight left</dt><dd className="text-ink"><span className="num">{daylight > 0 ? hm(daylight) : 'Sun down'}</span><span className="text-ink2"> · from the Sun position ({sunSrc ?? 'ephemeris'}), flat horizon. The canyon wall can shade the ground earlier.</span></dd></div>}
          <div><dt className="text-ink3">Earth, one way</dt><dd className="text-ink"><span className="num">{lightTime(light)}</span><span className="text-ink2"> · from JPL Horizons distances. An answer from Earth takes twice this, so the crew decides locally.</span></dd></div>
        </dl>
      </TooltipContent>
    </Tooltip>
  )
}

const STALE_AFTER_MS = 3000

/** Whether what is on screen is current. Stale data is said in words, not left to look live. */
function Link() {
  const conn = useStore((s) => s.conn)
  const attempts = useStore((s) => s.attempts)
  const hadData = useStore((s) => !!s.hello)
  const replay = useStore((s) => s.mode === 'replay')
  const lastMsgAt = useStore((s) => s.lastMsgAt)
  const running = useStore((s) => !!s.snapshot && !s.snapshot.clock.paused)
  const now = useNow(1000)
  if (replay && conn === 'online') {
    return (
      <Tooltip>
        <TooltipTrigger asChild><span tabIndex={0} aria-label="Recorded run" className="flex cursor-help items-center gap-1.5 whitespace-nowrap rounded-[4px] border border-rule2 px-2 py-[3px] text-[12px] text-ink2"><History size={13} className="min-[441px]:hidden" /><span className="max-[440px]:hidden">Recorded run</span></span></TooltipTrigger>
        <TooltipContent>A recorded run of the scripted demo, played from saved engine messages. No engine is connected, so routes cannot be planned again here.</TooltipContent>
      </Tooltip>
    )
  }
  const age = lastMsgAt ? now - lastMsgAt : 0
  const stale = conn === 'online' && running && age > STALE_AFTER_MS
  const state = stale ? 'stale' : conn === 'online' ? 'live' : conn === 'connecting' && attempts === 0 ? 'wait' : 'down'
  const label = { live: 'Live', stale: `Data ${Math.round(age / 1000)} s old`, wait: 'Connecting', down: hadData ? 'No link' : 'Engine offline' }[state]
  const short = { live: '', stale: `${Math.round(age / 1000)} s old`, wait: 'Wait', down: 'Offline' }[state]
  const tone = { live: 'text-safe', stale: 'text-stale', wait: 'text-ink3', down: 'text-hazard' }[state]
  return (
    <div className="flex items-center gap-1.5" role="status" aria-live="polite">
      <span className={cn('h-2 w-2 shrink-0 rounded-full bg-current', tone, state !== 'live' && 'pulse-dot')} />
      <span className={cn('whitespace-nowrap text-[12.5px] max-[440px]:sr-only', state === 'live' ? 'text-ink2' : cn('font-semibold', tone))}>{label}</span>
      {short && <span aria-hidden className={cn('whitespace-nowrap text-[12.5px] font-semibold min-[441px]:hidden', tone)}>{short}</span>}
    </div>
  )
}

function Nav() {
  const page = usePage()
  const items = [
    { label: 'Mission', href: hrefFor('console'), on: page === 'console' },
    { label: 'Reference', href: hrefFor('method'), on: page !== 'console' },
    // the free-standing live tool (any location on Mars) ships only with the web build
    ...(import.meta.env.MODE === 'live' ? [{ label: 'Anywhere on Mars', href: './live.html', on: false }] : []),
  ]
  return (
    <ul className="flex h-full items-stretch gap-4 sm:gap-5">
      {items.map((it) => (
        <li key={it.label} className="flex">
          <a href={it.href} aria-current={it.on ? 'page' : undefined}
            className={cn('relative flex items-center whitespace-nowrap text-[13.5px] transition-colors duration-150', it.on ? 'font-semibold text-ink' : 'text-ink3 hover:text-ink')}>
            {it.label}
            <span className={cn('absolute inset-x-0 bottom-0 h-[2px]', it.on ? 'bg-ink' : 'bg-transparent')} />
          </a>
        </li>
      ))}
    </ul>
  )
}

function Key({ children }: { children: string }) {
  return <kbd className="rounded-[3px] border border-rule2 px-1 font-sans text-[11.5px] text-ink2">{children}</kbd>
}

/** Display and exercise settings. The scripted incidents are for the exercise; a crew display would not carry them. */
function Settings({ close }: { close: () => void }) {
  const scenario = useStore((s) => s.hello?.scenario)
  const speed = useStore((s) => s.snapshot?.clock.speed)
  const off = useStore((s) => s.conn !== 'online')
  const replay = useStore((s) => s.mode === 'replay')
  const [muted, setM] = useState(isMuted)
  return (
    <div className="space-y-3">
      <Button size="md" variant="quiet" className="w-full justify-start" aria-pressed={!muted} onClick={() => { setMuted(!muted); setM(!muted) }}>
        {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}Alert sound {muted ? 'off' : 'on'}
      </Button>
      <div className="border-t border-rule pt-3">
        <div className="cap mb-1.5">Exercise</div>
        <div className="grid gap-1.5">
          <Button variant="quiet" size="md" className="justify-start" disabled={off} onClick={() => { sendCmd({ cmd: 'demo' }); close() }}><Play size={14} />Play the demo from the start</Button>
          <Button variant="quiet" size="md" className="justify-start" disabled={off} onClick={() => { sendCmd({ cmd: 'reset' }); close() }}><RotateCcw size={14} />Reset</Button>
        </div>
        {!replay && (
          <div className="mt-2.5 flex items-center justify-between gap-2">
            <span className="text-[12.5px] text-ink2">Clock speed</span>
            <ToggleGroup type="single" value={speed ? String(speed) : ''} onValueChange={(v) => v && sendCmd({ cmd: 'speed', value: Number(v) })} aria-label="Clock speed" disabled={off}>
              {[1, 8, 60].map((v) => <ToggleGroupItem key={v} value={String(v)} className="h-7 px-2.5">{v}x</ToggleGroupItem>)}
            </ToggleGroup>
          </div>
        )}
      </div>
      {!replay && (
        <div className="border-t border-rule pt-3">
          <div className="cap mb-1.5">Fire one scripted incident</div>
          <div className="grid gap-1.5">
            {(scenario ?? []).map((s) => (
              <Button key={s.id} size="md" variant="quiet" className="justify-start" disabled={off} onClick={() => { sendCmd({ cmd: 'trigger', id: s.id }); close() }}>{s.title}</Button>
            ))}
            {!scenario?.length && <span className="text-[12.5px] text-ink3">Waiting for the scenario list from the engine.</span>}
          </div>
        </div>
      )}
      <p className="border-t border-rule pt-2.5 text-[12px] leading-relaxed text-ink3">
        <Key>Space</Key> play or pause · <Key>A</Key> acknowledge{!replay && <> · <Key>P</Key> plan a walk</>} · <Key>Esc</Key> close
      </p>
    </div>
  )
}

export function Header() {
  const product = useStore((s) => s.hello?.product) ?? FALLBACK_PRODUCT
  const site = useStore((s) => s.hello?.site.name)
  return (
    <header className="flex h-[48px] min-w-0 shrink-0 items-center gap-3 border-b border-rule bg-panel px-3 sm:gap-4 sm:px-4 lg:gap-6">
      <a href={hrefFor('console')} className="flex shrink-0 items-center gap-2.5">
        <Mark />
        <span className="text-[16px] font-semibold text-ink">{product}</span>
        <span className="hidden max-w-[170px] truncate text-[13px] text-ink3 lg:inline">{site ?? 'No site loaded'}</span>
      </a>
      <nav className="h-full" aria-label="Pages"><Nav /></nav>
      <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3 lg:gap-5">
        {import.meta.env.MODE === 'live' && (
          <button type="button" data-testid="tour" onClick={() => void import('@/live/DashTour').then((m) => m.startDashTour())}
            className="hidden h-9 items-center gap-1.5 rounded-[6px] px-2 text-[13px] text-ink2 transition-colors duration-150 hover:bg-panel3 hover:text-ink md:inline-flex">
            <Sparkles size={15} />Start tour
          </button>
        )}
        <div className="max-[560px]:hidden"><Clocks /></div>
        <Link />
        <Menu label="Settings" button={<Settings2 size={17} />} buttonClassName="inline-flex h-9 w-9 items-center justify-center rounded-[6px] text-ink2 transition-colors duration-150 hover:bg-panel3 hover:text-ink">
          {(close) => <Settings close={close} />}
        </Menu>
      </div>
    </header>
  )
}
