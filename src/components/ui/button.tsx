import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-base font-bold admin:text-sm ring-offset-background transition-[background-color,box-shadow,transform] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 motion-reduce:active:scale-100 [&_svg]:pointer-events-none [&_svg]:size-5 admin:[&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Primário (CTA): fundo amarelo, texto verde escuro em negrito.
        default: "bg-primary text-primary-foreground hover:bg-cta-hover",
        // Entrada principal ("Nova pesquisa", "Novo pedido"): amarelo cheio.
        cta: "bg-cta text-cta-foreground hover:bg-cta-hover",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        // Secundário: contorno.
        outline:
          "border-2 border-primary bg-transparent text-primary hover:bg-accent",
        secondary:
          "border border-input bg-secondary text-secondary-foreground hover:bg-accent",
        // Terciário: só texto.
        ghost: "text-primary hover:bg-accent",
        link: "text-primary underline-offset-4 hover:underline",
        // Escuro: verde de superfície com borda amarela.
        dark: "border border-primary bg-ink text-card-foreground hover:bg-accent",
        // Pílula amarela sobre o cartão de saldo.
        onBrand: "bg-primary text-primary-foreground hover:bg-cta-hover",
      },
      size: {
        default: "h-12 px-6 py-2 admin:h-10 admin:px-4",
        sm: "h-11 px-4 admin:h-9 admin:px-3.5",
        lg: "h-14 px-8 admin:h-11 admin:px-6",
        icon: "h-12 w-12 admin:h-10 admin:w-10",
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
  // Brilho amarelo: só no CTA principal da tela (variant="default" ou "cta").
  glow?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, glow = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size }), glow && ["default", "cta"].includes(variant ?? "default") && "shadow-glow", className)}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
