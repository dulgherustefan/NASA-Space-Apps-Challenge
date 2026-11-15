import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { cn } from '@/lib/utils'

const TooltipProvider = ({ children }: { children: React.ReactNode }) => (
  <TooltipPrimitive.Provider delayDuration={120} skipDelayDuration={300}>{children}</TooltipPrimitive.Provider>
)

const TapContext = React.createContext<() => void>(() => {})

/**
 * Hover and focus open the tip as usual. A touch screen has no hover, so a tap on a number or a label opens its
 * tip (kind and source) and a tap anywhere else closes it. Buttons keep their own tap for their action.
 */
function Tooltip({ children, ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const [open, setOpen] = React.useState(false)
  React.useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])
  const tap = React.useCallback(() => setOpen(true), [])
  return (
    <TooltipPrimitive.Root open={open} onOpenChange={setOpen} {...props}>
      <TapContext.Provider value={tap}>{children}</TapContext.Provider>
    </TooltipPrimitive.Root>
  )
}

const TooltipTrigger = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>
>(({ onClick, ...props }, ref) => {
  const tap = React.useContext(TapContext)
  return (
    <TooltipPrimitive.Trigger
      ref={ref}
      {...props}
      onClick={(e) => {
        onClick?.(e)
        const touch = (e.nativeEvent as PointerEvent).pointerType === 'touch'
        // the trigger itself closes the tip on every click, so open it just after that
        if (touch && (e.currentTarget as HTMLElement).tagName !== 'BUTTON') setTimeout(tap, 0)
      }}
    />
  )
})
TooltipTrigger.displayName = 'TooltipTrigger'

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={8}
      className={cn('z-50 max-w-[320px] rounded-[6px] bg-panel3 px-3 py-2 text-[12.5px] leading-snug text-ink shadow-[0_8px_24px_rgba(0,0,0,.5)] anim-fade', className)}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = 'TooltipContent'

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
