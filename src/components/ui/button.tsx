import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-base font-bold ring-offset-background transition-[background-color,box-shadow,transform] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 motion-reduce:active:scale-100 [&_svg]:pointer-events-none [&_svg]:size-5 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Primário (CTA): fundo dourado, texto marrom escuro em negrito.
        default: "bg-cta text-cta-foreground hover:bg-cta-hover",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        // Secundário: contorno.
        outline:
          "border-2 border-primary bg-background text-primary hover:bg-brand-soft",
        secondary:
          "bg-brand-soft text-brand-soft-foreground hover:bg-secondary",
        // Terciário: só texto.
        ghost: "text-primary hover:bg-muted",
        link: "text-primary underline-offset-4 hover:underline",
        // Escuro #123029.
        dark: "bg-ink text-white hover:bg-ink/90",
        // Pílula branca sobre o cartão de saldo (fundo verde escuro).
        onBrand: "bg-background text-primary hover:bg-brand-soft",
      },
      size: {
        default: "h-12 px-6 py-2",
        sm: "h-11 px-4",
        lg: "h-14 px-8",
        icon: "h-12 w-12",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  // Brilho dourado: só no CTA principal da tela (variant="default").
  glow?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, glow = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size }), glow && (variant ?? "default") === "default" && "shadow-glow", className)}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
