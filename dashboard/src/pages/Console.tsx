import { useLayout } from '@/lib/derive'
import { Details, Panel } from '@/components/console/Panel'
import { MapView } from '@/components/MapView'

/**
 * One screen: the map and one panel. No tabs: the panel says what to do, and the detail behind it opens in place.
 * wide, split: map | panel   (habitat display, laptop)
 * field:       panel, map, detail   (tablet or cuff display: one column, large targets)
 */
export function ConsolePage() {
  const layout = useLayout()
  if (layout === 'field') {
    return (
      <div className="h-full overflow-y-auto bg-panel" data-layout="field">
        <Panel />
        <div className="h-[52vh] min-h-[300px] border-y border-rule"><MapView /></div>
        <Details />
      </div>
    )
  }
  return (
    <div className="grid h-full min-h-0" data-layout={layout} style={{ gridTemplateColumns: `minmax(0,1fr) ${layout === 'wide' ? 412 : 380}px` }}>
      <section className="min-h-0 min-w-0" aria-label="Map"><MapView /></section>
      <aside className="min-h-0 overflow-y-auto border-l border-rule bg-panel" aria-label="Response">
        <Panel />
        <Details />
      </aside>
    </div>
  )
}
