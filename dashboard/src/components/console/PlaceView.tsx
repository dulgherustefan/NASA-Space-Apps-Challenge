import { useState } from 'react'
import { fileUrl } from '@/lib/config'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'

/** What a place looks like from the approach: a render of the terrain model, always labelled as a render. */
export function PlaceView({ placeId, name, className, imgClassName, caption }: {
  placeId: string; name: string; className?: string; imgClassName?: string; caption?: string
}) {
  const item = useStore((s) => s.pov[placeId])
  const [failed, setFailed] = useState<string | null>(null)
  const path = item ? (item.file.includes('/') ? item.file : `data/site/pov/${item.file}`) : ''
  const url = path ? fileUrl(path) : ''
  if (!item || !url || failed === path) return null
  return (
    <figure className={className}>
      <img src={url} alt={`Rendered view of ${name} from the approach`} loading="lazy" onError={() => setFailed(path)}
        className={cn('aspect-[21/9] w-full object-cover', imgClassName ?? 'rounded-[8px]')} />
      <figcaption className="mt-1.5 text-[12px] leading-snug text-ink3">{caption ?? item.caption ?? 'Rendered from the HiRISE elevation model. Colour is approximate; ground detail and rocks are set dressing.'}</figcaption>
    </figure>
  )
}
