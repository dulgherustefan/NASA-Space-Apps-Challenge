import { useEffect } from 'react'
import { WifiOff } from 'lucide-react'
import { useStore } from '@/lib/store'
import { ENGINE_URL, FALLBACK_PRODUCT } from '@/lib/config'
import { retryNow, startEngine } from '@/lib/engine'
import { usePage } from '@/lib/route'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { TopBar } from '@/components/TopBar'
import { SubBar } from '@/components/SubBar'
import { Footer } from '@/components/Footer'
import { ConsolePage } from '@/pages/Console'
import { MethodPage } from '@/pages/Method'
import { ParametersPage } from '@/pages/Parameters'
import { LogPage } from '@/pages/Log'
import { SourcesPage } from '@/pages/Sources'

function OfflineBanner() {
  const conn = useStore((s) => s.conn)
  const attempts = useStore((s) => s.attempts)
  const hadData = useStore((s) => !!s.hello)
  if (conn === 'online') return null
  if (conn === 'connecting' && attempts === 0) return null
  // Floats above the footer so the console does not shift when the connection drops or returns.
  return (
    <div role="alert" className="anim-rise pointer-events-auto fixed bottom-[34px] left-4 z-50 flex w-[min(720px,calc(100vw-32px))] items-start gap-3 rounded-[4px] border border-hazard/45 bg-[#1a1213]/95 px-4 py-3 shadow-[0_8px_32px_rgba(0,0,0,.55)] backdrop-blur-sm">
      <WifiOff size={16} className="mt-[2px] shrink-0 text-hazard" />
      <div className="min-w-0 flex-1 text-[12.5px] leading-snug">
        <div className="font-medium text-ink">{hadData ? 'Connection to the engine lost' : 'Engine not running'}</div>
        <div className="mt-0.5 text-ink2">
          {hadData ? 'Showing the last state received. ' : 'Nothing to show until it answers. '}
          Reconnecting to <span className="num text-ink">{ENGINE_URL}</span> automatically{attempts > 1 ? <> (attempt <span className="num">{attempts}</span>)</> : null}.
        </div>
        {!hadData && <div className="mt-1 text-ink3">Start it with <span className="num text-ink2">uv run python -m engine</span> in the repository root.</div>}
      </div>
      <Button variant="outline" size="sm" className="shrink-0" onClick={retryNow}>Retry now</Button>
    </div>
  )
}

export default function App() {
  const page = usePage()
  const product = useStore((s) => s.hello?.product)
  useEffect(() => { startEngine() }, [])
  useEffect(() => { document.title = product ?? FALLBACK_PRODUCT }, [product])
  return (
    <TooltipProvider>
      <div className="flex h-full flex-col">
        <TopBar />
        <SubBar />
        <OfflineBanner />
        <main className="min-h-0 flex-1">
          {page === 'console' && <ConsolePage />}
          {page === 'method' && <MethodPage />}
          {page === 'parameters' && <ParametersPage />}
          {page === 'log' && <LogPage />}
          {page === 'sources' && <SourcesPage />}
        </main>
        <Footer />
      </div>
    </TooltipProvider>
  )
}
