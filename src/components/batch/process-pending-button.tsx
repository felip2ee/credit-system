"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";

import { processCompanyMember } from "@/actions/company";
import { Button } from "@/components/ui/button";

interface Props {
  // Ids das consultas ainda 'processing' (na fila, não consultadas).
  queryIds: string[];
}

export function ProcessPendingButton({ queryIds }: Props) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const run = async () => {
    setRunning(true);
    setProgress(null);
    try {
      for (let i = 0; i < queryIds.length; i++) {
        setProgress({ done: i, total: queryIds.length });
        // O e-mail do titular vem de queries.scr_email (gravado na criação).
        await processCompanyMember(queryIds[i], true);
      }
      router.refresh();
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-300 bg-amber-50 p-3">
      <p className="text-sm text-amber-900">
        {queryIds.length} consulta(s) ainda não processada(s).
      </p>
      <Button size="sm" onClick={run} disabled={running}>
        <Play className="h-4 w-4" />
        {running
          ? progress
            ? `Processando ${progress.done + 1} de ${progress.total}...`
            : "Processando..."
          : "Continuar processamento"}
      </Button>
    </div>
  );
}
