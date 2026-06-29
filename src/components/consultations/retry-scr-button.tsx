"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { retryScrByQuery } from "@/actions/scr";
import { Button } from "@/components/ui/button";

interface RetryScrButtonProps {
  queryId: string;
}

export function RetryScrButton({ queryId }: RetryScrButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  const retry = () => {
    setMsg(null);
    startTransition(async () => {
      const result = await retryScrByQuery(queryId);
      setMsg(result.message);
      // Autorizado: a query já foi concluída — refresh mostra o resultado.
      router.refresh();
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button onClick={retry} disabled={isPending}>
        {isPending ? "Verificando..." : "Tentar novamente"}
      </Button>
      {msg && <span className="text-sm text-muted-foreground">{msg}</span>}
    </div>
  );
}
