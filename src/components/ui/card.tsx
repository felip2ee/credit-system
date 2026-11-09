import * as React from "react";

import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// Plano (padrão): borda de 1 px, sem sombra. elevated: sombra média. hero: destaque amarelo do portal.
// dark: destaque verde escuro do painel admin (hero e no máximo um segundo destaque por tela); no admin o padrão é branco.
const cardVariants = cva("text-card-foreground", {
  variants: {
    variant: {
      flat: "rounded-card border border-border bg-card admin:rounded-[18px]",
      elevated: "rounded-card border border-border bg-card shadow-md admin:rounded-[18px]",
      dark: "card-dark rounded-card border border-border bg-card shadow-md admin:rounded-[18px]",
      hero: "rounded-hero bg-primary text-primary-foreground shadow-md admin:rounded-[18px]",
    },
  },
  defaultVariants: { variant: "flat" },
});

export interface CardProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof cardVariants> {}

const Card = React.forwardRef<HTMLDivElement, CardProps>(({ className, variant, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      cardVariants({ variant }),
      className
    )}
    {...props}
  />
));
Card.displayName = "Card";

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1.5 p-6 admin:space-y-1 admin:p-4", className)}
    {...props}
  />
));
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-xl font-bold leading-tight admin:text-base", className)}
    {...props}
  />
));
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-base text-muted-foreground admin:text-[13px]", className)}
    {...props}
  />
));
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-6 pt-0 admin:p-4 admin:pt-0", className)} {...props} />
));
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-center p-6 pt-0 admin:p-4 admin:pt-0", className)}
    {...props}
  />
));
CardFooter.displayName = "CardFooter";

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
};
