"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Briefcase } from "lucide-react";

import { createOpportunityFromQuery } from "@/actions/opportunities";
import { Button } from "@/components/ui/button";

interface Props {
  queryId: string;
  variant?: "default" | "outline" | "secondary";
  size?: "default" | "sm";
}

export function OpenOpportunityButton({
  queryId,
  variant = "default",
  size = "sm",
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const open = () => {
    setError(null);
    startTransition(async () => {
      const res = await createOpportunityFromQuery(queryId);
      if (res.error || !res.id) {
        setError(res.error ?? "Falha ao abrir a oportunidade.");
        return;
      }
      router.push(`/opportunities/${res.id}`);
    });
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <Button variant={variant} size={size} onClick={open} disabled={isPending}>
        <Briefcase className="h-4 w-4" />
        {isPending ? "Abrindo..." : "Abrir oportunidade"}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
