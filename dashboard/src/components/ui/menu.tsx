import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** A button that opens a small panel under it. Closes on outside press, Escape, or when `closeOnSelect` items are used. */
export function Menu({ label, button, buttonClassName, children, align = 'right', className }: {
  label: string
  button: ReactNode
  buttonClassName?: string
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key) }
  }, [open])
  return (
    <div ref={root} className="relative">
      <button type="button" aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className={cn(buttonClassName, open && 'bg-panel3 text-ink')}>
        {button}
      </button>
      {open && (
        <div role="dialog" aria-label={label}
          className={cn('anim-rise absolute top-[calc(100%+8px)] z-50 w-[min(320px,calc(100vw-24px))] rounded-[8px] border border-rule2 bg-panel p-3 shadow-float', align === 'right' ? 'right-0' : 'left-0', className)}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}
