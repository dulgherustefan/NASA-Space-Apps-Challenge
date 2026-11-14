import type { ReactNode } from 'react'

export function PageShell({ title, lede, aside, children, wide }: { title: string; lede?: string; aside?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className={`mx-auto px-8 pb-16 pt-8 ${wide ? 'max-w-[1240px]' : 'max-w-[900px]'}`}>
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-[26px] font-semibold leading-tight tracking-tight">{title}</h1>
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
  return <h2 id={id} className="mb-3 mt-10 border-b border-rule pb-2 text-[15px] font-semibold tracking-tight first:mt-0">{children}</h2>
}
export function P({ children }: { children: ReactNode }) {
  return <p className="mb-3 max-w-[680px] text-[13.5px] leading-relaxed text-ink2">{children}</p>
}
