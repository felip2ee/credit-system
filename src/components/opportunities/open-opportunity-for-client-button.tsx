"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";

import { createOpportunityForClient } from "@/actions/opportunities";
import { Button } from "@/components/ui/button";

export function OpenOpportunityForClientButton({
  clientId,
}: {
  clientId: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const open = () => {
    setError(null);
    startTransition(async () => {
      const res = await createOpportunityForClient(clientId);
      if (res.error || !res.id) {
        setError(res.error ?? "Falha ao abrir a oportunidade.");
        return;
      }
      router.push(`/opportunities/${res.id}`);
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" size="sm" onClick={open} disabled={isPending}>
        <Plus className="h-4 w-4" />
        {isPending ? "Abrindo..." : "Abrir oportunidade"}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
