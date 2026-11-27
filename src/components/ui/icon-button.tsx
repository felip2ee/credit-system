import * as React from "react";

import { cn } from "@/lib/utils";

import { Button, type ButtonProps } from "./button";

// Botão circular de 44 px (40 px de md) só com ícone. O rótulo acessível é obrigatório.
export interface IconButtonProps extends Omit<ButtonProps, "size" | "children"> {
  "aria-label": string;
  children: React.ReactNode;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, variant = "ghost", ...props }, ref) => (
    <Button ref={ref} size="icon" variant={variant} className={cn("shrink-0", className)} {...props} />
  ),
);
IconButton.displayName = "IconButton";
