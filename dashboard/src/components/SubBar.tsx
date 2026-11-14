import { PAGES, hrefFor, usePage } from '@/lib/route'
import { cn } from '@/lib/utils'
import { KINDS, KindBadge } from './Kind'

export function SubBar() {
  const page = usePage()
  return (
    <nav className="flex h-[34px] shrink-0 items-center justify-between border-b border-rule bg-bg px-4" aria-label="Pages">
      <ul className="flex h-full items-stretch gap-5">
        {PAGES.map((p) => (
          <li key={p.id} className="flex">
            <a href={hrefFor(p.id)} aria-current={page === p.id ? 'page' : undefined}
              className={cn('relative flex items-center text-[12.5px] transition-colors', page === p.id ? 'text-ink' : 'text-ink3 hover:text-ink2')}>
              {p.label}
              <span className={cn('absolute inset-x-0 -bottom-px h-[2px] transition-colors', page === p.id ? 'bg-accent' : 'bg-transparent')} />
            </a>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <span className="eyebrow">Every number is one of</span>
        {KINDS.map((k) => <KindBadge key={k} kind={k} />)}
      </div>
    </nav>
  )
}
