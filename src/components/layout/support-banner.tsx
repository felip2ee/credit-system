"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { endSupportSession } from "@/actions/support";
import { Button } from "@/components/ui/button";
import { StatusBanner } from "@/components/ui/status-banner";

export function SupportBanner({
  bureauName,
  expiresAt,
}: {
  bureauName: string;
  expiresAt: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onEnd = () => {
    setError(null);
    startTransition(async () => {
      const result = await endSupportSession();
      if (result.error) setError(result.error);
      else router.push("/superadmin");
    });
  };

  const time = new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  }).format(new Date(expiresAt));

  return (
    <StatusBanner
      tone="attention"
      className="rounded-none border-x-0 border-t-0"
      title={`Modo suporte: ${bureauName}`}
      description={
        <>
          Expira às {time}.
          {error && <span className="ml-2 font-bold">{error}</span>}
        </>
      }
      action={
        <Button type="button" size="sm" variant="outline" onClick={onEnd} disabled={isPending}>
          {isPending ? "Encerrando..." : "Encerrar suporte"}
        </Button>
      }
    />
  );
}
