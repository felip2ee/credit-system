import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// shrink-0 + max-w-full: o botão não encolhe ao lado de um campo, mas o texto quebra quando o contêiner é mais estreito (fonte ampliada).
// Por isso a altura é mínima (min-h) e não fixa.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 shrink-0 max-w-full text-center rounded-full text-[15px] font-semibold admin:text-sm ring-offset-background transition-[transform,background-color,box-shadow] duration-fast ease-out motion-safe:active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-[18px] admin:[&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Primário (CTA): fundo amarelo, texto verde escuro em negrito.
        default: "bg-primary text-primary-foreground hover:bg-primary-hover",
        // Entrada principal ("Nova pesquisa", "Novo pedido"): amarelo cheio.
        cta: "bg-cta text-cta-foreground hover:bg-cta-hover",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        // Secundário: contorno.
        outline:
          "border border-primary bg-transparent text-primary hover:bg-accent",
        secondary:
          "border border-input bg-secondary text-secondary-foreground hover:bg-accent",
        // Terciário: só texto.
        ghost: "text-primary hover:bg-accent",
        link: "text-primary underline-offset-4 hover:underline",
        // Escuro: verde de superfície com borda amarela.
        dark: "border border-primary bg-ink text-card-foreground hover:bg-accent",
        // Pílula amarela sobre o cartão de saldo.
        onBrand: "bg-primary text-primary-foreground hover:bg-primary-hover",
      },
      size: {
        default: "min-h-11 px-5 py-2 admin:min-h-10 admin:px-4",
        sm: "min-h-11 px-4 text-sm md:min-h-9 md:px-3.5 admin:min-h-9 admin:px-3.5",
        lg: "min-h-12 px-6 text-base admin:min-h-11 admin:px-6",
        icon: "min-h-11 w-11 md:min-h-10 md:w-10 admin:min-h-10 admin:w-10",
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
