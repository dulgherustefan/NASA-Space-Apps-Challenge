import { focusBundle, store, useStore } from '@/lib/store'
import { LAYERS, LAYER_LABEL, type Layer } from '@/lib/config'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

// Colour ramps and ranges as the engine paints them (engine/hazards.py).
const INFERNO = 'linear-gradient(90deg, rgb(40,11,84), rgb(101,21,110), rgb(188,55,84), rgb(249,142,9), rgb(252,255,164))'
export const LAYER_INFO: Record<Layer, { what: string; ramp: string; lo: string; hi: string }> = {
  hazard: { what: 'Combined hazard: slope, rockfall runout band and loose sand. Model.', ramp: INFERNO, lo: 'lower', hi: 'higher' },
  slope: { what: 'Slope over 10 m from the HiRISE elevation model.', ramp: INFERNO, lo: '8°', hi: '35°' },
  rockfall: { what: 'Rockfall runout band below steep faces, reach angle 27.8°. Model.', ramp: 'linear-gradient(90deg, rgb(230,159,0), rgb(213,94,0))', lo: 'band edge', hi: 'deep in band' },
  sand: { what: 'Loose sand likelihood. A proxy from image brightness and smoothness, not a measurement.', ramp: 'linear-gradient(90deg, rgb(240,228,66), rgb(230,159,0))', lo: 'possible', hi: 'likely' },
  sky: { what: 'Share of the sky blocked by terrain. Blocked sky shields from particle radiation. Model.', ramp: 'linear-gradient(90deg, rgb(86,180,233), rgb(0,114,178))', lo: '15% blocked', hi: '45%' },
  dose: { what: 'Dose rate at each cell at the storm peak, after terrain shielding. Model.', ramp: 'linear-gradient(90deg, rgb(204,121,167), rgb(120,40,140))', lo: 'shielded', hi: 'exposed' },
  failures: { what: 'Where virtual crews failed in the stress test, weighted by likelihood. Model.', ramp: 'linear-gradient(90deg, rgb(140,41,100), rgb(249,142,9), rgb(252,255,164))', lo: 'few', hi: 'many' },
}

export function LayerSwitch() {
  const layer = useStore((s) => s.overlay.layer)
  const bundle = useStore(focusBundle)
  const fromEngine = new Set((bundle?.assessment?.overlays ?? []).map((o) => o.layer))
  const set = (l: string | null) => store.set((s) => ({ overlay: { ...s.overlay, layer: l, userSet: true } }))
  const items: (Layer | null)[] = [null, ...LAYERS]
  return (
    <div className="flex max-w-full gap-1 overflow-x-auto rounded-[6px] border border-rule2 bg-bg/85 p-1 backdrop-blur-sm" role="radiogroup" aria-label="Map layer">
      {items.map((l) => {
        const on = layer === l
        const updated = l ? fromEngine.has(l) : false
        return (
          <Tooltip key={l ?? 'off'}>
            <TooltipTrigger asChild>
              <button type="button" role="radio" aria-checked={on} onClick={() => set(l)}
                className={cn('relative h-8 shrink-0 rounded-[4px] px-2.5 text-[12.5px] transition-colors', on ? 'bg-accent text-[#16110a]' : 'text-ink2 hover:bg-panel3 hover:text-ink')}>
                {l ? LAYER_LABEL[l] : 'Image'}
                {updated && !on && <span className="absolute right-1 top-1 h-[5px] w-[5px] rounded-full bg-accent" />}
              </button>
            </TooltipTrigger>
            <TooltipContent>{l ? LAYER_INFO[l].what + (updated ? ' Updated by this incident.' : '') : 'HiRISE orthoimage only.'}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

/** What the colours of the current layer mean. */
export function LayerLegend() {
  const layer = useStore((s) => s.overlay.layer) as Layer | null
  if (!layer || !LAYER_INFO[layer]) return null
  const info = LAYER_INFO[layer]
  return (
    <div className="flex items-center gap-2 text-[12px] text-ink2" title={info.what}>
      <span className="hidden text-ink sm:inline">{LAYER_LABEL[layer]}</span>
      <span className="text-ink3">{info.lo}</span>
      <span className="h-2 w-20 rounded-[2px]" style={{ background: info.ramp }} />
      <span className="text-ink3">{info.hi}</span>
    </div>
  )
}
