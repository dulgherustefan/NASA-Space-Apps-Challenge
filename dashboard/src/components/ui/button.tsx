import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[3px] text-[12px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-40 select-none',
  {
    variants: {
      variant: {
        default: 'bg-accent text-[#16110a] hover:bg-[#edc387]',
        outline: 'border border-rule2 bg-transparent text-ink hover:bg-panel3',
        ghost: 'text-ink2 hover:bg-panel3 hover:text-ink',
        quiet: 'border border-rule bg-panel2 text-ink2 hover:text-ink hover:border-rule2',
      },
      size: { sm: 'h-7 px-2.5', md: 'h-8 px-3', icon: 'h-7 w-7' },
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
