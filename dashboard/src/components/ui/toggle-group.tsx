import * as React from 'react'
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group'
import { cn } from '@/lib/utils'

const ToggleGroup = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <ToggleGroupPrimitive.Root ref={ref} className={cn('inline-flex items-center rounded-[3px] border border-rule2 bg-panel2 p-0.5', className)} {...props} />
))
ToggleGroup.displayName = 'ToggleGroup'

const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>
>(({ className, ...props }, ref) => (
  <ToggleGroupPrimitive.Item
    ref={ref}
    className={cn('h-6 rounded-[2px] px-2 font-mono text-[11px] text-ink2 transition-colors hover:text-ink data-[state=on]:bg-panel3 data-[state=on]:text-ink data-[state=on]:shadow-[inset_0_0_0_1px_var(--color-rule2)]', className)}
    {...props}
  />
))
ToggleGroupItem.displayName = 'ToggleGroupItem'
export { ToggleGroup, ToggleGroupItem }
