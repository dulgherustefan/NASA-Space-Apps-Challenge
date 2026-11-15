import { useStore } from '@/lib/store'
import { KINDS, KindBadge } from './Kind'
import { missionT } from '@/lib/format'
import { cn } from '@/lib/utils'

export function Footer() {
  const last = useStore((s) => s.log[s.log.length - 1])
  return (
    <footer className="flex h-[30px] shrink-0 items-center justify-between gap-4 border-t border-rule bg-panel px-4 text-[12px] text-ink3">
      <div className="flex min-w-0 items-center gap-2">

        {last ? (
          <span key={last.n} className="anim-fade flex min-w-0 items-center gap-2">
            <span className="num shrink-0">{missionT(last.t)}</span>
            <span className={cn('truncate', last.level === 'warn' ? 'text-caution' : last.level === 'error' ? 'text-hazard' : 'text-ink2')}>{last.title}</span>
          </span>
        ) : <span>none yet</span>}
      </div>
      <div className="hidden shrink-0 items-center gap-3.5 lg:flex" aria-label="Kinds of number">
        <span>Every number is marked</span>
        {KINDS.map((k) => <KindBadge key={k} kind={k} />)}
      </div>
    </footer>
  )
}
