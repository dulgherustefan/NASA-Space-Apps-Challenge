import { useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useStore } from '@/lib/store'
import { loadParams } from '@/lib/engine'
import { num } from '@/lib/format'
import type { Kind } from '@/lib/types'
import { KINDS, KindBadge, normKind } from '@/components/Kind'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { PageShell } from './PageShell'

export function ParametersPage() {
  const params = useStore((s) => s.params)
  const conn = useStore((s) => s.conn)
  const [filter, setFilter] = useState<Kind | 'all'>('all')
  const [q, setQ] = useState('')
  useEffect(() => { if (conn === 'online') void loadParams() }, [conn])

  const groups = useMemo(() => {
    const m = new Map<string, typeof params.items>()
    for (const p of params.items) {
      if (filter !== 'all' && normKind(p.kind) !== filter) continue
      if (q && !`${p.label} ${p.key} ${p.source ?? ''} ${p.note ?? ''}`.toLowerCase().includes(q.toLowerCase())) continue
      const g = p.group ?? 'Other'
      m.set(g, [...(m.get(g) ?? []), p])
    }
    return [...m.entries()]
  }, [params.items, filter, q])
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const p of params.items) c[normKind(p.kind)] = (c[normKind(p.kind)] ?? 0) + 1
    return c
  }, [params.items])

  return (
    <PageShell wide title="Parameters" lede="Every value the engine uses, with where it comes from. The table is read from runtime/params.json, so it always matches the running engine."
      aside={<Button variant="quiet" onClick={() => void loadParams()}><RefreshCw size={12} />Reload</Button>}>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <button onClick={() => setFilter('all')} className={cn('h-7 rounded-[3px] border px-2.5 text-[12px]', filter === 'all' ? 'border-accent/50 bg-accent-dim text-accent' : 'border-rule2 text-ink2 hover:text-ink')}>All <span className="num text-ink3">{params.items.length}</span></button>
        {KINDS.map((k) => (
          <button key={k} onClick={() => setFilter(filter === k ? 'all' : k)} aria-pressed={filter === k} className={cn('flex h-7 items-center gap-1.5 rounded-[3px] border px-2 text-[12px]', filter === k ? 'border-accent/50 bg-accent-dim' : 'border-rule2 hover:bg-panel2')}>
            <KindBadge kind={k} className="border-0 p-0" /> <span className="num text-ink3">{counts[k] ?? 0}</span>
          </button>
        ))}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search parameters" aria-label="Search parameters" className="ml-auto h-7 w-[220px] rounded-[3px] border border-rule2 bg-panel2 px-2.5 text-[12px] text-ink placeholder:text-ink3" />
      </div>

      {params.status === 'missing' && <Notice title="runtime/params.json is not available">The engine has not written it yet, or it is offline. The table fills in as soon as the file can be read.</Notice>}
      {params.status === 'loading' && params.items.length === 0 && <Notice title="Loading parameters" />}
      {params.status === 'error' && <Notice title="runtime/params.json has no parameter list">Expected a list of entries with label, value, unit, kind and source.</Notice>}

      {groups.map(([g, items]) => (
        <section key={g} className="mb-8">
          <h2 className="eyebrow mb-2 !text-ink2">{g}</h2>
          <table className="w-full table-fixed border-collapse text-left text-[12.5px]">
            <colgroup><col style={{ width: '27%' }} /><col style={{ width: '13%' }} /><col style={{ width: '12%' }} /><col style={{ width: '48%' }} /></colgroup>
            <thead>
              <tr className="border-y border-rule text-ink3"><th className="py-1.5 pr-3 font-mono text-[10px] font-medium uppercase tracking-wider">Parameter</th><th className="py-1.5 pr-3 font-mono text-[10px] font-medium uppercase tracking-wider">Value</th><th className="py-1.5 pr-3 font-mono text-[10px] font-medium uppercase tracking-wider">Kind</th><th className="py-1.5 font-mono text-[10px] font-medium uppercase tracking-wider">Source and note</th></tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.key} className="rule-b align-top">
                  <td className="py-2.5 pr-3"><div className="text-ink">{p.label}</div><div className="num text-[10.5px] text-ink3">{p.key}</div></td>
                  <td className="num py-2.5 pr-3 text-[14px] text-ink">{num(p.value)} <span className="text-[11px] text-ink3">{p.unit}</span>{p.min !== undefined && p.max !== undefined && <div className="text-[10.5px] text-ink3">range {p.min} to {p.max}</div>}</td>
                  <td className="py-2.5 pr-3"><KindBadge kind={normKind(p.kind)} source={p.source} label={p.label} /></td>
                  <td className="py-2.5 text-[12px] leading-snug text-ink2">
                    {p.source && <div>{p.source}</div>}
                    {p.note && <div className="mt-0.5 text-ink3">{p.note}</div>}
                    {p.url && <div className="num mt-1 break-all text-[10.5px] text-ink3">{p.url}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      {params.status === 'ready' && groups.length === 0 && <Notice title="No parameter matches">Clear the search or the kind filter.</Notice>}
    </PageShell>
  )
}

function Notice({ title, children }: { title: string; children?: React.ReactNode }) {
  return <div className="mb-6 rounded-[3px] border border-dashed border-rule2 px-4 py-4"><div className="text-[13px] text-ink2">{title}</div>{children && <div className="mt-1 text-[12px] text-ink3">{children}</div>}</div>
}
