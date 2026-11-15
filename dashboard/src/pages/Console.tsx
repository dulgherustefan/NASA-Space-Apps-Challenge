import { useLayout } from '@/lib/derive'
import { ActionCard } from '@/components/console/ActionCard'
import { Crew } from '@/components/console/Crew'
import { Routes } from '@/components/console/Routes'
import { Situation } from '@/components/console/Situation'
import { MapView } from '@/components/MapView'

/**
 * One screen, three widths.
 * wide:  situation | map | decision   (habitat display)
 * split: map | decision + situation   (laptop)
 * field: decision, map, the rest      (tablet or cuff display: one column, large targets)
 */
export function ConsolePage() {
  const layout = useLayout()
  if (layout === 'field') {
    return (
      <div className="h-full overflow-y-auto" data-layout="field">
        <div className="z-20 border-b border-rule2 bg-panel [@media(min-height:900px)]:sticky [@media(min-height:900px)]:top-0"><ActionCard compact /></div>
        <div className="h-[58vh] min-h-[320px] border-b border-rule"><MapView /></div>
        <Crew />
        <Routes />
        <Situation />
      </div>
    )
  }
  return (
    <div className="grid h-full min-h-0" data-layout={layout} style={{ gridTemplateColumns: layout === 'wide' ? '312px minmax(0,1fr) 408px' : 'minmax(0,1fr) 392px' }}>
      {layout === 'wide' && <aside className="min-h-0 overflow-y-auto border-r border-rule bg-[#0e1114]" aria-label="Situation"><Situation /></aside>}
      <section className="min-h-0 min-w-0" aria-label="Map"><MapView /></section>
      <aside className="min-h-0 overflow-y-auto border-l border-rule2 bg-panel" aria-label="Response">
        <ActionCard />
        <Crew />
        <Routes />
        {layout === 'split' && <div className="border-t border-rule"><Situation /></div>}
      </aside>
    </div>
  )
}
