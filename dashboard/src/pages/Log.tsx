import { useMemo, useState } from 'react'
import { Download } from 'lucide-react'
import { useStore, type LogEntry } from '@/lib/store'
import { missionT } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { PageShell } from './PageShell'

const TYPES = ['incident', 'assessment', 'routes', 'stress', 'decision', 'log'] as const
const TYPE_COLOR: Record<string, string> = { incident: 'var(--color-accent)', decision: 'var(--color-safe)', stress: 'var(--color-data)', routes: 'var(--color-data)', assessment: 'var(--color-ink2)', log: 'var(--color-ink3)', hello: 'var(--color-ink3)' }

export function LogPage() {
  const log = useStore((s) => s.log)
  const product = useStore((s) => s.hello?.product)
  const [on, setOn] = useState<Record<string, boolean>>({ incident: true, assessment: true, routes: true, stress: true, decision: true, log: true, hello: true })
  const [open, setOpen] = useState<number | null>(null)
  const rows = useMemo(() => log.filter((l) => on[l.type] !== false).slice().reverse(), [log, on])

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), product, count: log.length, entries: log.map((l: LogEntry) => ({ n: l.n, t: l.t, type: l.type, level: l.level, incident_id: l.incident_id, title: l.title, detail: l.detail, source: l.source, message: l.raw })) }, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `decision-log-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  return (
    <PageShell wide title="Decision log" lede="Everything the engine told this dashboard, in order: incidents, assessments, routes, stress results, decisions and log lines."
      aside={<Button variant="default" size="md" onClick={exportJson} disabled={!log.length}><Download size={13} />Export JSON</Button>}>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {TYPES.map((t) => (
          <button key={t} onClick={() => setOn((o) => ({ ...o, [t]: !(o[t] !== false) }))} aria-pressed={on[t] !== false}
            className={cn('h-7 rounded-[3px] border px-2.5 font-mono text-[11px] uppercase tracking-wider', on[t] !== false ? 'border-rule2 bg-panel2 text-ink' : 'border-rule text-ink3')}>
            <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ background: TYPE_COLOR[t], opacity: on[t] !== false ? 1 : 0.3 }} />{t}
          </button>
        ))}
        <span className="num ml-auto text-[11.5px] text-ink3">{rows.length} of {log.length} entries</span>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-[3px] border border-dashed border-rule2 px-4 py-6 text-[13px] text-ink2">Nothing logged yet. Run the demo or trigger an incident and every message will appear here.</div>
      ) : (
        <ul className="border-t border-rule">
          {rows.map((l) => (
            <li key={l.n} className="rule-b">
              <button onClick={() => setOpen(open === l.n ? null : l.n)} className="card-hover grid w-full grid-cols-[96px_150px_1fr] items-baseline gap-3 px-2 py-2 text-left" aria-expanded={open === l.n}>
                <span className="num text-[11px] text-ink3">{missionT(l.t)}</span>
                <span className="font-mono text-[10.5px] uppercase tracking-wider" style={{ color: TYPE_COLOR[l.type] }}>{l.type}{l.incident_id ? ` · ${l.incident_id}` : ''}</span>
                <span className="min-w-0">
                  <span className={cn('text-[13px]', l.level === 'warn' ? 'text-caution' : l.level === 'error' ? 'text-hazard' : 'text-ink')}>{l.title}</span>
                  {l.detail && <span className="mt-0.5 block text-[12px] leading-snug text-ink3">{l.detail}</span>}
                  {l.source && <span className="mt-0.5 block text-[11px] text-ink3">Source: {l.source}</span>}
                </span>
              </button>
              {open === l.n && <pre className="num mx-2 mb-3 max-h-[300px] overflow-auto rounded-[3px] border border-rule bg-panel p-3 text-[11px] leading-relaxed text-ink2">{JSON.stringify(l.raw, null, 2)}</pre>}
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  )
}
