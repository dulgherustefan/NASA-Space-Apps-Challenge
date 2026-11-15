import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] text-[13px] font-bold transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40 select-none',
  {
    variants: {
      variant: {
        default: 'bg-solid text-on-solid hover:opacity-85',
        outline: 'border border-rule2 bg-panel text-ink hover:bg-panel3',
        ghost: 'text-ink2 hover:bg-panel3 hover:text-ink',
        quiet: 'bg-panel2 font-normal text-ink hover:bg-panel3',
      },
      size: { sm: 'h-8 px-3', md: 'h-9 px-3.5', lg: 'h-11 px-4 text-[14px]', icon: 'h-9 w-9' },
    },
    defaultVariants: { variant: 'outline', size: 'sm' },
  },
)

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
}
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button'
  return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
})
Button.displayName = 'Button'
export { Button, buttonVariants }
