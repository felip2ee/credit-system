"use client";

import { Copy } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

type CopyState = "idle" | "copied" | "failed";

const MESSAGES: Record<CopyState, string> = {
  idle: "",
  copied: "Código copiado. Cole no app do seu banco.",
  failed: "Não foi possível copiar. Selecione o código no campo acima e copie.",
};

// Copia só no clique. O campo somente leitura continua na página como alternativa.
export function CopyPixButton({ code }: { code: string }) {
  const [state, setState] = useState<CopyState>("idle");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setState("copied");
    } catch {
      setState("failed");
    }
  };

  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" onClick={copy}>
        <Copy aria-hidden />
        Copiar código Pix
      </Button>
      <p role="status" className="text-sm text-muted-foreground">
        {MESSAGES[state]}
      </p>
    </div>
  );
}
