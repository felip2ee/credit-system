import * as React from "react";

import { cn } from "@/lib/utils";

import { Label } from "./label";

interface FieldProps {
  id: string;
  label: string;
  helper?: string;
  error?: string | null;
  className?: string;
  // Recebe os atributos de acessibilidade (id, aria-describedby, aria-invalid) para o campo.
  children: (a11y: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => React.ReactNode;
}

// Rótulo sempre visível acima do campo, texto de ajuda e erro ligados ao campo por aria-describedby.
export function Field({ id, label, helper, error, className, children }: FieldProps) {
  const helperId = helper ? `${id}-helper` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, helperId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {helper && (
        <p id={helperId} className="text-sm text-muted-foreground">
          {helper}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-sm font-bold text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
