import type { ReactNode } from 'react'
import { REFERENCE, hrefFor, usePage } from '@/lib/route'
import { cn } from '@/lib/utils'

/** The reference pages share one sub-navigation, so the top bar keeps two destinations. */
function ReferenceNav() {
  const page = usePage()
  return (
    <nav aria-label="Reference pages" className="mb-7 border-b border-rule">
      <ul className="-mb-px flex gap-5 overflow-x-auto">
        {REFERENCE.map((p) => (
          <li key={p.id}>
            <a href={hrefFor(p.id)} aria-current={page === p.id ? 'page' : undefined}
              className={cn('block whitespace-nowrap border-b-2 pb-2.5 pt-1 text-[13.5px] transition-colors duration-150', page === p.id ? 'border-ink font-bold text-ink' : 'border-transparent text-ink3 hover:text-ink')}>
              {p.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export function PageShell({ title, lede, aside, children, wide }: { title: string; lede?: string; aside?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className="h-full overflow-y-auto bg-panel">
      <div className={`mx-auto px-4 pb-16 pt-5 sm:px-8 sm:pt-6 ${wide ? 'max-w-[1240px]' : 'max-w-[900px]'}`}>
        <ReferenceNav />
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-[26px] font-bold leading-tight">{title}</h1>
            {lede && <p className="mt-2 max-w-[640px] text-[14px] leading-relaxed text-ink2">{lede}</p>}
          </div>
          {aside}
        </div>
        <div className="mt-8">{children}</div>
      </div>
    </div>
  )
}

export function H2({ children, id }: { children: ReactNode; id?: string }) {
  return <h2 id={id} className="mb-3 mt-10 border-b border-rule pb-2 text-[15px] font-bold first:mt-0">{children}</h2>
}
export function P({ children }: { children: ReactNode }) {
  return <p className="mb-3 max-w-[680px] text-[13.5px] leading-relaxed text-ink2">{children}</p>
}
