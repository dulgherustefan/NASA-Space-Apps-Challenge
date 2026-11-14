import { useStore } from '@/lib/store'
import { ENGINE_URL } from '@/lib/config'
import { missionT } from '@/lib/format'
import { cn } from '@/lib/utils'

export function Footer() {
  const last = useStore((s) => s.log[s.log.length - 1])
  const n = useStore((s) => s.log.length)
  return (
    <footer className="flex h-[24px] shrink-0 items-center justify-between gap-4 border-t border-rule bg-panel px-4 text-[11px] text-ink3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="eyebrow">Last message</span>
        {last ? (
          <span key={last.n} className="anim-fade flex min-w-0 items-center gap-2">
            <span className="num shrink-0">{missionT(last.t)}</span>
            <span className={cn('truncate', last.level === 'warn' ? 'text-caution' : last.level === 'error' ? 'text-hazard' : 'text-ink2')}>{last.title}</span>
          </span>
        ) : <span>none yet</span>}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="num">{n} events logged</span>
        <span className="num">{ENGINE_URL}</span>
      </div>
    </footer>
  )
}
