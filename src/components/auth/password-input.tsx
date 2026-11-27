"use client";

import * as React from "react";
import { Eye, EyeOff, Lock } from "lucide-react";

import { Input, type InputProps } from "@/components/ui/input";

export interface PasswordInputProps extends Omit<InputProps, "type"> {
  // Cadeado à esquerda (telas de entrada).
  withIcon?: boolean;
  // Rótulos do olho [mostrar, ocultar]. Troque quando o rótulo padrão colidir com o do campo.
  toggleLabels?: [string, string];
}

export const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ withIcon = false, toggleLabels = ["Mostrar senha", "Ocultar senha"], className, ...props }, ref) => {
    const [visible, setVisible] = React.useState(false);
    return (
      <div className="relative">
        {withIcon && <Lock aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />}
        <Input
          autoComplete="new-password"
          {...props}
          ref={ref}
          type={visible ? "text" : "password"}
          className={`pr-14 ${withIcon ? "pl-11" : ""} ${className ?? ""}`}
        />
        <button
          type="button"
          aria-pressed={visible}
          aria-label={visible ? toggleLabels[1] : toggleLabels[0]}
          onClick={() => setVisible((v) => !v)}
          className="absolute right-0 top-0 flex size-11 admin:size-10 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {visible ? <EyeOff aria-hidden className="size-5" /> : <Eye aria-hidden className="size-5" />}
        </button>
      </div>
    );
  },
);
PasswordInput.displayName = "PasswordInput";
