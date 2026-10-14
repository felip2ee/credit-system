"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input, type InputProps } from "@/components/ui/input";

export const PasswordInput = React.forwardRef<
  HTMLInputElement,
  Omit<InputProps, "type">
>((props, ref) => {
  const [visible, setVisible] = React.useState(false);
  return (
    <div className="flex gap-2">
      <Input
        autoComplete="new-password"
        {...props}
        ref={ref}
        type={visible ? "text" : "password"}
      />
      <Button
        type="button"
        variant="outline"
        aria-pressed={visible}
        aria-label={visible ? "Ocultar senha" : "Mostrar senha"}
        onClick={() => setVisible((v) => !v)}
      >
        {visible ? "Ocultar" : "Mostrar"}
      </Button>
    </div>
  );
});
PasswordInput.displayName = "PasswordInput";
