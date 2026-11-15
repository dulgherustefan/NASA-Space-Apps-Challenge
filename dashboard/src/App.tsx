import { useEffect } from 'react'
import { WifiOff } from 'lucide-react'
import { store, useStore } from '@/lib/store'
import { ENGINE_URL, FALLBACK_PRODUCT } from '@/lib/config'
import { acknowledge, retryNow, startEngine, togglePlay } from '@/lib/engine'
import { usePage } from '@/lib/route'
import { applyTheme, readTheme } from '@/lib/theme'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Header } from '@/components/Header'
import { ConsolePage } from '@/pages/Console'
import { MethodPage } from '@/pages/Method'
import { ParametersPage } from '@/pages/Parameters'
import { LogPage } from '@/pages/Log'
import { SourcesPage } from '@/pages/Sources'

function OfflineBanner() {
  const conn = useStore((s) => s.conn)
  const attempts = useStore((s) => s.attempts)
  const hadData = useStore((s) => !!s.hello)
  const replay = useStore((s) => s.mode === 'replay')
  if (conn === 'online') return null
  if (conn === 'connecting' && attempts === 0) return null
  // Floats over the page so the display does not shift when the connection drops or returns.
  return (
    <div role="alert" className="anim-rise pointer-events-auto fixed bottom-16 left-4 z-50 flex w-[min(680px,calc(100vw-32px))] items-start gap-3 rounded-[8px] border border-hazard bg-panel px-4 py-3 shadow-float">
      <WifiOff size={16} className="mt-[2px] shrink-0 text-hazard" />
      <div className="min-w-0 flex-1 text-[13px] leading-snug">
        <div className="font-bold text-ink">{replay ? 'Recorded run not found' : hadData ? 'Connection to the engine lost' : 'Engine not running'}</div>
        {replay ? (
          <div className="mt-0.5 text-ink2">This build has no recording to play. Make one with <span className="text-ink">python tools/record_demo.py</span> and build again.</div>
        ) : (
          <>
            <div className="mt-0.5 text-ink2">
              {hadData ? 'Showing the last state received. ' : 'Nothing to show until it answers. '}
              Reconnecting to <span className="num text-ink">{ENGINE_URL}</span> automatically{attempts > 1 ? <> (attempt <span className="num">{attempts}</span>)</> : null}.
            </div>
            {!hadData && <div className="mt-1 text-ink3">Start it with <span className="text-ink2">uv run python -m engine</span> in the repository root.</div>}
          </>
        )}
      </div>
      <Button variant="outline" size="sm" className="shrink-0" onClick={retryNow}>Retry now</Button>
    </div>
  )
}

/** Keys for the mission display: space plays or pauses, A acknowledges, P plans a walk, Esc closes. */
function useShortcuts(active: boolean) {
  useEffect(() => {
    if (!active) return
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement | null
      if (el?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')) return
      const onControl = !!el?.closest('button, a, [role="slider"], [tabindex="0"]')
      const st = store.get()
      if (e.key === ' ' && !onControl) { e.preventDefault(); togglePlay() }
      else if (e.key.toLowerCase() === 'a' && st.alertId) acknowledge()
      else if (e.key.toLowerCase() === 'p' && st.mode === 'live' && st.conn === 'online') store.set({ planMode: !st.planMode, selectedPlace: null })
      else if (e.key === 'Escape') {
        if (st.planMode) store.set({ planMode: false })
        else if (st.selectedPlace) store.set({ selectedPlace: null })
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [active])
}

export default function App() {
  const page = usePage()
  const product = useStore((s) => s.hello?.product)
  useEffect(() => { applyTheme(readTheme()); startEngine() }, [])
  useEffect(() => { document.title = product ?? FALLBACK_PRODUCT }, [product])
  useShortcuts(page === 'console')
  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <Header />
        <OfflineBanner />
        <main className="min-h-0 flex-1">
          {page === 'console' && <ConsolePage />}
          {page === 'method' && <MethodPage />}
          {page === 'parameters' && <ParametersPage />}
          {page === 'log' && <LogPage />}
          {page === 'sources' && <SourcesPage />}
        </main>
      </div>
    </TooltipProvider>
  )
}
