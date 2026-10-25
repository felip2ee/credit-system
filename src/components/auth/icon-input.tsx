import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { Input, type InputProps } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface IconInputProps extends InputProps {
  icon: LucideIcon;
}

// Campo com ícone de contorno à esquerda (padrão de login). O rótulo continua fora, acima do campo.
export const IconInput = React.forwardRef<HTMLInputElement, IconInputProps>(({ icon: Icon, className, ...props }, ref) => (
  <div className="relative">
    <Icon aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
    <Input ref={ref} className={cn("pl-11", className)} {...props} />
  </div>
));
IconInput.displayName = "IconInput";
