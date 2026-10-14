"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { endSupportSession } from "@/actions/support";
import { Button } from "@/components/ui/button";

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
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-2 bg-amber-100 px-6 py-2 text-sm text-amber-900"
    >
      <span>
        Modo suporte: <strong>{bureauName}</strong>. Expira às {time}.
        {error && <span className="ml-2 text-destructive">{error}</span>}
      </span>
      <Button type="button" size="sm" variant="outline" onClick={onEnd} disabled={isPending}>
        {isPending ? "Encerrando..." : "Encerrar suporte"}
      </Button>
    </div>
  );
}
